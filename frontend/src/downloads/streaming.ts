import { type DownloadObserver, type DownloadRequest, type DownloadSnapshot } from "./types";
import { releaseBridge, retainBridge } from "./bridge";
import { existingWorker, PROTOCOL, rpc, WorkerRequestError, workerSession, type WorkerSession } from "./session";

const STORAGE_KEY = "dokitool-downloads-v1";
type SavedSnapshot = Omit<DownloadSnapshot, "url">;
interface TaskKey { id: string; token: string; filename: string; savedAt: number; cancelRequested?: boolean; last?: SavedSnapshot; result?: SavedSnapshot }
interface TaskRecord {
  key: TaskKey;
  snapshot: DownloadSnapshot;
  owner?: WorkerSession;
  confirmed: boolean;
  uncertain: boolean;
  cancelRequested: boolean;
  cancellation?: Promise<void>;
  observers: Set<DownloadObserver>;
  frame?: HTMLIFrameElement;
}
const tasks = new Map<string, TaskRecord>();
let savedProgressAt = 0;
let listening = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let polling = false;
const terminal = (snapshot: DownloadSnapshot) => ["completed", "failed", "cancelled", "interrupted"].includes(snapshot.status);
const abortError = () => new DOMException("下载已取消", "AbortError");
const pending = () => [...tasks.values()].filter(task => !terminal(task.snapshot));

function readKeys(): TaskKey[] {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return retained(saved.filter(item => item && typeof item.id === "string" && typeof item.token === "string" && typeof item.filename === "string" && Number.isFinite(item.savedAt)));
  } catch { return []; }
}

function retained(records: TaskKey[]): TaskKey[] {
  // A long transfer must survive any number of later completed downloads.
  return [...records.filter(key => !key.result),
    ...records.filter(key => key.result && Date.now() - key.savedAt < 24 * 60 * 60_000)
      .sort((a, b) => a.savedAt - b.savedAt).slice(-100)];
}

function saveTasks(): void {
  const records = [...tasks.values()].map(({ key, snapshot, confirmed, cancelRequested }) => {
    const { url: _url, ...last } = snapshot;
    return { id: key.id, token: key.token, filename: snapshot.filename, savedAt: key.savedAt, ...(cancelRequested ? { cancelRequested: true } : {}),
      ...(confirmed ? { last, ...(terminal(snapshot) ? { result: last } : {}) } : {}) };
  });
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(retained(records))); } catch { /* Storage restrictions do not stop an active transfer. */ }
}

function record(key: TaskKey): TaskRecord {
  const saved = key.result || key.last;
  return { key, confirmed: !!saved, uncertain: false, cancelRequested: key.cancelRequested === true, observers: new Set(), snapshot: saved ? { ...saved, url: "" } : {
    id: key.id, transport: "browser_streaming", status: "queued", filename: key.filename,
    url: "", loaded: 0, total: 0, speed: 0, elapsed: 0, averageSpeed: 0,
  } };
}

function visible(task: TaskRecord): DownloadSnapshot {
  const cancelling = task.cancelRequested && !terminal(task.snapshot);
  return task.uncertain || cancelling ? { ...task.snapshot, observation: "unknown", speed: 0,
    error: cancelling ? "正在确认取消结果，请勿重复启动" : "暂时无法获取进度，传输可能仍在继续；请勿重复启动" } : task.snapshot;
}

function emit(task: TaskRecord): void {
  for (const observer of task.observers) observer(visible(task));
}

function unknown(task: TaskRecord): void {
  if (terminal(task.snapshot)) return;
  task.uncertain = true;
  emit(task);
}

function deliver(task: TaskRecord, url: string): void {
  if (task.frame || task.cancelRequested || terminal(task.snapshot)) return;
  const expected = `/downloads/file/${task.key.id}/${task.key.token}`;
  if (url !== expected) throw new Error("下载服务返回了无效交付地址");
  const frame = document.createElement("iframe");
  frame.hidden = true; frame.title = "下载文件"; frame.referrerPolicy = "no-referrer"; frame.src = url;
  task.frame = frame;
  document.body.appendChild(frame);
}

