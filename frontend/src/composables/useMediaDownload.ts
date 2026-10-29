import { type Ref } from "vue";
import JSZip from "jszip";
import type {
  LivePhoto,
  MediaVideo,
  MusicResource,
  ToastType,
  VideoBackup,
} from "../types/media";
import { getDownloadFilename } from "../utils/downloadFilename";
import { buildMediaFilename } from "../utils/videoFilename";
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
  resolveVideoUrl?: (video: MediaVideo) => Promise<ResolvedVideo | null>;
}

interface EnqueueOptions {
  /** 显式文件名（已可读）；缺省用 getDownloadFilename */
  filename?: string;
  /** 扩展名，默认 "mp4" */
  ext?: string;
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
  const checkAbort = (signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  };

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
  async function resolveVideo(video: MediaVideo): Promise<MediaVideo> {
    if (video.url || (!video._cid && !video._bvid) || !resolveVideoUrl) return video;
    const resultVersion = videoStore.resultVersion;
    const resolved = await resolveVideoUrl(video);
    if (!resolved?.url) return video;
    const patch = { ...resolved, video_backup: resolved.video_backup ?? [], _resolved: true, _resolving: false, error: undefined };
    if (videoStore.resultVersion === resultVersion) videoStore.patchVideo(video, patch);
    return { ...video, ...patch };
  }

  async function downloadFile(url: string, filename: string, downloadId: number): Promise<void> {
    if (!url) return;
    // 兜底防线：HLS 清单地址不可当作完整 mp4 下载（只会得到清单文本）。
    // 分片合并应走 downloadSegments；此处拦截可覆盖重试等旁路调用。
    if (looksLikeHlsManifest(url)) {
      videoStore.updateDownload(downloadId, {
        status: "failed",
        statusText: "下载失败",
        error: "该地址是 HLS 清单，需分片合并下载",
      });
      showToast("该视频为分片流且清单不可访问，无法合并下载", "warning");
      return;
    }
    const abortController = new AbortController();
    videoStore.updateDownload(downloadId, { abortController });

    try {
      videoStore.updateDownload(downloadId, {
        status: "downloading",
        statusText: "下载中...",
        percent: 0,
        loaded: 0,
        total: 0,
      });
      const response = await fetch(url, {
        method: "GET",
        mode: "cors",
        signal: abortController.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";")[0] || "";
      if (/text\/html|application\/json/i.test(contentType)) throw new Error("资源地址返回了错误页面");
      const extension = ({ "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/avif": "avif", "audio/mp4": "m4a", "audio/mpeg": "mp3" } as Record<string, string>)[contentType];
      if (extension) filename = filename.replace(/\.[^.]+$/, `.${extension}`);
      videoStore.updateDownload(downloadId, { filename });
      if (!response.body) throw new Error("下载响应不支持流式读取");

      const total = Number(response.headers.get("content-length")) || 0;
      const reader = response.body.getReader();
      const chunks: BlobPart[] = [];
      let loaded = 0;
      let lastTime = Date.now();
      let lastLoaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value.slice().buffer as ArrayBuffer);
        loaded += value.length;
        const now = Date.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed >= 0.3) {
          videoStore.updateDownload(downloadId, {
            loaded,
            total,
            percent: total > 0 ? Math.round((loaded / total) * 100) : 0,
            speed: (loaded - lastLoaded) / elapsed,
          });
          lastTime = now;
          lastLoaded = loaded;
        }
      }

      // R2: 有 Content-Length 时必须完整收齐，否则失败（fallback 新窗口兜底）
      if (total > 0 && loaded !== total) {
        throw new Error(`下载不完整：期望 ${total} 字节，实际 ${loaded} 字节`);
      }

