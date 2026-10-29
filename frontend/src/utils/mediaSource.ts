import type { MediaVideo, VideoBackup } from '../types/media';

const sourceDetails = (source: MediaVideo | VideoBackup) => ({
  quality: source.quality,
  width: source.width,
  height: source.height,
  bit_rate: source.bit_rate ?? source.bitrate,
  bitrate: source.bit_rate ?? source.bitrate,
  codec: source.codec,
  original_url: typeof source.original_url === 'string' ? source.original_url : undefined,
  playback_url: typeof source.playback_url === 'string' ? source.playback_url : undefined,
  media_delivery: source.media_delivery === 'weibo-relay' ? 'weibo-relay' as const : undefined,
  is_original: source.is_original,
  metadata_source: source.metadata_source,
  size: source.size,
  gear_id: source.gear_id,
  gearId: source.gearId,
  segments: source.segments,
});

/** Keep the previous source available when switching an episode's playable URL. */
export function selectMediaSource(video: MediaVideo, source: VideoBackup): MediaVideo {
  const previous: VideoBackup = {
    ...sourceDetails(video),
    url: video.url,
  };
  const candidates = [...((video.video_backup as VideoBackup[] | undefined) ?? []), previous];
  const video_backup = candidates.filter((item, index) => item.url && candidates.findIndex((other) => other.url === item.url) === index);
  return {
    ...video,
    ...sourceDetails(source),
    url: source.url,
    duration: typeof source.duration === 'number' ? source.duration : video.duration,
    segments: Array.isArray(source.segments) ? source.segments as string[] : undefined,
    video_backup,
  };
}