/** One reducer handles push, query and START replies. Terminal outcomes are absorbing. */
function accept(task: TaskRecord, snapshot: DownloadSnapshot): void {
  if (tasks.get(task.key.id) !== task || terminal(task.snapshot)) return;
  const previous = task.snapshot;
  if (snapshot.revision !== undefined && previous.revision !== undefined) {
    if (snapshot.revision < previous.revision) return;
  } else if (!terminal(snapshot)) {
    // Workers installed before admission/revisions remain usable until they retire.
    const phase = { queued: 0, preparing: 1, downloading: 2 };
    if (snapshot.loaded < previous.loaded || (phase[snapshot.status as keyof typeof phase] ?? 0) < (phase[previous.status as keyof typeof phase] ?? 0)) return;
  }
  task.snapshot = { ...snapshot, workerBuild: snapshot.workerBuild || task.owner?.build || "legacy" };
  task.confirmed = true;
  task.uncertain = false;
  if (terminal(snapshot)) {
    task.key.savedAt = Date.now();
    releaseBridge(task.key.id);
    // Preserve the browser's final attachment handoff, particularly on WebKit.
    if (task.frame && snapshot.status !== "interrupted") {
      const frame = task.frame;
      setTimeout(() => frame.remove(), 4000);
    }
    saveTasks();
    if (!pending().length) { clearInterval(pollTimer); pollTimer = undefined; }
  } else {
    if (Date.now() - savedProgressAt >= 5000) { savedProgressAt = Date.now(); saveTasks(); }
    if (task.owner?.admission && snapshot.delivery === "ready") deliver(task, `/downloads/file/${task.key.id}/${task.key.token}`);
    watch();
  }
  emit(task);
}

function interrupted(task: TaskRecord): void {
  accept(task, { ...task.snapshot, status: "interrupted", observation: undefined, speed: 0, error: "原下载任务已失效，请重新解析后下载" });
}

/** Bind once; a newly installed worker must never take ownership of a live task. */
async function ownerFor(task: TaskRecord): Promise<WorkerSession | null> {
  if (task.owner) return task.owner;
  retainBridge(task.key.id);
  const owner = await workerSession(false);
  if (owner) task.owner = owner;
  return owner;
}

async function observe(current: TaskRecord[]): Promise<void> {
  const groups = new Map<WorkerSession, TaskRecord[]>();
  await Promise.all(current.map(async task => {
    try {
      const owner = await ownerFor(task);
      if (!owner || owner.worker.state === "redundant") { interrupted(task); return; }
      const group = groups.get(owner) || [];
      group.push(task); groups.set(owner, group);
    } catch { unknown(task); }
  }));
  await Promise.all([...groups].map(async ([owner, group]) => {
    try {
      const reply = await rpc(owner.worker, { action: "query", tasks: group.map(({ key: { id, token } }) => ({ id, token })) });
      const found = new Map((reply.snapshots || []).map(snapshot => [snapshot.id, snapshot]));
      const cancellations: Promise<void>[] = [];
      for (const task of group) {
        const snapshot = found.get(task.key.id);
        snapshot ? accept(task, snapshot) : interrupted(task);
        if (task.cancelRequested && !terminal(task.snapshot)) cancellations.push(cancel(task).catch(() => {}));
      }
      await Promise.all(cancellations);
    } catch {
      for (const task of group) owner.worker.state === "redundant" ? interrupted(task) : unknown(task);
    }
  }));
}

function watch(): void {
  if (pollTimer || !pending().length) return;
  pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void observe(pending()).finally(() => { polling = false; });
  }, 5000);
}

function listen(): void {
  if (listening) return;
  listening = true;
  navigator.serviceWorker.addEventListener("message", event => {
    const { data, source } = event;
    if (data?.channel !== "dokitool-download" || data.protocol !== PROTOCOL) return;
    const task = tasks.get(data.snapshot?.id);
    if (!task?.owner || source !== task.owner.worker) return;
    if (task.owner.build !== "legacy" && data.snapshot.workerBuild && data.snapshot.workerBuild !== task.owner.build) return;
    accept(task, data.snapshot);
  });
}

function subscribe(task: TaskRecord, observer: DownloadObserver): () => void {
  task.observers.add(observer);
  return () => { task.observers.delete(observer); };
}

function cancel(task: TaskRecord): Promise<void> {
  if (terminal(task.snapshot)) return Promise.resolve();
  // Intent stops an unclaimed attachment immediately; only the Worker confirms
  // the transfer outcome. Preserve intent across refresh and lost replies.
  if (!task.cancelRequested) { task.cancelRequested = true; saveTasks(); emit(task); }
  task.cancellation ??= (async () => {
    try {
      const owner = await ownerFor(task);
      if (!owner || owner.worker.state === "redundant") { interrupted(task); throw new Error("原下载任务已失效"); }
      const reply = await rpc(owner.worker, { action: "cancel", id: task.key.id, token: task.key.token });
      if (reply.snapshot) accept(task, reply.snapshot);
    } catch (error) {
      unknown(task); watch();
      throw error;
    }
  })().finally(() => { task.cancellation = undefined; });
  return task.cancellation;
}

