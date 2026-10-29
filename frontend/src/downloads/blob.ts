import type { DownloadObserver, DownloadRequest, DownloadSnapshot } from "./types";
import { mediaCredentials, mediaFilename, mediaUrl, mimeType, networkWait, throwIfAborted } from "./file";
import { openSource } from "./native";

export const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 30000;
let queue: Promise<void> = Promise.resolve();

class BlobLimitError extends Error {}

/** One page-side Blob at a time; a cancelled waiter must never retain the queue. */
async function acquire(signal: AbortSignal): Promise<() => void> {
  throwIfAborted(signal);
  const previous = queue;
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  queue = previous.then(() => current);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { await Promise.race([previous, cancelled]); throwIfAborted(signal); return release; }
  catch (error) { release(); throw error; }
  finally { signal.removeEventListener("abort", abort); }
}

/** Bounded compatibility transport. The coordinator alone decides whether fallback is safe. */
export async function downloadBlob(request: DownloadRequest, signal: AbortSignal, onUpdate: DownloadObserver): Promise<DownloadSnapshot> {
  const startedAt = Date.now();
  let snapshot: DownloadSnapshot = { id: request.id, transport: "browser_blob", status: "queued", filename: request.filename, url: request.url, loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0 };
  const publish = (patch: Partial<DownloadSnapshot>) => { snapshot = { ...snapshot, ...patch, elapsed: (Date.now() - startedAt) / 1000 }; onUpdate({ ...snapshot }); };
  publish({});
  let release: (() => void) | undefined;
  try {
    release = await acquire(signal);
    const routes = [...new Set([request.url, ...request.routes])].slice(0, 3);
    let failure: unknown = new Error("没有可用的下载线路");
    for (const route of routes) {
      throwIfAborted(signal);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let response: Response | undefined;
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      try {
        const url = mediaUrl(route);
        publish({ status: "preparing", url, loaded: 0, total: 0, speed: 0, averageSpeed: 0, error: undefined });
        response = await networkWait(fetch(url, { method: "GET", mode: "cors", credentials: mediaCredentials(url), referrerPolicy: "no-referrer", signal: controller.signal }), controller, IDLE_TIMEOUT_MS);
        throwIfAborted(signal);
        if (response.status !== 200 || response.type === "opaque" || !response.body) throw new Error(`资源请求失败（HTTP ${response.status}）`);
        const total = Number(response.headers.get("content-length"));
        if (!Number.isSafeInteger(total) || total <= 0) throw new BlobLimitError("资源大小未知，不能自动使用内存下载；请交给浏览器处理");
        if (total > MAX_BLOB_BYTES) throw new BlobLimitError("文件超过 64 MiB，不能使用内存下载；请交给浏览器处理");
        // Encoded lengths describe wire bytes, but Fetch exposes decoded bytes; do not guess a bound.
        const encoding = response.headers.get("content-encoding")?.toLowerCase();
        if (encoding && encoding !== "identity") throw new BlobLimitError("资源使用压缩传输，无法确认内存下载大小");
        const type = mimeType(response.headers.get("content-type"));
        const filename = mediaFilename(request.filename, type);
        reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let loaded = 0, sampleBytes = 0, sampleTime = Date.now();
        publish({ status: "downloading", filename, total });
        progressTimer = setInterval(() => {
          const now = Date.now();
          publish({ loaded, speed: (loaded - sampleBytes) / Math.max((now - sampleTime) / 1000, 0.001), averageSpeed: loaded / Math.max((now - startedAt) / 1000, 0.001) });
          sampleBytes = loaded; sampleTime = now;
        }, 500);
        while (true) {
          const { done, value } = await networkWait(reader.read(), controller, IDLE_TIMEOUT_MS);
          throwIfAborted(signal);
          if (done) break;
          loaded += value.byteLength;
          if (loaded > MAX_BLOB_BYTES) throw new BlobLimitError("下载超过 64 MiB 内存上限，已停止接收");
          if (loaded > total) throw new Error("下载内容超过声明大小，文件不完整或响应异常");
          chunks.push(value.slice().buffer as ArrayBuffer);
        }
        if (!loaded || loaded !== total) throw new Error(`下载不完整：期望 ${total} 字节，实际 ${loaded} 字节`);
        throwIfAborted(signal);
        const objectUrl = URL.createObjectURL(new Blob(chunks, { type: type || "application/octet-stream" }));
        try { openSource(objectUrl, filename, false); }
        finally { setTimeout(() => URL.revokeObjectURL(objectUrl), 4000); }
        publish({ status: "completed", loaded, total, speed: 0, averageSpeed: loaded / Math.max((Date.now() - startedAt) / 1000, 0.001) });
        return snapshot;
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof BlobLimitError) throw error;
        failure = error;
      } finally {
        clearInterval(progressTimer);
        controller.abort();
        void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
        signal.removeEventListener("abort", abort);
      }
    }
    throw failure;
  } catch (error) {
    publish({ status: signal.aborted ? "cancelled" : "failed", speed: 0, error: signal.aborted ? undefined : error instanceof Error ? error.message : "下载失败" });
    throw error;
  } finally { release?.(); }
}
