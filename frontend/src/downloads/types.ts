/** Complete files only. Playlists, muxing and archives keep their own pipelines. */
export type DownloadTransport = "browser_native" | "browser_streaming" | "browser_blob";
export type DeliveryStatus = "queued" | "preparing" | "downloading" | "completed" | "failed" | "cancelled" | "handed-off" | "interrupted";

export interface DownloadRequest {
  id: string;
  url: string;
  routes: string[];
  filename: string;
}

export interface DownloadSnapshot {
  id: string;
  transport: DownloadTransport;
  status: DeliveryStatus;
  filename: string;
  url: string;
  loaded: number;
  total: number;
  speed: number;
  elapsed: number;
  averageSpeed: number;
  error?: string;
}

export type DownloadObserver = (snapshot: DownloadSnapshot) => void;

export class StreamingUnavailableError extends Error {
  readonly safeToFallback = true;
  constructor(message: string) { super(message); this.name = "StreamingUnavailableError"; }
}
