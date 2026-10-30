/* Download-only service worker. It never caches or intercepts the application/API. */
const PROTOCOL = 1;
const BUILD = "downloads-20261030.2";
const MAX_ACTIVE = 2;
const IDLE_MS = 45_000;
const STALLED_MS = 15_000;
const SPEED_WINDOW_MS = 2000;
const CLAIM_MS = 60_000;
const RETAIN_MS = 10 * 60_000;
const tasks = new Map();
const queue = [];
let active = 0;
const terminal = status => ["completed", "failed", "cancelled"].includes(status);
const abortError = () => new DOMException("下载已取消", "AbortError");
const validKey = value => typeof value === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(value);
const cleanFilename = value => String(value || "download.mp4").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").slice(0, 180).trim() || "download.mp4";
const sourceUrl = value => {
  const url = new URL(value, self.location.origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
      (url.origin === self.location.origin && url.pathname.startsWith("/downloads/")) || /\.m3u8(?:$|[?#])/i.test(url.href)) {
    throw new Error("资源地址不支持完整文件下载");
  }
  return url.href;
};

function snapshot(task) {
  const now = Date.now(), end = task.finishedAt ?? now;
  const elapsed = Math.max(0, (end - task.startedAt) / 1000);
  const transferElapsed = task.transferStartedAt === undefined ? 0 : Math.max(0, (end - task.transferStartedAt) / 1000);
  // Lack of downstream demand may be a normal browser pause. Report it without
  // cancelling the transfer, starting another route, or releasing its slot.
  const observation = task.state.status === "downloading" && !task.pendingUpstream &&
    now - Math.max(task.lastPullAt ?? task.transferStartedAt, task.lastReceivedAt ?? 0) >= STALLED_MS ? "stalled" : undefined;
  return { ...task.state, workerBuild: BUILD, observation, elapsed, transferElapsed,
    speed: now - (task.lastReceivedAt || 0) > 3000 ? 0 : task.state.speed,
    averageSpeed: task.state.loaded / Math.max(0.001, transferElapsed) };
}

function publish(task, force = false) {
  const now = Date.now();
  if (!force && now - task.publishedAt < 300) return;
  if (task.state.status === "downloading") {
    const samples = task.speedSamples;
    samples.push({ at: now, loaded: task.state.loaded });
    while (samples.length > 2 && samples[1].at <= now - SPEED_WINDOW_MS) samples.shift();
    task.state.speed = (task.state.loaded - samples[0].loaded) / Math.max(0.001, (now - samples[0].at) / 1000);
  } else task.state.speed = 0;
  task.publishedAt = now;
  const message = { channel: "dokitool-download", protocol: PROTOCOL, snapshot: snapshot(task) };
  for (const clientId of task.subscribers) {
    void self.clients.get(clientId).then(client => client?.postMessage(message));
  }
}

function drain() {
  while (active < MAX_ACTIVE && queue.length) {
    const task = queue.shift();
    if (terminal(task.state.status)) { task.rejectSlot?.(abortError()); continue; }
    active++;
    task.hasSlot = true;
    task.resolveSlot();
  }
}

function settle(task, status, error) {
  if (terminal(task.state.status)) return;
  clearTimeout(task.claimTimer);
  task.state.status = status;
  task.state.error = error;
  task.finishedAt = Date.now();
  task.detachRequestAbort?.();
  task.detachRequestAbort = undefined;
  const queuedIndex = queue.indexOf(task);
  if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
  if (status !== "completed") {
    // A consumer need not pull again after stopping. Error the output now rather
    // than waiting for a future pull to notice the aborted upstream request.
    task.outputController?.error(status === "cancelled" ? abortError() : new Error(error || "下载失败"));
  }
  task.outputController = undefined;
  task.controller.abort();
  const reader = task.reader;
  task.reader = undefined;
  void reader?.cancel().catch(() => {}).finally(() => { reader.releaseLock(); });
  task.rejectSlot?.(abortError());
  if (task.hasSlot) { task.hasSlot = false; active--; }
  publish(task, true);
  task.resolveSettled();
  drain();
}

function prune() {
  for (const [id, task] of tasks) if (task.finishedAt && Date.now() - task.finishedAt > RETAIN_MS) tasks.delete(id);
}

async function timed(task, operation) {
  if (task.controller.signal.aborted) throw abortError();
  task.pendingUpstream = (task.pendingUpstream || 0) + 1;
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        task.controller.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => reject(new Error("来源超过 45 秒没有返回数据，请重新下载")), IDLE_MS);
      }),
    ]);
  } finally {
    task.pendingUpstream--;
    clearTimeout(timer);
    task.controller.signal.removeEventListener("abort", onAbort);
  }
}

