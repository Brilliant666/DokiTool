import type { MediaVideo, VideoBackup } from '../types/media';

/** Keep the previous source available when switching an episode's playable URL. */
export function selectMediaSource(video: MediaVideo, source: VideoBackup): MediaVideo {
  const previous: VideoBackup = {
    url: video.url,
    quality: video.quality,
    width: video.width as number | undefined,
    height: video.height as number | undefined,
    bit_rate: video.bit_rate ?? video.bitrate,
    codec: video.codec,
  };
  const candidates = [...((video.video_backup as VideoBackup[] | undefined) ?? []), previous];
  const video_backup = candidates.filter((item, index) => item.url && candidates.findIndex((other) => other.url === item.url) === index);
  return {
    ...video,
    url: source.url,
    quality: source.quality,
    width: source.width,
    height: source.height,
    bit_rate: source.bit_rate ?? source.bitrate,
    bitrate: source.bit_rate ?? source.bitrate,
    codec: source.codec,
    video_backup,
  };
}
