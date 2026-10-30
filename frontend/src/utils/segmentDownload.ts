/**
 * 分段视频合并下载工具。
 *
 * 用于修复「只能下载单个切片」的问题：当解析结果携带 `segments`（多分片直链）
 * 或 URL 为 HLS 清单时，将 N 个分片依次拉取并拼接为完整视频后下载。
 *
 * 设计要点：
 * - 每段独立请求，记录每段已收字节与总字节，向外部汇报整体进度；
 * - 全部收齐后才拼接并触发下载，避免「只下到第一片」；
 * - 支持 HLS BYTERANGE 清单（fMP4：EXT-X-MAP 初始化段 + 分片字节区间），
 *   按区间用 Range 头精确抓取，避免把分片文件的头部字节混进合并结果；
 * - 支持 AbortSignal 取消；
 * - 提供按分片打包为 ZIP 的能力（配合 JSZip）。
 */

import { mediaCredentials } from "../downloads/file";
import { sourceUrl } from "./mediaContract";

/** 带可选字节区间的分片描述（HLS BYTERANGE / 普通整文件分片通用） */
export interface HlsSegment {
  url: string;
  /** Range 起始字节（含）；缺省表示整个文件 */
  start?: number;
  /** 区间字节数；与 start 同时存在时按 Range 抓取 */
  length?: number;
}

export interface SegmentProgress {
  loaded: number;
  total: number;
  percent: number;
  /** 当前正在下载的分片序号（1 起始） */
  segment: number;
  segmentCount: number;
}

export interface MergeOptions {
  signal?: AbortSignal;
  filename: string;
  onProgress?: (progress: SegmentProgress) => void;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 延迟回收，确保下载已开始
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 字节区间 → Range 头值；无区间返回 undefined */
function rangeHeader(segment: HlsSegment): string | undefined {
  if (segment.start === undefined || segment.length === undefined)
    return undefined;
  return `bytes=${segment.start}-${segment.start + segment.length - 1}`;
}

/** 分片声明的字节数（BYTERANGE 时可直接算出，用于总进度） */
function segmentLength(segment: HlsSegment): number {
  return segment.length ?? 0;
}

/** 单分片抓取，失败自动重试（默认 2 次，间隔 400ms/800ms）：
 * 快手等 CDN 分片 CORS 头会随节点/请求漂移，瞬时失败重试可显著提高合并成功率 */
async function fetchArrayBuffer(
  url: string,
  signal: AbortSignal | undefined,
  onChunk?: (loaded: number, total: number) => void,
  range?: { start: number; length: number },
  retries = 2,
): Promise<ArrayBuffer> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const headers: Record<string, string> = {};
      if (range)
        headers.Range = `bytes=${range.start}-${range.start + range.length - 1}`;
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        headers,
        signal,
      });
      if (!response.ok)
        throw new Error(`分片请求失败（HTTP ${response.status}）`);
      if (
        /text\/html|application\/json/i.test(
          response.headers.get("content-type") || "",
        )
      ) {
        void response.body?.cancel();
        throw new Error("分片地址返回了错误页面");
      }
      if (range) {
        const declared = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(
          response.headers.get("content-range") || "",
        );
        if (
          response.status !== 206 ||
          !declared ||
          Number(declared[1]) !== range.start ||
          Number(declared[2]) !== range.start + range.length - 1
        ) {
          void response.body?.cancel();
          throw new Error("分片服务器没有返回请求的字节范围");
        }
      }
      if (!response.body) throw new Error("该分片不支持流式读取");

      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onChunk?.(loaded, total);
      }
      if (!loaded || (range && loaded !== range.length))
        throw new Error("分片字节范围不完整");
      // 有 content-length 时校验完整性
      if (total > 0 && loaded !== total) {
        throw new Error(
          `分片下载不完整：期望 ${total} 字节，实际 ${loaded} 字节`,
        );
      }
      // 拼接为连续 ArrayBuffer
      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return merged.buffer;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
      lastError = error;
      if (attempt < retries) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, 400 * (attempt + 1)),
        );
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("分片下载失败");
}

