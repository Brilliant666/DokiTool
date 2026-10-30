# Browser download delivery

The existing download button resolves the selected work, episode and source before
handing a complete file to `frontend/src/downloads/manager.ts`. Layout and parser
APIs are unchanged. Ordinary CDN files travel directly to the user's browser.
Weibo's signed `/api/media/weibo` route remains a server relay when required.

## Policy and modules

1. `native.ts`: visible attachment headers and a safe filename with the correct
   media extension establish eligibility. Video format detection shares its
   complete HTTP 200 GET response with this check: it reads the first chunk, then
   cancels. Partial, failed, opaque or non-media responses cannot supply a cached
   decision. Other entry points use a three-second GET probe. Hidden or unavailable
   headers mean unknown eligibility.
   Qualified attachments use a hidden, sandboxed iframe, avoiding an asynchronous
   popup. The server chooses the actual filename. Status is **handed off**, never
   verified completion; the iframe remains until the document is destroyed because
   native completion cannot be observed safely.
2. `streaming.ts` and `public/downloads/worker.js`: other readable complete files
   use a download-only Service Worker. It supplies an attachment filename and
   forwards bytes with backpressure; it never buffers the entire file. Only the
   `/downloads/` scope is controlled, not the application or API. Sources still
   require CORS; no new proxy is introduced.
3. `blob.ts`: a compatibility path only when streaming capability is definitely
   unavailable before START. There is no fixed file-size cutoff; unknown or encoded
   lengths can download without fabricated percentages. Known decoded lengths are
   still checked. One Blob transfer runs per page, and object URLs retain the
   existing four-second release delay. Chunks are released after success/failure;
   allocation or delivery errors do not retry the whole file on other routes.
   CORS errors, source failures and ambiguous START acknowledgements never silently
   fall back to Blob. Blob still buffers the complete file in the browser.

`file.ts` owns common URL, media type, filename and network-wait rules. The manager
limits preparation/transfers to two concurrent tasks per page, the Worker also
limits transfers across tabs to two, and Blob has its stricter memory queue.
Native transfers leave application control and cannot count toward an observable
browser-wide concurrency budget.

## Ownership, recovery and failure

- Every attempt receives a distinct task ID. The Worker requires a random ownership
  token and a same-origin client. Tokens and small task summaries live in
  sessionStorage for at most 24 hours; saved summaries omit signed CDN URLs.
- Refresh queries the existing Worker, re-subscribes and permits cancellation. It
  never starts another GET to simulate recovery. Missing tasks are interrupted;
  temporary communication failure preserves the latest progress and active state,
  shows unknown observation, and can recover on a later reply. Saved progress omits
  signed URLs and is throttled to at most one sessionStorage write per five seconds.
- A source can change to one of up to three frozen, equivalent alternatives only
  before the attachment response starts. After delivery starts, a stream error
  fails that attempt. There is no automatic cross-source Range resume or byte
  splicing. Retrying creates a new task; matching resolution is not proof of byte
  identity.
- The Worker times out only an outstanding upstream read or header wait (45 seconds),
  not time spent waiting on downstream backpressure. Blob uses 30-second network
  waits. Neither is a total-duration limit.
- The attachment Request abort signal and response-stream cancellation both stop
  the task and release its queue slot. Fifteen seconds without downstream demand
  reports stalled observation without cancelling a normal browser pause. If the
  browser exposes neither cancellation event, the page cannot confirm a stop;
  explicit cancellation remains available. Two simultaneous transfers remain the
  limit; no speculative replacement transfer is started.
- HTTP 206/Content-Range are not accepted as complete files. Known length, empty
  bodies and media/error-page responses are checked. Unknown source length remains
  unknown in the UI. Stream completion means bytes were handed to the browser,
  not independently verified disk persistence.
- Manual opening of a source is available only after confirmed failure,
  cancellation or loss of the original task. It is absent from active/uncertain
  cards; a stale click cannot cancel the running transfer or create a second one.
- Total elapsed time starts at the user's click. Transfer duration and average
  speed start at byte delivery, excluding preparation/queue waits. Instantaneous
  speed is smoothed; metrics describe stream delivery, not verified disk writes.
- Bilibili lazy episode selection, segmented/HLS merging and ZIP assembly keep
  their existing pipelines. ZIP and segmented downloads are not claimed to be
  streaming or refresh-resumable by this change.

## Deployment

Publish `frontend/dist/downloads/worker.js` along with the build. Apply the
`/downloads/*` static-file block in `ops/examples/snap.caddy`: use revalidation
(`Cache-Control: no-cache`), correct JavaScript MIME, and **404 for missing files**.
Do not route a missing Worker or `/downloads/file/*` to the SPA. The latter URL is
answered by an active Worker only. HTTPS (or localhost) is required.

