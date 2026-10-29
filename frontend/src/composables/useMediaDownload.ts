import { type Ref } from "vue";
import type { DownloadSnapshot } from "../downloads/types";
import type {
  LivePhoto,
  MediaVideo,
  MusicResource,
  ParsedMedia,
  ToastType,
  VideoBackup,
} from "../types/media";
import { getDownloadFilename } from "../utils/downloadFilename";
import { buildMediaFilename } from "../utils/videoFilename";
import { getMediaSources, getSameQualityUrls } from "../utils/mediaSources";
import { selectMediaSource } from "../utils/mediaSource";
import {
  detectSegmentContainer,
  mergeAndDownload,
  mergeSegments,
  prepareSegments,
  looksLikeHlsManifest,
  type HlsSegment,
} from "../utils/segmentDownload";
import { useVideoStore } from "../stores/video";
import type { VideoSelection } from "./useVideoSelection";

/** 懒解析回调返回的结构 */
interface ResolvedVideo {
  url: string;
  video_backup?: VideoBackup[];
  quality?: string;
  width?: number;
  height?: number;
  bit_rate?: number;
  codec?: string;
}

interface UseMediaDownloadOptions {
  videoStore: ReturnType<typeof useVideoStore>;
  currentVideoUrl: Ref<string>;
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  /** 可选的选集状态；用于批量下载与 downloadMainVideo 的源选择 */
  selection?: VideoSelection;
  /** B 站多 P 懒解析：根据 video._cid/index 返回真实直链；null 表示解析失败 */
  resolveVideoUrl?: (video: MediaVideo, signal?: AbortSignal) => Promise<ResolvedVideo | null>;
}

interface EnqueueOptions {
  /** 显式文件名（已可读）；缺省用 getDownloadFilename */
  filename?: string;
  /** 扩展名，默认 "mp4" */
  ext?: string;
  routes?: string[];
}

