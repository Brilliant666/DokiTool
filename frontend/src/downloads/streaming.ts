import { StreamingUnavailableError, type DownloadObserver, type DownloadRequest, type DownloadSnapshot } from "./types";

const PROTOCOL = 1;
const SCOPE = "/downloads/";
const STORAGE_KEY = "dokitool-downloads-v1";
type SavedSnapshot = Omit<DownloadSnapshot, "url">;
interface TaskKey { id: string; token: string; filename: string; savedAt: number; last?: SavedSnapshot; result?: SavedSnapshot }
interface WorkerReply { protocol?: number; workerBuild?: string; error?: string; snapshot?: DownloadSnapshot; snapshots?: DownloadSnapshot[]; downloadUrl?: string }
const observers = new Map<string, Set<DownloadObserver>>();
const frames = new Map<string, HTMLIFrameElement>();
const keys = new Map<string, TaskKey>();
const latest = new Map<string, DownloadSnapshot>();
const workerBuilds = new WeakMap<ServiceWorker, string>();
const checkedUpdates = new Set<string>();
let savedProgressAt = 0;
let listening = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;
const watched = new Set<string>();
const uncertain = new Set<string>();
const started = new Set<string>();

const terminal = (snapshot: DownloadSnapshot) => ["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status) && !uncertain.has(snapshot.id);
const abortError = () => new DOMException("下载已取消", "AbortError");

function readKeys(): TaskKey[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(item => item && typeof item.id === "string" && typeof item.token === "string" && typeof item.filename === "string" && Date.now() - item.savedAt < 24 * 60 * 60_000).slice(-100);
  } catch { return []; }
}

function saveKeys(): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...keys.values()])); } catch { /* Restricted storage still permits the current download. */ }
}

function notify(snapshot: DownloadSnapshot, confirmed = true): void {
  if (confirmed) uncertain.delete(snapshot.id); else uncertain.add(snapshot.id);
  if (confirmed) {
    latest.set(snapshot.id, snapshot);
    const key = keys.get(snapshot.id);
    if (key) {
      const { url: _url, ...progress } = snapshot;
      key.last = progress;
      // Refresh can retain progress without storing signed URLs or writing storage per chunk.
      if (Date.now() - savedProgressAt >= 5000) { savedProgressAt = Date.now(); saveKeys(); }
    }
  }
  for (const observer of observers.get(snapshot.id) || []) observer(snapshot);
  if (terminal(snapshot)) {
    started.delete(snapshot.id);
    watched.delete(snapshot.id);
    const key = keys.get(snapshot.id);
    if (key) { const { url: _url, ...result } = snapshot; key.result = result; key.filename = snapshot.filename; saveKeys(); }
    if (!watched.size) { clearInterval(pollTimer); pollTimer = undefined; }
    // Keep the iframe until the response has been fully handed off; removing it early can cancel WebKit downloads.
    if (snapshot.status !== "interrupted") {
      const frame = frames.get(snapshot.id);
      frames.delete(snapshot.id);
      if (frame) setTimeout(() => frame.remove(), 4000);
    }
  }
}

function lastSnapshot(key: TaskKey): DownloadSnapshot {
  return latest.get(key.id) || (key.last ? { ...key.last, url: "" } : {
    id: key.id, transport: "browser_streaming", status: "queued", filename: key.filename,
    url: "", loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0,
  });
}

function interrupted(key: TaskKey): DownloadSnapshot {
  return { ...lastSnapshot(key), status: "interrupted", observation: undefined, speed: 0, error: "原下载任务已失效，请重新解析后下载" };
}

function unknown(key: TaskKey): DownloadSnapshot {
  return { ...lastSnapshot(key), observation: "unknown", speed: 0, error: "暂时无法获取进度，传输可能仍在继续；请勿重复启动" };
}

function fromWorker(snapshot: DownloadSnapshot, worker: ServiceWorker): DownloadSnapshot {
  return { ...snapshot, workerBuild: snapshot.workerBuild || workerBuilds.get(worker) || "legacy" };
}

/** A query never starts a fetch. Missing workers must not leave a frozen progress card. */
function watch(id: string): void {
  watched.add(id);
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (polling || !watched.size) return;
    polling = true;
    const current = [...watched].map(key => keys.get(key)).filter((key): key is TaskKey => Boolean(key));
    void (async () => {
      try {
        const worker = await workerFor(false);
        const reply = worker ? await rpc(worker, { action: "query", tasks: current.map(({ id, token }) => ({ id, token })) }) : {};
        const found = new Map((reply.snapshots || []).map(snapshot => [snapshot.id, fromWorker(snapshot, worker!)]));
        for (const key of current) if (watched.has(key.id)) notify(found.get(key.id) || interrupted(key));
      } catch {
        // A lost acknowledgement is not proof that the browser download stopped.
        for (const key of current) if (watched.has(key.id)) notify(unknown(key), false);
      } finally { polling = false; }
    })();
  }, 5000);
}

