import { probeNative, handoffNative } from "./native";
import { downloadBlob } from "./blob";
import { downloadStreaming } from "./streaming";
import { StreamingUnavailableError, type DownloadObserver, type DownloadRequest, type DownloadSnapshot } from "./types";

const transports = { probeNative, handoffNative, downloadStreaming, downloadBlob };
type Transports = typeof transports;

/** The queue bounds preparation as well as transfers. The Worker also bounds
 * transfers across tabs; Blob has its own stricter, one-at-a-time memory budget. */
export function createDownloadManager(implementations: Transports = transports) {
  let active = 0;
  const waiting: (() => void)[] = [];

  async function acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = waiting.indexOf(start);
        if (index >= 0) waiting.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const start = () => {
        signal.removeEventListener("abort", abort);
        active++;
        resolve();
      };
      if (active < 2) start();
      else { waiting.push(start); signal.addEventListener("abort", abort, { once: true }); }
    });
    return () => { active--; waiting.shift()?.(); };
  }

  async function run(request: DownloadRequest, signal: AbortSignal, observe: DownloadObserver): Promise<DownloadSnapshot> {
    let snapshot: DownloadSnapshot = {
      id: request.id, transport: "browser_streaming", status: "queued",
      filename: request.filename, url: request.url,
      loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0,
    };
    const publish: DownloadObserver = next => { snapshot = next; observe(next); };
    publish(snapshot);
    let release: (() => void) | undefined;
    try {
      release = await acquire(signal);
      signal.throwIfAborted();
      publish({ ...snapshot, status: "preparing" });
      const attachment = await implementations.probeNative(request, signal);
      signal.throwIfAborted();
      if (attachment) {
        implementations.handoffNative(attachment.url, attachment.filename);
        const result: DownloadSnapshot = { ...snapshot, ...attachment, transport: "browser_native", status: "handed-off" };
        publish(result);
        return result;
      }
      try {
        return await implementations.downloadStreaming(request, signal, publish);
      } catch (error) {
        if (error instanceof Error && error.name === "StreamingStateUnknownError") throw error;
        signal.throwIfAborted();
        // A failed source, a lost START acknowledgement or an interrupted stream
        // is never permission to create a second download behind the user's back.
        if (!(error instanceof StreamingUnavailableError)) throw error;
        return await implementations.downloadBlob(request, signal, publish);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "StreamingStateUnknownError") throw error;
      const cancelled = signal.aborted || error instanceof Error && error.name === "AbortError";
      publish({ ...snapshot, speed: 0, status: cancelled ? "cancelled" : "failed",
        error: cancelled ? undefined : error instanceof Error ? error.message : "下载失败" });
      throw error;
    } finally { release?.(); }
  }

  return { run };
}

export const downloadManager = createDownloadManager();
