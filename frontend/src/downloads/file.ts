/** Shared rules for complete media files; neither manifests nor error pages are downloads. */
const mediaExtensions: Record<string, readonly string[]> = {
  "video/mp4": ["mp4", "m4v"],
  "video/webm": ["webm"],
  "video/quicktime": ["mov"],
  "video/x-matroska": ["mkv"],
  "video/mp2t": ["ts"],
  "audio/mpeg": ["mp3"],
  "audio/mp4": ["m4a", "mp4"],
  "audio/aac": ["aac"],
  "audio/ogg": ["ogg", "opus"],
  "audio/opus": ["opus"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/flac": ["flac"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif"],
};

export const mimeType = (value: string | null): string => (value || "").split(";", 1)[0].trim().toLowerCase();
export const extensionOf = (name: string): string => /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() || "";
export const extensionsFor = (type: string): readonly string[] => mediaExtensions[mimeType(type)] || [];

export function mediaUrl(value: string): string {
  if (!/^https?:\/\//i.test(value) && !/^\/(?!\/)/.test(value)) throw new Error("资源地址必须是 HTTP(S) 完整文件链接");
  const url = new URL(value, typeof location === "undefined" ? "https://dokitool.invalid/" : location.href);
  if (url.username || url.password || /\.(?:m3u8|mpd)(?:$|\/)/i.test(url.pathname)) {
    throw new Error("该地址不是可直接下载的完整媒体文件");
  }
  return url.href;
}

/** Retain the site's own access cookies, never send site credentials to a CDN. */
export function mediaCredentials(url: string): RequestCredentials {
  return typeof location !== "undefined" && new URL(url, location.href).origin === new URL(location.href).origin
    ? "same-origin" : "omit";
}

/** Native filenames cannot be repaired: the remote server, not this page, chooses them. */
export function isSafeFilename(name: string): boolean {
  return name.length > 0 && name.length <= 180 && name === name.trim()
    && !/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name)
    && !/^[. ]|[. ]$/.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

export function mediaFilename(filename: string, type: string): string {
  const known = extensionsFor(type);
  const extension = extensionOf(filename);
  const generic = !type || /^(?:application|binary)\/octet-stream$/.test(mimeType(type));
  if (!known.length && !(generic && Object.values(mediaExtensions).some(values => values.includes(extension)))) {
    throw new Error("资源返回的类型不是可下载的音视频或图片");
  }
  const suffix = known.includes(extension) || !known.length ? extension : known[0];
  const base = filename.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/^[. ]+|[. ]+$/g, "").slice(0, 120);
  const safeBase = base && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? base : "media";
  return `${safeBase}.${suffix}`;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
}

/** Bound a single network wait, without counting time spent waiting on the consumer. */
export async function networkWait<T>(operation: Promise<T>, controller: AbortController, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException("Aborted", "AbortError"));
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
    timer = setTimeout(() => controller.abort(new Error(`资源超过 ${timeoutMs / 1000} 秒没有返回数据`)), timeoutMs);
    if (controller.signal.aborted) rejectAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally {
    clearTimeout(timer!);
    controller.signal.removeEventListener("abort", rejectAbort!);
  }
}