function listen(): void {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", event => {
    const data = event.data;
    const source = event.source as ServiceWorker | null;
    if (source?.scriptURL !== new URL("/downloads/worker.js", location.origin).href || data?.channel !== "dokitool-download" || data.protocol !== PROTOCOL || !keys.has(data.snapshot?.id)) return;
    notify(fromWorker(data.snapshot, source));
  });
}

function rpc(worker: ServiceWorker, message: object): Promise<WorkerReply> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = () => { clearTimeout(timer); channel.port1.close(); };
    const timer = setTimeout(() => { finish(); reject(new Error("下载服务应答超时，状态未知；请勿重复启动，刷新后检查任务")); }, 8000);
    channel.port1.onmessage = event => { finish(); event.data?.error ? reject(new Error(event.data.error)) : resolve(event.data); };
    try { worker.postMessage({ protocol: PROTOCOL, ...message }, [channel.port2]); }
    catch (error) { finish(); reject(error); }
  });
}

function bounded<T>(request: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("下载服务查询或注册超时")), 8000);
    request.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function workerFor(create: boolean): Promise<ServiceWorker | null> {
  if (typeof navigator === "undefined" || !globalThis.isSecureContext || !("serviceWorker" in navigator) || typeof MessageChannel === "undefined" || !globalThis.crypto?.randomUUID) {
    if (!create) return null;
    throw new StreamingUnavailableError("当前浏览器不支持流式下载");
  }
  try {
    let registration = await bounded(navigator.serviceWorker.getRegistration(SCOPE));
    if (registration && new URL(registration.scope).pathname !== SCOPE) registration = undefined;
    if (!registration && create) registration = await bounded(navigator.serviceWorker.register("/downloads/worker.js", { scope: SCOPE, type: "module", updateViaCache: "none" }));
    if (!registration) return null;
    if (registration.active && !checkedUpdates.has(registration.scope)) {
      checkedUpdates.add(registration.scope);
      // Check once per page without delaying an existing transfer. No skipWaiting:
      // the browser activates an update only when the old worker can retire safely.
      try { void registration.update?.().catch(() => {}); } catch { /* Offline update checks must not break downloads. */ }
    }
    let worker = registration.active;
    if (!worker && create) {
      const pending = registration.installing || registration.waiting;
      if (!pending) throw new Error("下载服务未激活");
      worker = await new Promise<ServiceWorker>((resolve, reject) => {
        const timer = setTimeout(() => { pending.removeEventListener("statechange", changed); reject(new Error("下载服务激活超时")); }, 8000);
        const changed = () => {
          if (pending.state === "activated") { clearTimeout(timer); pending.removeEventListener("statechange", changed); resolve(pending); }
          else if (pending.state === "redundant") { clearTimeout(timer); pending.removeEventListener("statechange", changed); reject(new Error("下载服务安装失败")); }
        };
        pending.addEventListener("statechange", changed); changed();
      });
    }
    if (!worker) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await rpc(worker, { action: "ping" });
        // An update can activate between selecting the worker and its ping reply.
        // Verify the currently active object before START, without replacing live tasks.
        if (worker.state === "redundant" || registration.active && registration.active !== worker) {
          throw new Error("下载服务正在更新，请稍后重试");
        }
        if (reply.protocol !== PROTOCOL) throw new Error("下载服务版本不兼容");
        workerBuilds.set(worker, reply.workerBuild || "legacy");
        listen();
        return worker;
      } catch (error) {
        const replacement = registration.active;
        if (attempt || !replacement || replacement === worker || replacement.state === "redundant") throw error;
        worker = replacement;
      }
    }
    return null;
  } catch (error) {
    if (!create) throw error;
    throw new StreamingUnavailableError(error instanceof Error ? error.message : "流式下载不可用");
  }
}

function subscribe(id: string, observer: DownloadObserver): () => void {
  const set = observers.get(id) || new Set<DownloadObserver>();
  set.add(observer); observers.set(id, set);
  return () => { set.delete(observer); if (!set.size) observers.delete(id); };
}