export async function downloadStreaming(request: DownloadRequest, signal: AbortSignal, onUpdate: DownloadObserver): Promise<DownloadSnapshot> {
  if (signal.aborted) throw abortError();
  retainBridge(request.id);
  let owner: WorkerSession;
  try {
    const selected = await workerSession(true);
    if (signal.aborted) throw abortError();
    if (!selected) throw new Error("下载服务未就绪，请重试");
    owner = selected;
  } catch (error) { releaseBridge(request.id); throw error; }
  listen();
  const task = record({ id: request.id, token: crypto.randomUUID().replaceAll("-", ""), filename: request.filename, savedAt: Date.now() });
  task.owner = owner;
  task.snapshot = { ...task.snapshot, url: request.url, workerBuild: owner.build,
    elapsed: Math.max(0, (Date.now() - (request.startedAt || Date.now())) / 1000) };
  tasks.set(request.id, task); saveTasks();
  return new Promise<DownloadSnapshot>((resolve, reject) => {
    let finished = false;
    const cleanup = () => { unsubscribe(); signal.removeEventListener("abort", onAbort); };
    const unsubscribe = subscribe(task, snapshot => {
      if (finished) return;
      onUpdate(snapshot);
      if (!terminal(snapshot)) return;
      finished = true; cleanup();
      snapshot.status === "completed" ? resolve(snapshot) : reject(snapshot.status === "cancelled" ? abortError() : new Error(snapshot.error || "下载中断"));
    });
    const onAbort = () => {
      void cancel(task).catch(error => {
        if (!finished) {
          signal.removeEventListener("abort", onAbort);
          reject(stateUnknown(error));
        }
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // The record and owner exist before START: a ready push may precede its ACK.
    void rpc(owner.worker, { action: "start", request, token: task.key.token, ...(owner.admission ? { admission: true } : {}) }).then(reply => {
      if (reply.snapshot) accept(task, reply.snapshot);
      if (finished) return;
      if (signal.aborted) { onAbort(); return; }
      if (!owner.admission) deliver(task, reply.downloadUrl || "");
      watch();
    }).catch(error => {
      if (finished) return;
      if (error instanceof WorkerRequestError) {
        accept(task, { ...task.snapshot, status: "failed", speed: 0, error: error.message });
      } else if (!task.confirmed) {
        // A lost ACK is not permission to re-START or launch a second transport.
        unknown(task);
        watch();
        reject(stateUnknown(error));
      }
    });
  });
}

function stateUnknown(error: unknown): Error {
  const failure = new Error(error instanceof Error ? error.message : "下载状态未知，请检查浏览器下载列表");
  failure.name = "StreamingStateUnknownError";
  return failure;
}

export async function reconnectStreaming(onUpdate: DownloadObserver): Promise<DownloadSnapshot[]> {
  const restored = readKeys().map(key => {
    const task = tasks.get(key.id) || record(key);
    tasks.set(key.id, task);
    subscribe(task, onUpdate);
    if (terminal(task.snapshot)) emit(task); else retainBridge(key.id);
    return task;
  });
  if (!restored.length) return [];
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) listen();
  await observe(restored.filter(task => !terminal(task.snapshot)));
  watch();
  return restored.map(visible);
}

/** A record exists only after START may be sent, never during connection setup. */
export function hasStreamingTask(id: string): boolean {
  const task = tasks.get(id);
  return !!task && !terminal(task.snapshot);
}

export async function cancelStreaming(id: string): Promise<void> {
  const task = tasks.get(id);
  if (!task) throw new Error("原下载任务已失效");
  if (!terminal(task.snapshot)) await cancel(task);
}

export async function forgetStreaming(id: string): Promise<void> {
  const task = tasks.get(id);
  const key = task?.key || readKeys().find(item => item.id === id);
  if (task ? !terminal(task.snapshot) : key && !key.result) throw new Error("请先确认下载已停止，再清除任务");
  if (key) {
    let worker = task?.owner?.worker;
    try {
      worker ||= await existingWorker() || undefined;
      if (worker && worker.state !== "redundant") await rpc(worker, { action: "forget", id, token: key.token });
    } catch (error) {
      if (error instanceof WorkerRequestError && worker?.state !== "redundant") throw error;
      // Confirmed summaries can be cleared locally if the old worker has retired.
      // Worker history expires independently and does not consume active capacity.
    }
  }
  tasks.delete(id); saveTasks(); releaseBridge(id);
  task?.frame?.remove();
}