function triggerBrowserDownload(url: string, filename: string, newTab = false): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // 无 Referer 直连，降低 CDN 防盗链拒绝概率
  anchor.referrerPolicy = "no-referrer";
  if (newTab) {
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function useMediaDownload(options: UseMediaDownloadOptions) {
  const { videoStore, currentVideoUrl, showToast, selection, resolveVideoUrl } =
    options;

  const archiveRetries = new Map<number, () => Promise<void>>();
  const videoRetries = new Map<number, () => Promise<boolean>>();
  const sourceContexts = new Map<number, {
    routes: string[];
    resultVersion: number;
    selectedUrl: string;
    video?: MediaVideo;
  }>();
  const taskFor = (id: number) => videoStore.downloads.find((task) => task.id === id);
  const ownsTask = (id: number, controller: AbortController) => taskFor(id)?.abortController === controller;
  const checkAbort = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  const isMultiVideo = (data: ParsedMedia | null) => (data?.videos?.length ?? 0) > 1 || (data?.collections?.length ?? 0) > 0
    || ["collection", "collections", "season", "ugc_season"].includes(data?.type ?? "");
  const effectiveSelectedUrl = () => {
    const data = videoStore.resultData;
    return isMultiVideo(data)
      ? selection?.currentVideo.value?.url ?? data?.videos?.[selection?.selectedIndex.value ?? 0]?.url ?? ""
      : currentVideoUrl.value || data?.url || "";
  };

  /** Settle immediately on cancellation even if a resolver ignores its signal. */
  function abortable<T>(request: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return request;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal.aborted) { void request.catch(() => {}); onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      request.then(value => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort(); else resolve(value);
      }, error => { signal.removeEventListener("abort", onAbort); reject(error); });
    });
  }

  /** Timed updates continue during waits, so a stalled request never shows its old speed. */
  function monitorTransfer(id: number, controller: AbortController, startedAt = Date.now(), bytes = true) {
    let received = 0;
    let sampleBytes = 0;
    let sampleTime = startedAt;
    let lastReceivedAt = startedAt;
    let stopped = false;
    const publish = (finished = false) => {
      if (!ownsTask(id, controller)) return;
      const now = Date.now();
      const elapsed = Math.max(0, (now - startedAt) / 1000);
      const sampleElapsed = Math.max(0.001, (now - sampleTime) / 1000);
      const task = taskFor(id);
      videoStore.updateDownload(id, {
        elapsed,
        speed: bytes && !finished ? (received - sampleBytes) / sampleElapsed : 0,
        ...(bytes ? { transferred: received, averageSpeed: received / Math.max(elapsed, 0.001) } : {}),
        ...(!finished && bytes && task?.status === "downloading" && now - lastReceivedAt >= 3000
          ? { statusText: received ? "等待数据..." : "等待服务器响应..." } : {}),
      });
      sampleBytes = received;
      sampleTime = now;
    };
    const timer = setInterval(publish, 500);
    return {
      receive(count: number) { received += count; lastReceivedAt = Date.now(); },
      finish() { if (!stopped) { stopped = true; clearInterval(timer); publish(true); } },
    };
  }

  /** 单文件抓取（用于 ZIP 打包） */
  async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
    const response = await fetch(url, { method: "GET", mode: "cors", signal });
    if (!response.ok) throw new Error(`资源请求失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (signal) checkAbort(signal);
    if (!blob.size) throw new Error("资源为空");
    if (/text\/html|application\/json/i.test(blob.type)) throw new Error("资源地址返回了错误页面");
    return blob;
  }

  /**
   * B 站懒解析（多 P / 合集分集）：当 video.url 为空但带 _cid/_bvid 时，
   * 通过 resolveVideoUrl 取真实直链并写回 store，使播放器与下载都可用。
   */
  async function resolveVideo(video: MediaVideo, signal?: AbortSignal): Promise<MediaVideo> {
    if (signal) checkAbort(signal);
    if (video.url || (!video._cid && !video._bvid) || !resolveVideoUrl) return video;
    const resultVersion = videoStore.resultVersion;
    const resolved = await abortable(resolveVideoUrl(video, signal), signal);
    if (signal) checkAbort(signal);
    if (!resolved?.url) return video;
    const patch = { ...resolved, video_backup: resolved.video_backup ?? [], _resolved: true, _resolving: false, error: undefined };
    if (videoStore.resultVersion === resultVersion && (!video._sourceUrl || video._sourceUrl === videoStore.resultData?._sourceUrl)) videoStore.patchVideo(video, patch);
    return { ...video, ...patch };
  }

  let pageTaskSequence = 0;
  const deliveryTasks = new Map<string, number>();
  const comparableUrl = (url: string) => {
    try { return new URL(url, typeof location === "undefined" ? "https://dokitool.invalid/" : location.href).href; }
    catch { return url; }
  };
  const deliveryStatusText: Record<DownloadSnapshot["status"], string> = {
    queued: "排队中...", preparing: "准备下载...", downloading: "下载中...",
    completed: "传输完成，请在浏览器确认保存", failed: "下载失败",
    cancelled: "已取消", "handed-off": "已交给浏览器", interrupted: "下载连接已中断",
  };

  function applyDelivery(snapshot: DownloadSnapshot, restore = false): void {
    let id = deliveryTasks.get(snapshot.id);
    if (id === undefined && restore) {
      id = videoStore.addDownload({ filename: snapshot.filename, url: snapshot.url });
      deliveryTasks.set(snapshot.id, id);
    }
    if (id === undefined) return;
    const task = taskFor(id);
    if (!task || task.deliveryId !== undefined && task.deliveryId !== snapshot.id) return;
    // A status-only/uncertain Worker reply has no URL. Keep the frozen source
    // in this page so a second click cannot silently create a duplicate task.
    const url = snapshot.url || task.url || "";
    videoStore.updateDownload(id, {
      deliveryId: snapshot.id, transport: snapshot.transport,
      filename: snapshot.filename, url, status: snapshot.status,
      statusText: deliveryStatusText[snapshot.status],
      loaded: snapshot.loaded, total: snapshot.total, speed: snapshot.speed,
      elapsed: snapshot.elapsed, averageSpeed: snapshot.averageSpeed,
      transferred: snapshot.loaded, error: snapshot.error || null, progressKind: "bytes",
      percent: snapshot.status === "completed" ? 100 : snapshot.total > 0
        ? Math.min(99, Math.round(snapshot.loaded / snapshot.total * 100)) : 0,
      nativeAvailable: Boolean(url) && !looksLikeHlsManifest(url),
    });
  }

  /** Called on client mount only; the homepage and SSR never register a Worker. */
  async function restoreDownloads(): Promise<void> {
    try {
      // No download history means no extra chunk or registration on the first visit.
      if (!sessionStorage.getItem("dokitool-downloads-v1")) return;
      const { reconnectStreaming } = await import("../downloads/streaming");
      await reconnectStreaming(snapshot => applyDelivery(snapshot, true));
    } catch { /* Restricted storage must not prevent the parser from starting. */ }
  }

  async function downloadFile(
    url: string, filename: string, downloadId: number,
    controller = new AbortController(), _startedAt = Date.now(),
  ): Promise<void> {
    if (!url) return;
    const matchingTasks = () => videoStore.downloads.filter(task => task.id !== downloadId
      && [task.url, sourceContexts.get(task.id)?.selectedUrl].some(source => source && comparableUrl(source) === comparableUrl(url)));
    const active = (status: string) => ["queued", "preparing", "downloading"].includes(status);
    let duplicate = matchingTasks().some(task => active(task.status));
    if (!duplicate && matchingTasks().some(task => task.status === "interrupted" && task.deliveryId)) {
      try {
        const { hasStreamingTask } = await import("../downloads/streaming");
        duplicate = matchingTasks().some(task => active(task.status)
          || task.status === "interrupted" && task.deliveryId && hasStreamingTask(task.deliveryId));
      } catch {
        // A failed module load is not evidence that a previously started download stopped.
        duplicate = true;
      }
    }
    if (duplicate) {
      videoStore.removeDownload(downloadId);
      archiveRetries.delete(downloadId); videoRetries.delete(downloadId); sourceContexts.delete(downloadId);
      showToast("该资源已有下载任务", "info");
      return;
    }
    const deliveryId = globalThis.crypto?.randomUUID?.() ?? `page-${Date.now()}-${++pageTaskSequence}`;
    deliveryTasks.set(deliveryId, downloadId);
    videoStore.updateDownload(downloadId, {
      deliveryId, abortController: controller, status: "queued", statusText: "排队中...",
      percent: 0, loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0,
      transferred: 0, error: null, progressKind: "bytes", nativeAvailable: !looksLikeHlsManifest(url),
    });
    const context = sourceContexts.get(downloadId);
    const routes = Array.from(new Set([url, ...(context?.routes ?? [])])).slice(0, 3);
    try {
      const { downloadManager } = await import("../downloads/manager");
      checkAbort(controller.signal);
      const result = await downloadManager.run({ id: deliveryId, url, filename, routes }, controller.signal, snapshot => {
        if (taskFor(downloadId)?.deliveryId === deliveryId && taskFor(downloadId)?.status !== "handed-off") applyDelivery(snapshot);
      });
      if (!ownsTask(downloadId, controller)) return;
      // Finishing an older work must never alter a newly parsed work's player.
      if (result.status === "completed" && comparableUrl(result.url) !== comparableUrl(url) && context
        && videoStore.resultVersion === context.resultVersion && effectiveSelectedUrl() === context.selectedUrl) {
        if (context.video && isMultiVideo(videoStore.resultData)) {
          const source = getMediaSources(context.video).find(item => comparableUrl(item.url) === comparableUrl(result.url));
          if (source) videoStore.patchVideo(context.video, selectMediaSource(context.video, source));
        }
        currentVideoUrl.value = result.url;
        showToast("下载已切换到同画质可用线路，播放器与复制链接已同步", "info");
      }
    } catch (error) {
      if (!ownsTask(downloadId, controller)) return;
      if (error instanceof Error && error.name === "StreamingStateUnknownError") {
        videoStore.updateDownload(downloadId, { status: "interrupted", statusText: "下载状态待确认", error: error.message });
        return;
      }
      const cancelled = controller.signal.aborted || error instanceof Error && error.name === "AbortError";
      videoStore.updateDownload(downloadId, {
        status: cancelled ? "cancelled" : "failed", statusText: cancelled ? "已取消" : "下载失败", speed: 0,
        error: cancelled ? null : error instanceof Error ? error.message : "下载失败",
      });
    } finally {
      if (ownsTask(downloadId, controller)) videoStore.updateDownload(downloadId, { abortController: null });
    }
  }

  /** 分片下载（写入 store 进度） */
  async function downloadSegments(
    segments: (HlsSegment | string)[],
    filename: string,
    downloadId: number,
    abortController = new AbortController(),
    startedAt = Date.now(),
  ): Promise<void> {
    videoStore.updateDownload(downloadId, { abortController, progressKind: "segments", nativeAvailable: false, error: null, speed: 0, averageSpeed: 0, elapsed: 0 });
    const monitor = monitorTransfer(downloadId, abortController, startedAt, false);
    try {
      videoStore.updateDownload(downloadId, {
        status: "downloading",
        statusText: "下载分片中...",
        percent: 0,
        loaded: 0,
        total: 0,
      });
      const ok = await mergeAndDownload(segments, {
        signal: abortController.signal,
        filename,
        onProgress: (p) =>
          videoStore.updateDownload(downloadId, {
            loaded: p.loaded,
            total: p.total,
            percent: p.percent,
            statusText: `下载分片 ${p.segment}/${p.segmentCount}（${p.percent}%）`,
          }),
      });
      if (!ok) throw new Error("没有可用的分片");
      if (!ownsTask(downloadId, abortController)) return;
      monitor.finish();
      videoStore.updateDownload(downloadId, {
        status: "completed",
        statusText: "已完成",
        percent: 100,
        loaded: 0,
        total: 0,
        abortController: null,
      });
    } catch (error) {
      if (!ownsTask(downloadId, abortController)) return;
      monitor.finish();
      if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        videoStore.updateDownload(downloadId, { status: "cancelled", statusText: "已取消", abortController: null });
        return;
      }
      const message = error instanceof Error ? error.message : "下载失败";
      videoStore.updateDownload(downloadId, {
        status: "failed",
        statusText: "下载失败",
        error: message,
        abortController: null,
      });
      showToast("分片下载失败：" + message, "error");
    } finally { monitor.finish(); }
  }

  /** 入队一个下载任务；兼容 `enqueue(url, "mp4")` 旧调用 */
  function enqueue(url: string, extension?: string): boolean;
  function enqueue(url: string, options?: EnqueueOptions): boolean;
  function enqueue(
    url: string,
    extensionOrOptions?: string | EnqueueOptions,
  ): boolean {
    const options: EnqueueOptions =
      typeof extensionOrOptions === "string"
        ? { ext: extensionOrOptions }
        : (extensionOrOptions ?? {});
    // 防线：HLS 清单（.m3u8 / remux 备用流）绝不能当普通 mp4 下载，
    // 否则只会拿到几十字节的清单文本（表现为「只下载到分片片段」）。
    // 走到这里说明上游分片解析全部失败（通常是清单被 CORS 拦截）。
    if (looksLikeHlsManifest(url)) {
      showToast("该视频为分片流且清单不可访问，无法合并下载", "warning");
      return false;
    }
    const ext = options.ext ?? "mp4";
    const filename = options.filename ?? getDownloadFilename(url, ext);
    const id = videoStore.addDownload({ filename, url });
    sourceContexts.set(id, { routes: options.routes ?? [url], resultVersion: videoStore.resultVersion, selectedUrl: url });
    void downloadFile(url, filename, id);
    return true;
  }

  /** Deduplicate the explicitly selected stream; never probe another quality. */
  function segmentCandidates(urls: (string | null | undefined)[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const url of urls) {
      if (!url) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      result.push(url);
    }
    return result;
  }

  function firstSegmentUrl(segments: (HlsSegment | string)[]): string {
    const first = segments[0];
    return typeof first === "string" ? first : first?.url ?? "";
  }

  /** 为某集构造可读文件名并入队（自动处理分片合并与 B 站懒解析） */
  async function enqueueVideo(video: MediaVideo, fallbackTitle?: string, retryId?: number): Promise<boolean> {
    if (!video) return false;
    const sourceKey = JSON.stringify([video._sourceUrl || videoStore.resultData?._sourceUrl, video.url, video._bvid, video._cid, video.index]);
    if (retryId === undefined && videoStore.downloads.some(task => task.sourceKey === sourceKey && ["queued", "preparing", "downloading"].includes(task.status))) {
      showToast("该资源已有下载任务", "info"); return false;
    }
    const startedAt = Date.now();
    const resultVersion = videoStore.resultVersion;
    const controller = new AbortController();
    let filename = buildMediaFilename({ title: video.title || fallbackTitle, index: video.index, fallback: video.url });
    const id = retryId ?? videoStore.addDownload({ filename, url: video.url, sourceKey });
    videoRetries.set(id, () => enqueueVideo(video, fallbackTitle, id));
    videoStore.updateDownload(id, { filename, url: video.url, status: "preparing", statusText: "准备下载...", abortController: controller, nativeAvailable: false, elapsed: 0, speed: 0, averageSpeed: 0, transferred: 0, progressKind: undefined, loaded: 0, total: 0, percent: 0, error: null });
    const monitor = monitorTransfer(id, controller, startedAt, false);
    // Preparation is cancellable and has a budget independent of the later transfer.
    const timeout = setTimeout(() => controller.abort("preparation-timeout"), 30000);
    try {
      const resolved = await resolveVideo(video, controller.signal);
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return false;
      if (videoStore.resultVersion !== resultVersion) throw new DOMException("Aborted", "AbortError");
      const url = resolved.url || "";
      if (!url && !resolved.segments?.length) throw new Error(`第 ${video.index} 集解析失败`);
      sourceContexts.set(id, { routes: getSameQualityUrls(resolved, url), resultVersion, selectedUrl: url, video: resolved });
      const probeController = new AbortController();
      const abortProbe = () => probeController.abort();
      controller.signal.addEventListener("abort", abortProbe, { once: true });
      const probeTimeout = setTimeout(abortProbe, 10000);
      let segments: (HlsSegment | string)[] | null;
      try {
        segments = resolved.segments && resolved.segments.length > 1
          ? resolved.segments : await prepareSegments(segmentCandidates([url]), probeController.signal);
      } finally { clearTimeout(probeTimeout); controller.signal.removeEventListener("abort", abortProbe); }
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return false;
      if (videoStore.resultVersion !== resultVersion) throw new DOMException("Aborted", "AbortError");
      filename = buildMediaFilename({ title: resolved.title || fallbackTitle, index: resolved.index, fallback: url || firstSegmentUrl(segments ?? []) });
      monitor.finish();
      clearTimeout(timeout);
      if (segments && segments.length > 1) {
        const finalName = filename.replace(/\.mp4$/i, `.${detectSegmentContainer(segments)}`);
        videoStore.updateDownload(id, { filename: finalName, url: firstSegmentUrl(segments), segments });
        void downloadSegments(segments, finalName, id, controller, startedAt);
      } else {
        videoStore.updateDownload(id, { filename, url });
        void downloadFile(url, filename, id, controller, startedAt);
      }
      return true;
    } catch (error) {
      if (!ownsTask(id, controller)) return false;
      monitor.finish();
      const timedOut = controller.signal.reason === "preparation-timeout";
      const cancelled = !timedOut && (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"));
      videoStore.updateDownload(id, {
        status: cancelled ? "cancelled" : "failed", statusText: cancelled ? "已取消" : "准备下载失败",
        error: cancelled ? null : timedOut ? "准备下载超过 30 秒，请重试" : error instanceof Error ? error.message : "准备下载失败",
        abortController: null,
      });
      return false;
    } finally { clearTimeout(timeout); monitor.finish(); }
  }

  /** 下载第 index 集（当前合集展示列表内的序号），无则拒之 */
  function downloadVideoByIndex(index: number): void {
    const resultData = videoStore.resultData;
    const video =
      selection?.visibleList.value?.[index] ?? resultData?.videos?.[index];
    if (!video) {
      showToast("该分集不存在", "warning");
      return;
    }
    void enqueueVideo(video, resultData?.title);
  }

  /** 当前集（多选或单选）逐个入队下载 */
  async function downloadSelected(): Promise<void> {
    const resultData = videoStore.resultData;
    if (!resultData) return;

    let videos: MediaVideo[] = [];
    if (selection) {
      videos = selection.getBatchVideos();
    } else {
      // 无 selection 环境：退化为当前单选（videos[0] ?? url）
      const first = resultData.videos?.[0];
      if (first?.url) videos = [first];
      else if (resultData.url) videos = [{ index: 1, url: resultData.url } as MediaVideo];
    }
    const usable = videos.filter(
      (video) =>
        Boolean(video.url) ||
        Boolean(video._cid) ||
        Boolean(video._bvid) ||
        (video.segments?.length ?? 0) > 0,
    );
    if (usable.length === 0) {
      showToast("没有可下载的分集", "warning");
      return;
    }
    let added = 0;
    for (const video of usable) {
      if (await enqueueVideo(video, resultData.title)) added++;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    }
    if (added) showToast(`已添加 ${added} 个下载任务${added < usable.length ? `，${usable.length - added} 集失败` : ""}`);
  }

  /** 下载全部集（逐个 enqueue，不打包） */
  async function downloadAllVideos(): Promise<void> {
    const resultData = videoStore.resultData;
    if (!resultData) return;
    const videos = resultData.videos ?? [];
    const usable = videos.filter(
      (video) =>
        Boolean(video.url) ||
        Boolean(video._cid) ||
        Boolean(video._bvid) ||
        (video.segments?.length ?? 0) > 0,
    );
    if (usable.length === 0) {
      downloadMainVideo();
      return;
    }
    let added = 0;
    for (const video of usable) {
      if (await enqueueVideo(video, resultData.title)) added++;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    }
    if (added) showToast(`已添加 ${added} 个下载任务${added < usable.length ? `，${usable.length - added} 集失败` : ""}`);
  }

  /** Preview and download share the selected source; an unresolved episode never falls back to another P. */
  async function downloadMainVideo(): Promise<void> {
    const data = videoStore.resultData;
    if (!data) return;
    const idx = selection?.selectedIndex.value ?? 0;
    const multi = isMultiVideo(data);
    const current = selection?.currentVideo.value ?? data.videos?.[idx];
    const changedSource = !multi && Boolean(currentVideoUrl.value) && currentVideoUrl.value !== data.url;
    const primary: MediaVideo = {
      ...data,
      ...current,
      index: current?.index ?? 1,
      title: current?.title ?? data.title,
      url: current?.url || data.url || "",
      segments: changedSource ? undefined : current?.segments ?? data.segments,
      video_backup: current?.video_backup ?? data.video_backup,
    };
    const selected = getMediaSources(primary).find((source) => source.url === (currentVideoUrl.value || primary.url));
    const video = multi && current ? current : selected ? selectMediaSource(primary, selected)
      : { ...primary, url: currentVideoUrl.value || primary.url, width: undefined, height: undefined, bit_rate: undefined, bitrate: undefined, codec: undefined };
    await enqueueVideo(video, data.title);
  }

  type ArchiveEntry = { filename: string; data: Blob | Uint8Array<ArrayBuffer> };
  type ArchiveBuilder = (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<ArchiveEntry[]>;

  async function runArchive(filename: string, build: ArchiveBuilder, retryId?: number): Promise<void> {
    const id = retryId ?? videoStore.addDownload({ filename, status: "preparing", statusText: "准备中..." });
    const controller = new AbortController();
    archiveRetries.set(id, () => runArchive(filename, build, id));
    videoStore.updateDownload(id, { abortController: controller, status: "preparing", statusText: "准备打包...", percent: 0, error: null, progressKind: "archive", nativeAvailable: false, elapsed: 0, speed: 0, averageSpeed: 0 });
    const monitor = monitorTransfer(id, controller, Date.now(), false);
    try {
      // Only ZIP actions need this library. The import itself cannot be aborted,
      // so cancellation must settle the task and guard all work after it resolves.
      const { default: JSZip } = await abortable(import("jszip"), controller.signal);
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return;
      videoStore.updateDownload(id, { status: "downloading", statusText: "正在打包..." });
      const entries = await build(controller.signal, (done, total) => {
        checkAbort(controller.signal);
        if (!ownsTask(id, controller)) return;
        videoStore.updateDownload(id, { percent: Math.round(done / total * 85), statusText: `打包 ${done}/${total}...` });
      });
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return;
      if (!entries.length) throw new Error("没有可打包的资源");
      const zip = new JSZip();
      for (const entry of entries) {
        checkAbort(controller.signal);
        // ArrayBuffer works consistently in browsers and Node's offline regression harness.
        const data = entry.data instanceof Blob ? await entry.data.arrayBuffer() : entry.data;
        checkAbort(controller.signal);
        if (!ownsTask(id, controller)) return;
        zip.file(entry.filename, data);
      }
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (metadata) => {
        checkAbort(controller.signal);
        if (!ownsTask(id, controller)) return;
        videoStore.updateDownload(id, { percent: 85 + Math.round(metadata.percent * 0.14), statusText: "生成压缩包..." });
      });
      checkAbort(controller.signal);
      if (!ownsTask(id, controller)) return;
      const blobUrl = URL.createObjectURL(blob);
      triggerBrowserDownload(blobUrl, filename);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      monitor.finish();
      videoStore.updateDownload(id, { status: "completed", statusText: "已完成", percent: 100, abortController: null });
      archiveRetries.delete(id);
      showToast(`已打包 ${entries.length} 个文件`);
    } catch (error) {
      if (videoStore.downloads.find((task) => task.id === id)?.abortController !== controller) return;
      monitor.finish();
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        videoStore.updateDownload(id, { status: "cancelled", statusText: "已取消", abortController: null });
        return;
      }
      const message = error instanceof Error ? error.message : "打包失败";
      videoStore.updateDownload(id, { status: "failed", statusText: "打包失败", error: message, abortController: null });
      showToast("打包失败：" + message, "error");
    } finally { monitor.finish(); }
  }

  /** Resolve every selected episode; a missing episode fails the archive instead of silently creating an empty/partial ZIP. */
  async function downloadVideosAsZip(videos: MediaVideo[], zipName?: string): Promise<void> {
    if (!videos.length) { showToast("没有可下载的分集", "warning"); return; }
    const snapshot = videos.map((video) => ({ ...video }));
    const filename = zipName?.endsWith(".zip") ? zipName : `videos_${Date.now()}.zip`;
    await runArchive(filename, async (signal, progress) => {
      const entries: ArchiveEntry[] = [];
      for (let i = 0; i < snapshot.length; i++) {
        checkAbort(signal);
        const video = await resolveVideo(snapshot[i], signal);
        checkAbort(signal);
        if (!video.url && !video.segments?.length) throw new Error(`第 ${video.index} 集解析失败，未生成压缩包`);
        const segments = video.segments && video.segments.length > 1 ? video.segments
          : await prepareSegments(segmentCandidates([video.url]), signal);
        checkAbort(signal);
        const base = buildMediaFilename({ title: video.title, index: video.index, fallback: video.url }).replace(/\.mp4$/i, "");
        if (segments && segments.length > 1) {
          const data = await mergeSegments(segments, { signal });
          entries.push({ filename: `${String(i + 1).padStart(3, "0")}_${base}.${detectSegmentContainer(segments)}`, data });
        } else {
          if (looksLikeHlsManifest(video.url)) throw new Error(`第 ${video.index} 集分片清单不可读取`);
          entries.push({ filename: `${String(i + 1).padStart(3, "0")}_${base}.mp4`, data: await fetchBlob(video.url, signal) });
        }
        progress(i + 1, snapshot.length);
      }
      return entries;
    });
  }

  type ArchiveResource = { url: string; name: string; extension: string };
  async function downloadResourcesAsZip(resources: ArchiveResource[], filename: string): Promise<void> {
    if (!resources.length) { showToast("没有可下载的资源", "warning"); return; }
    await runArchive(filename, async (signal, progress) => {
      const entries: ArchiveEntry[] = [];
      for (let i = 0; i < resources.length; i++) {
        checkAbort(signal);
        const resource = resources[i];
        const blob = await fetchBlob(resource.url, signal);
        const imageExtension = ({ "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif" } as Record<string, string>)[blob.type.split(";")[0]];
        entries.push({ filename: `${resource.name}.${imageExtension || resource.extension}`, data: blob });
        progress(i + 1, resources.length);
      }
      return entries;
    });
  }

  async function downloadAllMedia(mode: "all" | "images" | "live" | "covers" = "all"): Promise<void> {
    const data = videoStore.resultData;
    if (!data) return;
    const resources: ArchiveResource[] = [];
    const add = (url: string | undefined | null, name: string, extension: string) => {
      if (url && !resources.some((item) => item.url === url)) resources.push({ url, name, extension });
    };
    if (mode === "all") add(currentVideoUrl.value || data.url, "video", "mp4");
    if (mode === "all" || mode === "images") data.images.forEach((url, i) => add(url, `image_${i + 1}`, "jpg"));
    if (mode !== "images") data.live_photo.forEach((item, i) => {
      add(item.image, `live_${i + 1}_cover`, "jpg");
      if (mode !== "covers") add(item.video, `live_${i + 1}_video`, "mp4");
    });
    await downloadResourcesAsZip(resources, `${mode}_${Date.now()}.zip`);
  }

  function downloadBackupVideo(backup: VideoBackup): void {
    if (backup?.url) enqueue(backup.url, { ext: "mp4", routes: getSameQualityUrls(videoStore.resultData ?? {}, backup.url) });
  }

  function downloadMusic(music: MusicResource): void {
    if (!music?.url) return;
    const extension = music.url.includes(".m4a") ? "m4a" : "mp3";
    enqueue(music.url, extension);
  }

  function downloadLiveVideo(item: LivePhoto): void {
    if (item?.video) enqueue(item.video, "mp4");
  }

  function downloadImage(url: string): void {
    if (url) enqueue(url, "jpg");
  }

  function downloadLiveCover(item: LivePhoto): void {
    if (item?.image) downloadImage(item.image);
  }

  async function downloadAllImages(): Promise<void> {
    const images = videoStore.resultData?.images || [];
    if (images.length === 0) return;
    for (const image of images) {
      enqueue(image, "jpg");
      await new Promise<void>((resolve) => window.setTimeout(resolve, 300));
    }
    showToast(`成功添加 ${images.length} 个下载任务`);
  }

  async function handleCancelDownload(id: number): Promise<void> {
    const task = taskFor(id);
    if (!task) return;
    const { deliveryId, abortController } = task;
    // Imports and Worker acknowledgements can race completion, native handoff,
    // or a retry reusing this card. Cancellation belongs only to this attempt.
    const currentAttempt = () => {
      const current = taskFor(id);
      return current && current.deliveryId === deliveryId && current.abortController === abortController
        && ["queued", "preparing", "downloading", "interrupted"].includes(current.status) ? current : undefined;
    };
    if (!currentAttempt()) return;
    if (task.transport === "browser_streaming" && deliveryId) {
      videoStore.updateDownload(id, { statusText: "正在确认取消..." });
      try {
        const { cancelStreaming, hasStreamingTask } = await import("../downloads/streaming");
        const current = currentAttempt();
        if (!current) return;
        if (current.transport !== "browser_streaming" || current.abortController && !hasStreamingTask(deliveryId)) {
          videoStore.cancelDownload(id);
          return;
        }
        await cancelStreaming(deliveryId);
      } catch (error) {
        if (currentAttempt()) videoStore.updateDownload(id, { status: "interrupted", statusText: "无法确认取消结果", error: error instanceof Error ? error.message : "请检查浏览器下载列表" });
        return;
      }
    }
    if (currentAttempt()) videoStore.cancelDownload(id);
  }

  async function handleRetryDownload(id: number): Promise<void> {
    const task = videoStore.downloads.find((download) => download.id === id);
    if (!task || ["queued", "preparing", "downloading"].includes(task.status)) return;
    if (task.deliveryId && task.transport === "browser_streaming") {
      try {
        const { forgetStreaming } = await import("../downloads/streaming");
        await forgetStreaming(task.deliveryId);
        deliveryTasks.delete(task.deliveryId);
      } catch (error) { showToast(error instanceof Error ? error.message : "原任务状态未知，请先检查浏览器下载列表", "warning"); return; }
    }
    const retryArchive = archiveRetries.get(id);
    if (retryArchive) { void retryArchive(); return; }
    const retryVideo = videoRetries.get(id);
    if (retryVideo) { void retryVideo(); return; }
    // 分片任务重试：重走合并下载，避免退化成只下首片
    const rawSegments = task.segments;
    if (Array.isArray(rawSegments) && rawSegments.length > 1) {
      const segments = rawSegments.map((s) =>
        typeof s === "string" ? s : (s as HlsSegment),
      );
      void downloadSegments(segments, task.filename, id);
      return;
    }
    if (task.url) void downloadFile(task.url, task.filename, id);
  }

  /** Called synchronously by a real user click. Browser-owned progress is unknowable here. */
  function handleBrowserDownload(id: number): void {
    const task = taskFor(id);
    if (!task?.nativeAvailable || !task.url || !/^(?:https?:\/\/|\/(?!\/))/i.test(task.url) || looksLikeHlsManifest(task.url)) return;
    if (task.transport === "browser_streaming" && ["queued", "preparing", "downloading", "interrupted"].includes(task.status)) {
      // Preserve a real click for the external navigation; do not open another
      // download until cancellation of the browser-owned response is confirmed.
      void handleCancelDownload(id).then(() => {
        if (taskFor(id)?.status === "cancelled") showToast("已停止站内传输，请再次点击“打开源链接”", "info");
      });
      return;
    }
    task.abortController?.abort();
    videoStore.updateDownload(id, {
      status: "handed-off", statusText: "已交给浏览器", abortController: null,
      speed: 0, averageSpeed: 0, percent: 0, error: null,
    });
    triggerBrowserDownload(task.url, task.filename, true);
    showToast("请在打开的页面或浏览器下载列表查看进度；本站无法确认下载是否完成", "info", 6000);
  }

  async function handleClearCompleted(id: number | "all"): Promise<void> {
    const settled = ["completed", "cancelled", "failed", "handed-off", "interrupted"];
    const tasks = videoStore.downloads.filter(task => settled.includes(task.status) && (id === "all" || task.id === id));
    for (const task of tasks) {
      if (task.deliveryId && task.transport === "browser_streaming") {
        try {
          const { forgetStreaming } = await import("../downloads/streaming");
          await forgetStreaming(task.deliveryId);
        } catch (error) { showToast(error instanceof Error ? error.message : "原任务状态未知，暂不能清除", "warning"); continue; }
      }
      if (task.deliveryId) deliveryTasks.delete(task.deliveryId);
      archiveRetries.delete(task.id); videoRetries.delete(task.id); sourceContexts.delete(task.id);
      videoStore.removeDownload(task.id);
    }
  }

  return {
    restoreDownloads,
    downloadFile,
    downloadMainVideo,
    downloadVideoByIndex,
    downloadSelected,
    downloadAllVideos,
    downloadVideosAsZip,
    downloadAllMedia,
    downloadBackupVideo,
    downloadMusic,
    downloadLiveVideo,
    downloadLiveCover,
    downloadImage,
    downloadAllImages,
    handleCancelDownload,
    handleRetryDownload,
    handleBrowserDownload,
    handleClearCompleted,
  };
}