export async function downloadStreaming(request: DownloadRequest, signal: AbortSignal, onUpdate: DownloadObserver): Promise<DownloadSnapshot> {
  if (signal.aborted) throw abortError();
  const worker = await workerFor(true);
  if (signal.aborted) throw abortError();
  if (!worker) throw new StreamingUnavailableError("流式下载服务不可用");
  const key = { id: request.id, token: crypto.randomUUID().replaceAll("-", ""), filename: request.filename, savedAt: Date.now() };
  keys.set(key.id, key); saveKeys();
  latest.set(key.id, {
    ...lastSnapshot(key), status: "preparing", url: request.url,
    elapsed: Math.max(0, (Date.now() - (request.startedAt || Date.now())) / 1000),
    workerBuild: workerBuilds.get(worker) || "legacy",
  });
  return new Promise<DownloadSnapshot>((resolve, reject) => {
    let finished = false;
    const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", cancel); };
    const unsubscribe = subscribe(request.id, snapshot => {
      if (finished) return;
      onUpdate(snapshot);
      if (!terminal(snapshot)) return;
      finished = true; cleanup();
      snapshot.status === "completed" ? resolve(snapshot) : reject(snapshot.status === "cancelled" ? abortError() : new Error(snapshot.error || "下载中断"));
    });
    const cancel = () => {
      // An abort after START is not permission to launch another transport.
      void rpc(worker, { action: "cancel", id: key.id, token: key.token }).then(reply => { if (reply.snapshot) notify(fromWorker(reply.snapshot, worker)); }).catch(error => {
        if (!finished) {
          notify(unknown(key), false);
          const failure = new Error(error instanceof Error ? error.message : "无法确认取消结果，请检查浏览器下载列表");
          failure.name = "StreamingStateUnknownError";
          // Keep the observer attached for a late reply, even though the cancellation caller must be released.
          signal.removeEventListener("abort", cancel);
          reject(failure);
        }
      });
    };
    signal.addEventListener("abort", cancel, { once: true });
    // From this point even an ambiguous timeout is an ordinary error, never a Blob fallback.
    started.add(request.id);
    void rpc(worker, { action: "start", request, token: key.token }).then(reply => {
      if (finished) return;
      if (reply.snapshot) notify(fromWorker(reply.snapshot, worker));
      if (finished) return;
      if (signal.aborted) { cancel(); return; }
      if (!reply.downloadUrl?.startsWith(`/downloads/file/${key.id}/`)) throw new Error("下载服务返回了无效交付地址");
      const frame = document.createElement("iframe");
      frame.hidden = true; frame.title = "下载文件"; frame.referrerPolicy = "no-referrer"; frame.src = reply.downloadUrl;
      frames.set(request.id, frame); document.body.appendChild(frame);
      watch(request.id);
    }).catch(error => {
      if (!finished) {
        // START might have reached the worker. Keep its token for a subsequent refresh/query.
        notify(unknown(key), false); watch(request.id);
        const failure = new Error(error instanceof Error ? error.message : "下载启动状态未知，请检查浏览器下载列表");
        failure.name = "StreamingStateUnknownError";
        reject(failure);
      }
    });
  });
}

export async function reconnectStreaming(onUpdate: DownloadObserver): Promise<DownloadSnapshot[]> {
  const saved = readKeys();
  if (!saved.length) return [];
  for (const key of saved) { keys.set(key.id, key); subscribe(key.id, onUpdate); }
  let snapshots: DownloadSnapshot[];
  let confirmed = true;
  try {
    const worker = await workerFor(false);
    const reply = worker ? await rpc(worker, { action: "query", tasks: saved.map(({ id, token }) => ({ id, token })) }) : {};
    const found = new Map((reply.snapshots || []).map(snapshot => [snapshot.id, fromWorker(snapshot, worker!)]));
    snapshots = saved.map(key => found.get(key.id) || (key.result ? { ...key.result, url: "" } : interrupted(key)));
  } catch {
    confirmed = false;
    snapshots = saved.map(key => key.result ? { ...key.result, url: "" } : unknown(key));
  }
  for (const snapshot of snapshots) {
    notify(snapshot, confirmed || snapshot.observation !== "unknown");
    if (!terminal(snapshot)) { started.add(snapshot.id); watch(snapshot.id); }
  }
  return snapshots;
}

/** True only after START may have reached the worker, never during preparation/registration. */
export function hasStreamingTask(id: string): boolean { return started.has(id); }

export async function cancelStreaming(id: string): Promise<void> {
  const key = keys.get(id) || readKeys().find(item => item.id === id);
  if (!key) throw new Error("原下载任务已失效");
  try {
    const worker = await workerFor(false);
    if (!worker) { notify(interrupted(key)); throw new Error("原下载任务已失效"); }
    const reply = await rpc(worker, { action: "cancel", id, token: key.token });
    if (reply.snapshot) notify(fromWorker(reply.snapshot, worker));
  } catch (error) {
    if (started.has(id)) { notify(unknown(key), false); watch(id); }
    throw error;
  }
}

export async function forgetStreaming(id: string): Promise<void> {
  const key = keys.get(id) || readKeys().find(item => item.id === id);
  const worker = await workerFor(false);
  if (key && worker) await rpc(worker, { action: "forget", id, token: key.token });
  keys.delete(id); latest.delete(id); saveKeys(); observers.delete(id); watched.delete(id); uncertain.delete(id); started.delete(id);
  if (!watched.size) { clearInterval(pollTimer); pollTimer = undefined; }
  const frame = frames.get(id); frames.delete(id); frame?.remove();
}