      checkAbort(abortController.signal);
      if (!loaded) throw new Error("资源为空");
      const blobUrl = URL.createObjectURL(new Blob(chunks, { type: contentType }));
      triggerBrowserDownload(blobUrl, filename);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      videoStore.updateDownload(downloadId, {
        status: "completed",
        statusText: "已完成",
        percent: 100,
        loaded,
        total: total || loaded,
      });
    } catch (error) {
      if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        videoStore.updateDownload(downloadId, { status: "cancelled", statusText: "已取消" });
        return;
      }
      const message = error instanceof Error ? error.message : "下载失败";
      videoStore.updateDownload(downloadId, {
        status: "failed",
        statusText: "下载失败",
        error: message,
      });
      triggerBrowserDownload(url, filename, true);
      showToast("浏览器无法直接下载，已在新窗口打开资源", "warning");
    }
  }

  /** 分片下载（写入 store 进度） */
  async function downloadSegments(
    segments: (HlsSegment | string)[],
    filename: string,
    downloadId: number,
  ): Promise<void> {
    const abortController = new AbortController();
    videoStore.updateDownload(downloadId, { abortController });
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
      videoStore.updateDownload(downloadId, {
        status: "completed",
        statusText: "已完成",
        percent: 100,
        loaded: 0,
        total: 0,
      });
    } catch (error) {
      if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        videoStore.updateDownload(downloadId, { status: "cancelled", statusText: "已取消" });
        return;
      }
      const message = error instanceof Error ? error.message : "下载失败";
      videoStore.updateDownload(downloadId, {
        status: "failed",
        statusText: "下载失败",
        error: message,
      });
      showToast("分片下载失败：" + message, "error");
    }
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
    void downloadFile(url, filename, id);
    return true;
  }

  /** 主直链 + 备用画质链接按顺序去重（分片流候选：首个探测成功者胜出） */
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
  async function enqueueVideo(video: MediaVideo, fallbackTitle?: string): Promise<boolean> {
    if (!video) return false;
    const resolved = await resolveVideo(video);
    const url = resolved.url || "";
    if (!url && !(resolved.segments?.length)) {
      showToast(`第 ${video.index} 集解析失败，未添加下载`, "warning");
      return false;
    }
    const segments = resolved.segments && resolved.segments.length > 1
      ? resolved.segments
      : await prepareSegments(segmentCandidates([
          url,
        ]));
    const filename = buildMediaFilename({ title: resolved.title || fallbackTitle,
      index: resolved.index, fallback: url || firstSegmentUrl(segments ?? []) });
    if (segments && segments.length > 1) {
      const ext = detectSegmentContainer(segments);
      const finalName = filename.replace(/\.mp4$/i, `.${ext}`);
      const id = videoStore.addDownload({ filename: finalName, url: firstSegmentUrl(segments), segments });
      void downloadSegments(segments, finalName, id);
      return true;
    }
    return enqueue(url, { filename, ext: "mp4" });
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
    const multi = (data.videos?.length ?? 0) > 1 || (data.collections?.length ?? 0) > 0;
    const current = selection?.currentVideo.value ?? data.videos?.[idx];
    const changedSource = !multi && Boolean(currentVideoUrl.value) && currentVideoUrl.value !== data.url;
    const video: MediaVideo = multi && current ? current : {
      ...current,
      index: current?.index ?? 1,
      title: current?.title ?? data.title,
      url: currentVideoUrl.value || current?.url || data.url || "",
      segments: changedSource ? undefined : current?.segments ?? data.segments,
      video_backup: current?.video_backup ?? data.video_backup,
    };
    await enqueueVideo(video, data.title);
  }

  type ArchiveEntry = { filename: string; data: Blob | Uint8Array<ArrayBuffer> };
  type ArchiveBuilder = (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<ArchiveEntry[]>;

  async function runArchive(filename: string, build: ArchiveBuilder, retryId?: number): Promise<void> {
    const id = retryId ?? videoStore.addDownload({ filename, status: "preparing", statusText: "准备中..." });
    const controller = new AbortController();
    archiveRetries.set(id, () => runArchive(filename, build, id));
    videoStore.updateDownload(id, { abortController: controller, status: "downloading", statusText: "正在打包...", percent: 0, error: null });
    try {
      const entries = await build(controller.signal, (done, total) => {
        checkAbort(controller.signal);
        videoStore.updateDownload(id, { percent: Math.round(done / total * 85), statusText: `打包 ${done}/${total}...` });
      });
      checkAbort(controller.signal);
      if (!entries.length) throw new Error("没有可打包的资源");
      const zip = new JSZip();
      for (const entry of entries) {
        checkAbort(controller.signal);
        // ArrayBuffer works consistently in browsers and Node's offline regression harness.
        zip.file(entry.filename, entry.data instanceof Blob ? await entry.data.arrayBuffer() : entry.data);
      }
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (metadata) => {
        checkAbort(controller.signal);
        videoStore.updateDownload(id, { percent: 85 + Math.round(metadata.percent * 0.14), statusText: "生成压缩包..." });
      });
      checkAbort(controller.signal);
      const blobUrl = URL.createObjectURL(blob);
      triggerBrowserDownload(blobUrl, filename);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      videoStore.updateDownload(id, { status: "completed", statusText: "已完成", percent: 100, abortController: null });
      archiveRetries.delete(id);
      showToast(`已打包 ${entries.length} 个文件`);
    } catch (error) {
      if (videoStore.downloads.find((task) => task.id === id)?.abortController !== controller) return;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        videoStore.updateDownload(id, { status: "cancelled", statusText: "已取消", abortController: null });
        return;
      }
      const message = error instanceof Error ? error.message : "打包失败";
      videoStore.updateDownload(id, { status: "failed", statusText: "打包失败", error: message, abortController: null });
      showToast("打包失败：" + message, "error");
    }
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
        const video = await resolveVideo(snapshot[i]);
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
    if (backup?.url) enqueue(backup.url, "mp4");
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

  function handleCancelDownload(id: number): void {
    videoStore.cancelDownload(id);
  }

  function handleRetryDownload(id: number): void {
    const task = videoStore.downloads.find((download) => download.id === id);
    if (!task || ["preparing", "downloading"].includes(task.status)) return;
    const retryArchive = archiveRetries.get(id);
    if (retryArchive) { void retryArchive(); return; }
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

  function handleClearCompleted(id: number | "all"): void {
    if (id === "all") {
      for (const task of videoStore.downloads) if (["completed", "cancelled", "failed"].includes(task.status)) archiveRetries.delete(task.id);
      videoStore.clearCompletedDownloads();
    } else {
      archiveRetries.delete(id);
      videoStore.removeDownload(id);
    }
  }

  return {
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
    handleClearCompleted,
  };
}
