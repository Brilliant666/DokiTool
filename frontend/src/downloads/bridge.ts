/** A real controlled document keeps an updating worker responsible for its downloads.
 * Attachment responses do not create such a document. No media passes through this frame.
 */
const BRIDGE_URL = "/downloads/bridge.html";
const WORKER_URL = "/downloads/worker.js";
const held = new Set<string>();
let frame: HTMLIFrameElement | undefined;
let owner: ServiceWorker | undefined;
let connection: Promise<ServiceWorker> | undefined;
let abandon: (() => void) | undefined;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

export function retainBridge(id: string): void {
  held.add(id);
  clearTimeout(releaseTimer);
  releaseTimer = undefined;
}

export function releaseBridge(id: string): void {
  if (!held.delete(id) || held.size) return;
  const retiring = frame;
  // Match the attachment handoff grace period, including WebKit's delayed claim.
  releaseTimer = setTimeout(() => {
    if (held.size || frame !== retiring) return;
    abandon?.();
    frame?.remove();
    frame = undefined;
    owner = undefined;
    connection = undefined;
    releaseTimer = undefined;
  }, 4000);
}

export function connectBridge(): Promise<ServiceWorker> {
  if (frame?.isConnected && owner?.state === "activated") return Promise.resolve(owner);
  if (connection) return connection;
  frame?.remove();
  owner = undefined;
  const next = document.createElement("iframe");
  next.hidden = true;
  next.title = "下载连接";
  next.referrerPolicy = "no-referrer";
  next.src = BRIDGE_URL;
  frame = next;
  connection = new Promise<ServiceWorker>((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      next.removeEventListener("load", loaded);
      next.removeEventListener("error", failed);
      if (frame === next) abandon = undefined;
    };
    const fail = (message: string) => {
      clean();
      next.remove();
      if (frame === next) { frame = undefined; owner = undefined; connection = undefined; }
      reject(new Error(message));
    };
    const failed = () => fail("下载连接页面加载失败");
    const loaded = () => {
      try {
        const view = next.contentWindow;
        if (!view || view.location.href === "about:blank") return;
        if (view.location.href !== new URL(BRIDGE_URL, location.origin).href || !next.contentDocument?.getElementById("dokitool-download-bridge")) {
          fail("下载连接页面无效"); return;
        }
        // This controller proves the document is controlled. The caller must use
        // its own realm's registration.active for RPC so replies target the page,
        // and must not compare these cross-realm wrappers by object identity.
        const controller = view.navigator.serviceWorker.controller;
        if (!controller || controller.state !== "activated" || controller.scriptURL !== new URL(WORKER_URL, location.origin).href) {
          fail("下载连接未受下载服务控制"); return;
        }
        clean();
        owner = controller;
        connection = undefined;
        resolve(controller);
      } catch { fail("无法确认下载连接的控制关系"); }
    };
    const timer = setTimeout(() => fail("下载连接页面加载超时"), 8000);
    abandon = () => fail("下载连接已释放");
    next.addEventListener("load", loaded);
    next.addEventListener("error", failed);
    document.body.appendChild(next);
  });
  return connection;
}
