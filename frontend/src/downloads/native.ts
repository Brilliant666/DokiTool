import type { DownloadRequest } from "./types";
import { extensionOf, extensionsFor, isSafeFilename, mediaCredentials, mediaUrl, mimeType, networkWait, throwIfAborted } from "./file";

const PROBE_TIMEOUT_MS = 3000;

function attachmentFilename(value: string | null): string | null {
  if (!value || !/^attachment(?:\s*;|\s*$)/i.test(value)) return null;
  if ((value.match(/(?:^|;)\s*filename\*\s*=/gi)?.length || 0) > 1 || (value.match(/(?:^|;)\s*filename\s*=/gi)?.length || 0) > 1) return null;
  const encoded = /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;\s]*))(?=\s*(?:;|$))/i.exec(value);
  if (encoded) {
    const parts = /^utf-8'[^']*'(.*)$/i.exec(encoded[1] ?? encoded[2]);
    if (!parts) return null;
    try { return decodeURIComponent(parts[1]); } catch { return null; }
  }
  if (/(?:^|;)\s*filename\*\s*=/i.test(value)) return null;
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;"]*))(?=\s*(?:;|$))/i.exec(value);
  return plain ? plain[1] ?? plain[2].trim() : null;
}

/** One bounded GET checks the actual attachment headers, then immediately releases its body. */
export async function probeNative(request: DownloadRequest, signal: AbortSignal): Promise<{ url: string; filename: string } | null> {
  throwIfAborted(signal);
  const url = mediaUrl(request.url);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  let response: Response | undefined;
  try {
    response = await networkWait(fetch(url, { method: "GET", mode: "cors", credentials: mediaCredentials(url), referrerPolicy: "no-referrer", signal: controller.signal }), controller, PROBE_TIMEOUT_MS);
    throwIfAborted(signal);
    if (response.status !== 200 || response.type === "opaque" || response.headers.has("content-range") || response.headers.get("content-length") === "0") return null;
    const filename = attachmentFilename(response.headers.get("content-disposition"));
    const type = mimeType(response.headers.get("content-type"));
    if (!filename || !isSafeFilename(filename) || !extensionsFor(type).includes(extensionOf(filename))) return null;
    return { url: mediaUrl(response.url || url), filename };
  } catch {
    throwIfAborted(signal);
    // A hidden header, blocked probe or short timeout is unknown eligibility, never proof of a native attachment.
    return null;
  } finally {
    controller.abort();
    void response?.body?.cancel().catch(() => {});
    signal.removeEventListener("abort", abort);
  }
}

/** Explicit user handoff. Cross-origin URLs may open a player; completion is unknowable here. */
export function openSource(url: string, filename: string, newTab = true): void {
  const href = url.startsWith("blob:") ? url : mediaUrl(url);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.referrerPolicy = "no-referrer";
  if (newTab) { anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Eligibility was confirmed before this asynchronous handoff. Avoid popup
 * blockers and isolate an upstream response that changes after the probe.
 * Completion cannot be observed; retain the frame until document teardown. */
export function handoffNative(url: string, _filename: string): void {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  frame.title = "文件下载";
  frame.setAttribute("sandbox", "allow-downloads");
  frame.referrerPolicy = "no-referrer";
  frame.src = mediaUrl(url);
  document.body.appendChild(frame);
}
