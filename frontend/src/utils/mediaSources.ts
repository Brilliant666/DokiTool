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