The client checks `registration.update()` once per page without blocking an active
Worker. There is no forced `skipWaiting`; installing a new version must not replace
a Worker with in-flight downloads. Worker build `downloads-20261030.2` is returned
by ping/query/progress and exposed as `data-worker-build` on download cards; an old
Worker without a build marker is labelled `legacy` in this diagnostic attribute.
Bump BUILD when changing Worker behavior. Legacy statistics keep their original
meaning until that Worker retires. Future protocol-breaking updates need a
migration plan. The download modules load on demand; an empty-history homepage
does not register a Worker or load its client.

## Acceptance

Automated tests cover native eligibility, serial Blob, delivery selection,
concurrency, cancellation, Worker streams, first-byte failover, truncation, token
ownership, missing tasks, uncertain acknowledgements, late completion and refresh
queries. Existing UI tests retain selection, Bilibili, Weibo and ZIP regressions.
These tests are not a substitute for browser-managed file saving.

Before release, check actual saved bytes/name/playability in Chrome, Edge and iOS
Safari/WeChat; first registration, refresh during transfer, cancellation after
refresh, slow sources, disconnects, old/new Worker versions and both fallback paths.
Closing a browser or OS suspension is not guaranteed to preserve a transfer.

### Initial PR acceptance, before revision, 2026-10-30

- 126 frontend tests pass, including transport selection, bounded Blob, Worker
  recovery, duplicate prevention while status is unknown, and cancellation racing
  completion. Type checking, production build and four prerender checks pass.
- Chrome: a controlled cross-origin 32 MiB MP4 was saved with the requested
  filename and SHA-256 matching the fixture. A refresh during transfer continued
  the same upstream GET; the completed file still matched. Refresh then cancel
  stopped that request before completion.
- Chrome: the production API response for the original Douyin sample was loaded
  into the local production preview. The browser fetched the real CDN directly,
  saving a 60,342,212-byte MP4 under its work title. File inspection found HEVC
  2160 x 3840, AAC, duration 9.15 seconds. This checks local delivery against a real
  CDN response; it is not an acceptance run of a deployed new frontend.
- Edge: first registration, streaming, refresh recovery and transfer completion
  were observed with the controlled source. The saved file location was not
  confirmed, so disk persistence is still unverified there.
- Native attachment qualification and handoff pass automated checks. Actual
  native saving remains unverified: the browser test produced
  `ERR_BLOCKED_BY_CLIENT`, and the attachment GET ended before receiving bytes.
  The source of the client block is undetermined. Browser settings were not
  changed, and uncertain handoff does not trigger another SW/Blob download.
- Still pending: native disk saving in an unblocked browser, real-browser Blob
  fallback, iOS Safari/WeChat, closing the page/browser, OS suspension, and a
  deployed old/new Worker upgrade with active downloads. Slow-source testing used
  a controlled HTTP server, not CDP network/CPU throttling.

### Seven-issue revision acceptance, 2026-10-30

- 154 frontend tests pass. Type checking, production build, all four prerender
  checks, initial-load budgets and the 156-file public inventory pass. Regression
  coverage includes request-abort cancellation, queue release, stalled readers,
  uncertain queries retaining progress, late cancellation replies, Worker update
  races, probe reuse, unknown-size Blob and a real 65 MiB Blob in the test runtime.
- Chrome production preview, controlled cross-origin 32 MiB MP4: the active card
  reports `browser_streaming` and Worker `downloads-20261030.2`. Refresh retained
  progress and the same source GET. Page cancellation closed that GET at
  17,301,504 bytes; a manual retry transferred all 33,554,432 bytes. No source-link
  shortcut was visible while active; it appeared after confirmed cancellation.
- Chrome production preview, separate origin with the Worker script deliberately
  returning 404: the purple button selected `browser_blob` before any SW START.
  It received all 68,157,440 bytes (65 MiB) and handed off the named file. The media
  log shows one early-closed inspection GET and one full delivery GET, with no
  extra native qualification fetch. This revision verified browser delivery and
  UI completion; the resulting saved file location/hash was not independently
  verified. No browser security or permission settings were changed.
- The local source uses controlled pacing. These observations are not a CDN
  bandwidth comparison. SW concurrency, buffering, single-GET transfer and Range
  behavior are unchanged; throughput tuning waits for matched-source evidence.
- Still unverified for this revision: stopping from the browser download manager
  (page cancellation is a different action), native saving, final Blob disk
  persistence, Edge/iOS Safari/WeChat, page/browser closure, OS suspension, and a
  deployed Worker upgrade with active downloads. Request-abort/stream-cancel and
  update-race tests establish code behavior, not every browser's signal delivery.

PR #6 remains draft, unmerged and undeployed while the outstanding browser
acceptance items remain visible for review.