function mediaHeaders(response, filename) {
  if (response.status !== 200 || response.headers.has("content-range") || response.type === "opaque" || !response.body) throw new Error(`资源不是完整文件响应（HTTP ${response.status}）`);
  const mime = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
  if (!/^(video\/|audio\/|image\/|application\/octet-stream$)/.test(mime)) throw new Error("资源没有返回可下载的媒体文件");
  const extensions = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/mp2t": "ts", "audio/mpeg": "mp3", "audio/mp4": "m4a", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
  const extension = extensions[mime];
  const safeName = cleanFilename(extension ? filename.replace(/\.[^.]+$/, `.${extension}`) : filename);
  const length = Number(response.headers.get("content-length"));
  const encoding = response.headers.get("content-encoding");
  const total = Number.isSafeInteger(length) && length > 0 && (!encoding || encoding === "identity") ? length : 0;
  return { mime, filename: safeName, total };
}

async function prepare(task) {
  let lastError;
  // Only before returning the attachment response can another route replace this one.
  for (const url of task.routes) {
    const attempt = new AbortController();
    const abortAttempt = () => attempt.abort();
    task.controller.signal.addEventListener("abort", abortAttempt, { once: true });
    let response;
    try {
      task.state.url = url;
      publish(task, true);
      response = await timed(task, () => fetch(url, {
        signal: attempt.signal, mode: "cors", credentials: new URL(url).origin === self.location.origin ? "same-origin" : "omit",
        referrerPolicy: "no-referrer", cache: "no-store",
      }));
      const metadata = mediaHeaders(response, task.state.filename);
      task.reader = response.body.getReader();
      const first = await timed(task, () => task.reader.read());
      if (first.done || !first.value?.length) throw new Error("资源为空");
      const prefix = new TextDecoder().decode(first.value.subarray(0, 100)).trimStart();
      if (/^(?:<!doctype|<html|#EXTM3U|\{"|\[\{)/i.test(prefix)) throw new Error("资源返回了页面或播放清单，不能作为完整视频保存");
      if (metadata.total && first.value.length > metadata.total) throw new Error("下载长度与来源声明不一致");
      if (task.controller.signal.aborted) throw abortError();
      Object.assign(task.state, metadata);
      // Keep this attempt alive; cancelling the task aborts its source request as well.
      return { first: first.value, mime: metadata.mime };
    } catch (error) {
      lastError = error;
      attempt.abort();
      void task.reader?.cancel().catch(() => {});
      if (!task.reader) void response?.body?.cancel().catch(() => {});
      task.reader = undefined;
      task.controller.signal.removeEventListener("abort", abortAttempt);
      if (task.controller.signal.aborted) throw abortError();
    }
  }
  throw lastError || new Error("没有可用的下载线路");
}

async function attachment(task) {
  if (task.controller.signal.aborted) throw abortError();
  await new Promise((resolve, reject) => {
    task.resolveSlot = resolve; task.rejectSlot = reject;
    queue.push(task); drain();
  });
  if (task.controller.signal.aborted) throw abortError();
  task.state.status = "preparing";
  publish(task, true);
  const prepared = await prepare(task);
  if (task.controller.signal.aborted) throw abortError();
  let first = prepared.first;
  task.state.status = "downloading";
  task.transferStartedAt = Date.now();
  task.speedSamples = [{ at: task.transferStartedAt, loaded: 0 }];
  publish(task, true);
  const stream = new ReadableStream({
    start(controller) { task.outputController = controller; },
    async pull(controller) {
      try {
        if (task.controller.signal.aborted) throw abortError();
        task.lastPullAt = Date.now();
        const item = first ? { value: first, done: false } : await timed(task, () => task.reader.read());
        first = undefined;
        if (item.done) {
          if (!task.state.loaded || (task.state.total && task.state.loaded !== task.state.total)) throw new Error("下载不完整，请重新下载");
          controller.close();
          task.outputController = undefined;
          settle(task, "completed");
          return;
        }
        if (task.state.total && task.state.loaded + item.value.length > task.state.total) throw new Error("下载长度与来源声明不一致");
        task.state.loaded += item.value.length;
        task.lastReceivedAt = Date.now();
        controller.enqueue(item.value);
        publish(task);
      } catch (error) {
        settle(task, task.controller.signal.aborted ? "cancelled" : "failed", error.message);
      }
    },
    cancel() { settle(task, "cancelled"); },
  }, { highWaterMark: 0 });
  const encoded = encodeURIComponent(task.state.filename).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const headers = {
    "Content-Type": prepared.mime,
    "Content-Disposition": `attachment; filename="download.${task.state.filename.split(".").pop()}"; filename*=UTF-8''${encoded}`,
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "X-DokiTool-Worker-Build": BUILD,
  };
  if (task.state.total) headers["Content-Length"] = String(task.state.total);
  return new Response(stream, { headers });
}

async function authorizedClient(event) {
  if (!event.source?.id) return null;
  const client = await self.clients.get(event.source.id);
  return client && new URL(client.url).origin === self.location.origin ? client : null;
}

self.addEventListener("message", event => {
  const port = event.ports?.[0];
  if (!port) return;
  event.waitUntil((async () => {
    const client = await authorizedClient(event);
    if (!client || event.data?.protocol !== PROTOCOL) { port.postMessage({ error: "下载通信校验失败" }); return; }
    prune();
    const message = event.data;
    try {
      if (message.action === "ping") { port.postMessage({ protocol: PROTOCOL, workerBuild: BUILD }); return; }
      if (message.action === "start") {
        const request = message.request;
        if (!validKey(request?.id) || !validKey(message.token)) throw new Error("无效下载任务");
        let task = tasks.get(request.id);
        if (task && task.token !== message.token) throw new Error("下载任务无访问权限");
        if (!task) {
          if (tasks.size >= 100) throw new Error("下载任务过多，请清理后重试");
          const routes = [...new Set([request.url, ...(request.routes || [])].slice(0, 10).map(sourceUrl))].slice(0, 3);
          if (!routes.length) throw new Error("资源地址为空");
          const now = Date.now();
          const startedAt = Number.isFinite(request.startedAt) && request.startedAt > 0 && request.startedAt <= now ? request.startedAt : now;
          task = {
            token: message.token, routes, controller: new AbortController(), subscribers: new Set(),
            startedAt, publishedAt: now,
            state: { id: request.id, transport: "browser_streaming", status: "queued", filename: cleanFilename(request.filename), url: routes[0], loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0 },
          };
          task.settled = new Promise(resolve => { task.resolveSettled = resolve; });
          task.claimTimer = setTimeout(() => settle(task, "failed", "浏览器未接收下载，请重试或手动打开源链接"), CLAIM_MS);
          tasks.set(request.id, task);
        }
        task.subscribers.add(client.id);
        port.postMessage({ snapshot: snapshot(task), downloadUrl: `/downloads/file/${request.id}/${task.token}` });
        // The navigation can outlive its originating page. Its lifetime is tied to the transfer.
        await task.settled;
        return;
      }
      if (message.action === "query") {
        const result = [];
        for (const key of (message.tasks || []).slice(0, 100)) {
          const task = tasks.get(key.id);
          if (task && task.token === key.token) { task.subscribers.add(client.id); result.push(snapshot(task)); }
        }
        port.postMessage({ snapshots: result, workerBuild: BUILD }); return;
      }
      const task = tasks.get(message.id);
      if (!task && message.action === "forget") { port.postMessage({ forgotten: true }); return; }
      if (!task || task.token !== message.token) throw new Error("下载任务不存在或已失效");
      if (message.action === "cancel") settle(task, "cancelled");
      else if (message.action === "forget" && terminal(task.state.status)) tasks.delete(message.id);
      else throw new Error("无法执行下载操作");
      port.postMessage({ snapshot: snapshot(task) });
    } catch (error) { port.postMessage({ error: error.message }); }
  })());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/downloads/file/")) return;
  const [, , , id, token] = url.pathname.split("/");
  const task = tasks.get(id);
  if (event.request.method !== "GET" || !task || task.token !== token || task.claimed || terminal(task.state.status)) {
    event.respondWith(new Response("Download expired", { status: 404, headers: { "Cache-Control": "no-store" } })); return;
  }
  task.claimed = true;
  clearTimeout(task.claimTimer);
  const signal = event.request.signal;
  const abort = () => settle(task, "cancelled");
  task.detachRequestAbort = () => signal.removeEventListener("abort", abort);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  event.waitUntil(task.settled);
  event.respondWith(attachment(task).catch(error => {
    settle(task, task.controller.signal.aborted ? "cancelled" : "failed", error.message);
    return new Response("Download failed", { status: 502, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
  }));
});
