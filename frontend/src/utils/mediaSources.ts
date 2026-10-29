import type { VideoBackup } from '../types/media';

/** Structural input accepts a whole result or the currently selected episode. */
export interface MediaSourceInput {
  url?: unknown;
  video_backup?: unknown;
  [key: string]: unknown;
}

export interface MediaSourceGroup {
  key: string;
  sources: VideoBackup[];
}

const positive = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const codecName = (value: unknown): string => {
  const codec = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['hevc', 'h265', 'h.265', 'hev1', 'hvc1'].includes(codec)) return 'hevc';
  if (['h264', 'h.264', 'avc', 'avc1'].includes(codec)) return 'h264';
  return codec;
};

/** Preserve delivery/provenance metadata while deduplicating actual URLs. */
export function getMediaSources(media: MediaSourceInput | null | undefined): VideoBackup[] {
  if (!media) return [];
  const { video_backup, ...primary } = media;
  const candidates = [primary, ...(Array.isArray(video_backup) ? video_backup : [])];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const raw = typeof candidate === 'string' ? { url: candidate } : candidate;
    if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string') return [];
    const url = raw.url.trim();
    if (!url || seen.has(url)) return [];
    seen.add(url);
    const bitrate = positive(raw.bit_rate) ?? positive(raw.bitrate);
    return [{
      ...raw, url,
      width: positive(raw.width), height: positive(raw.height),
      codec: codecName(raw.codec), bit_rate: bitrate, bitrate,
    } as VideoBackup];
  });
}

function qualityKey(source: VideoBackup): string | null {
  // A label such as "original", "2160p" or "unknown" is not a stream identity.
  if (String(source.quality || '').toLowerCase() === 'unknown') return null;
  const { width, height, codec, bit_rate } = source;
  if (width && height && codec && bit_rate) return JSON.stringify(['format', width, height, codec, bit_rate]);
  // Only explicit upstream IDs qualify; a human-readable gear/quality label does not.
  const gear = source.gear_id ?? source.gearId;
  if ((typeof gear === 'string' && gear.trim()) || (typeof gear === 'number' && Number.isFinite(gear))) {
    return JSON.stringify(['gear', String(gear), width ?? null, height ?? null, codec || null, bit_rate ?? null]);
  }
  return null;
}

export function groupMediaSources(media: MediaSourceInput | null | undefined): MediaSourceGroup[] {
  const groups = new Map<string, MediaSourceGroup>();
  for (const source of getMediaSources(media)) {
    const key = qualityKey(source) ?? JSON.stringify(['url', source.url]);
    const group = groups.get(key);
    if (group) group.sources.push(source);
    else groups.set(key, { key, sources: [source] });
  }
  return [...groups.values()];
}

/** Selected URL first. Unknown quality and unrecognised selections never downgrade. */
export function getSameQualityUrls(media: MediaSourceInput | null | undefined, selectedUrl: string): string[] {
  if (!selectedUrl) return [];
  const group = groupMediaSources(media).find(({ sources }) => sources.some(source => source.url === selectedUrl));
  if (!group) return [selectedUrl];
  return [selectedUrl, ...group.sources.map(source => source.url).filter(url => url !== selectedUrl)];
}

/** An original endpoint is provenance, not a promise of the highest quality. */
export function isHighestOriginalSource(source: VideoBackup, candidates: VideoBackup[]): boolean {
  if (source.is_original !== true || source.metadata_source !== 'mp4') return false;
  const width = positive(source.width), height = positive(source.height);
  const bitrate = positive(source.bit_rate ?? source.bitrate);
  if (!width || !height || !bitrate) return false;
  const pixels = width * height;
  return !candidates.some(candidate => {
    const otherPixels = (positive(candidate.width) ?? 0) * (positive(candidate.height) ?? 0);
    return otherPixels > pixels || (otherPixels === pixels &&
      (positive(candidate.bit_rate ?? candidate.bitrate) ?? 0) > bitrate);
  });
}

export function mediaSourceQuality(source: VideoBackup | undefined, candidates: VideoBackup[], locale = 'zh-CN'): string {
  const unknown = locale === 'en' ? 'Unknown quality' : '画质未知';
  if (!source) return unknown;
  if (isHighestOriginalSource(source, candidates)) return locale === 'en' ? 'Original' : '原画';
  const quality = typeof source.quality === 'string' && source.quality.trim()
    ? source.quality.trim() : typeof source.label === 'string' ? source.label.trim() : '';
  // Never revive an unverified "original" label as an original-quality claim.
  if (quality && !['original', 'unknown'].includes(quality.toLowerCase())) return quality;
  const width = positive(source.width), height = positive(source.height);
  return width && height ? `${Math.min(width, height)}p` : unknown;
}

/** Use this route's byte count, never a primary URL's size_label or an estimate. */
export function formatMediaSize(size: unknown, locale = 'zh-CN'): string {
  const bytes = (typeof size === 'number' || (typeof size === 'string' && size.trim())) ? Number(size) : NaN;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return locale === 'en' ? 'Size unknown' : '大小未知';
  if (bytes < 100000) return '<0.1 MB';
  return `${(bytes / 1000000).toFixed(1)} MB`;
}