/** 解析 BYTERANGE 值 `len[@offset]`；offset 缺省时延续上一区间末尾（RFC 8216） */
function parseByteRange(
  value: string,
  previousEndExclusive: number | null,
): { start: number; length: number } | null {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const length = Number(match[1]);
  const start =
    match[2] !== undefined ? Number(match[2]) : (previousEndExclusive ?? 0);
  return Number.isSafeInteger(start) &&
    start >= 0 &&
    Number.isSafeInteger(length) &&
    length > 0
    ? { start, length }
    : null;
}

/** Read only an explicitly declared, complete single-rendition HLS VOD.
 * Adaptive masters, external audio, encryption and discontinuities need a
 * processing executor; they cannot be silently flattened into a complete file.
 */
export async function resolveHlsSegments(
  url: string,
  signal?: AbortSignal,
): Promise<HlsSegment[] | null> {
  try {
    const response = await fetch(url, {
      mode: "cors",
      signal,
      credentials: mediaCredentials(url),
      referrerPolicy: "no-referrer",
    });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "",
      size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 2 * 1024 * 1024) return null;
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (
      !text.trimStart().startsWith("#EXTM3U") ||
      !text.includes("#EXT-X-ENDLIST") ||
      /#EXT-X-STREAM-INF|#EXT-X-MEDIA:|#EXT-X-KEY|#EXT-X-DISCONTINUITY/.test(
        text,
      )
    )
      return null;
    const toAbsolute = (uri: string) =>
      sourceUrl({ url: new URL(uri, url).href });
    const segments: HlsSegment[] = [];
    let previousEnd: number | null = null,
      previousUrl = "";
    let pending: string | null = null;
    for (const line of text.split(/\r?\n/).map((value) => value.trim())) {
      if (!line) continue;
      if (line.startsWith("#EXT-X-MAP:")) {
        const uri = /URI="([^"]+)"/.exec(line)?.[1];
        if (!uri || segments.length) return null;
        const rawRange = /BYTERANGE="([^"]+)"/.exec(line)?.[1];
        const range = rawRange ? parseByteRange(rawRange, null) : null;
        if (rawRange && !range) return null;
        segments.push({ url: toAbsolute(uri), ...(range || {}) });
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        if (pending) return null;
        pending = line.slice("#EXT-X-BYTERANGE:".length);
      } else if (!line.startsWith("#")) {
        const absolute = toAbsolute(line);
        if (
          pending &&
          !pending.includes("@") &&
          (previousEnd === null || absolute !== previousUrl)
        )
          return null;
        const range: { start: number; length: number } | null = pending
          ? parseByteRange(pending, previousEnd)
          : null;
        if (pending && !range) return null;
        segments.push({ url: absolute, ...(range || {}) });
        previousEnd = range ? range.start + range.length : null;
        previousUrl = absolute;
        pending = null;
        if (segments.length > 2000) return null;
      }
    }
    return segments.length && !pending ? segments : null;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return null;
  }
}

/** 归一化：字符串分片 → 整文件 HlsSegment */
function normalizeSegments(segments: (HlsSegment | string)[]): HlsSegment[] {
  return segments
    .map((s) => (typeof s === "string" ? ({ url: s } as HlsSegment) : s))
    .filter((s) => Boolean(s.url));
}

/**
 * 合并分片为单个连续 Uint8Array（不触发下载）。
 * 用于「分片合并为单文件」与「多集打包进 ZIP」两种场景。
 * @returns 合并后的视频字节
 */
export async function mergeSegments(
  segments: (HlsSegment | string)[],
  options?: {
    signal?: AbortSignal;
    onProgress?: (progress: SegmentProgress) => void;
  },
): Promise<Uint8Array<ArrayBuffer>> {
  const usable = normalizeSegments(segments);
  if (usable.length === 0) throw new Error("没有可用的分片");

  const { signal, onProgress } = options || {};
  const buffers: ArrayBuffer[] = [];
  let totalLoaded = 0;
  // BYTERANGE 分片的总字节数可直接得出；整文件分片用 HEAD 探测
  let totalBytes = usable.every((s) => s.length !== undefined)
    ? usable.reduce((sum, s) => sum + segmentLength(s), 0)
    : 0;
  if (totalBytes === 0) {
    try {
      const heads = await Promise.all(
        usable.map((u) =>
          fetch(u.url, { method: "HEAD", mode: "cors", signal }).then((r) => ({
            len: Number(r.headers.get("content-length")) || 0,
            ok: r.ok,
          })),
        ),
      );
      if (heads.every((h) => h.ok)) {
        totalBytes = heads.reduce((sum, h) => sum + h.len, 0);
      }
    } catch {
      totalBytes = 0;
    }
  }

  for (let i = 0; i < usable.length; i++) {
    const segment = usable[i];
    const buf = await fetchArrayBuffer(
      segment.url,
      signal,
      (loaded, total) => {
        const segTotal = totalBytes > 0 ? totalBytes : total * usable.length;
        onProgress?.({
          loaded:
            totalBytes > 0
              ? totalLoaded + loaded
              : ((i + loaded / (total || 1)) / usable.length) *
                (totalBytes || 1),
          total: totalBytes || segTotal,
          percent:
            totalBytes > 0
              ? Math.round(((totalLoaded + loaded) / totalBytes) * 100)
              : Math.round(((i + loaded / (total || 1)) / usable.length) * 100),
          segment: i + 1,
          segmentCount: usable.length,
        });
      },
      segment.start !== undefined && segment.length !== undefined
        ? { start: segment.start, length: segment.length }
        : undefined,
    );
    buffers.push(buf);
    totalLoaded += buf.byteLength;
    onProgress?.({
      loaded: totalLoaded,
      total: totalBytes || totalLoaded,
      percent:
        totalBytes > 0
          ? Math.round((totalLoaded / totalBytes) * 100)
          : Math.round(((i + 1) / usable.length) * 100),
      segment: i + 1,
      segmentCount: usable.length,
    });
  }

  const merged = new Uint8Array(totalLoaded);
  let offset = 0;
  for (const buf of buffers) {
    merged.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return merged;
}

/**
 * 合并分片并下载为单个文件。
 * @param segments 分片列表（按播放顺序，支持 BYTERANGE 区间）
 * @returns 下载是否成功触发
 */
export async function mergeAndDownload(
  segments: (HlsSegment | string)[],
  options: MergeOptions,
): Promise<boolean> {
  const { signal, filename } = options;
  const merged = await mergeSegments(segments, {
    signal,
    onProgress: options.onProgress,
  });
  triggerDownload(new Blob([merged]), filename);
  return true;
}

/** 把分片列表打包为 ZIP（依赖调用方传入的 zip 工厂） */
export async function appendSegmentsToZip(
  zip: { file: (name: string, data: Uint8Array | ArrayBuffer) => void },
  segments: (HlsSegment | string)[],
  baseName: string,
  signal?: AbortSignal,
): Promise<void> {
  const usable = normalizeSegments(segments);
  for (let i = 0; i < usable.length; i++) {
    const segment = usable[i];
    const buf = await fetchArrayBuffer(
      segment.url,
      signal,
      undefined,
      segment.start !== undefined && segment.length !== undefined
        ? { start: segment.start, length: segment.length }
        : undefined,
    );
    const ext = /\.([a-z0-9]+)(\?|$)/i.exec(segment.url)?.[1] || "mp4";
    zip.file(`${baseName}_part${String(i + 1).padStart(2, "0")}.${ext}`, buf);
  }
}
