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

Worker `downloads-20261030.3` limits attachment response preparation to 120 seconds
in total, including the cross-tab slot queue and all source attempts. Expiry fails
that task explicitly, aborts its request and releases its slot; it never starts a
second transport. A third cross-tab task may therefore require manual retry after
the current transfers finish. The page manager's queue before START is unaffected.
This deadline is cleared when attachment headers are ready and does not limit the
duration of a streaming body. START messages finish after acknowledgement; neither
message nor fetch events wait for the whole file through `waitUntil`.

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
- The application-defined Worker network timeout applies to an outstanding
  upstream read or header wait (45 seconds), not downstream backpressure. Blob
  uses 30-second network waits. Neither defines a total-duration limit; browser
  event-lifetime limits are separate (see the acceptance blocker below).
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
a Worker with in-flight downloads. Worker build `downloads-20261030.3` is returned
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

### Matched-source investigation, 2026-10-30

The implementation under test is `bc8b448`, Worker `downloads-20261030.2`.
The baseline preview Worker is byte-identical to the tracked source. A private localhost
harness imports the unchanged transport modules; its raw and Worker-response
paths use the same browser, exact source URL, credentials, no-referrer policy and
`cache: no-store`. Both paths consume the response with a page reader and discard
the bytes. Runs are serial Raw / SW / SW / Raw. This isolates the SW data channel;
it does not measure the purple button's format probe, native downloads or disk IO.

| Source and consumer | Raw total seconds (two runs) | SW total seconds (two runs) | Raw read MiB/s | SW read MiB/s |
| --- | --- | --- | --- | --- |
| Edge, localhost 64 MiB fixture | 0.207 / 0.117 | 0.265 / 0.198 | 325.87 / 581.29 | 262.30 / 391.68 |
| In-app browser, one fresh Douyin CDN URL, 60,342,212 bytes | 7.138 / 9.968 | 7.018 / 5.698 | 9.37 / 5.90 | 8.48 / 10.50 |

Total seconds include preparation and first-byte wait. Read throughput starts at
the first actual reader chunk and ends at EOF. All four CDN transfers returned
HTTP 200 with the same URL fingerprint and length; this is not a content-hash
verification. Worker-reported CDN mean speed differs from reader timing by less
than 0.02%. The earlier saved CDN URL returned 403 and was excluded; one fresh
parse supplied the URL used for all four successful runs.

There is no stable SW slowdown in this small CDN sample. Two runs per path cannot
establish a performance ranking. The much faster localhost test shows possible
bridge/chunking overhead, but still transfers hundreds of MiB/s and cannot explain
the reported 447 KB/s on another CDN/video. No production buffering, concurrency,
cache policy or Range strategy was changed on this evidence.

Additional acceptance observations:

- Edge and the in-app browser both ended the native attachment connection before
  the complete fixture was sent. A direct user-clicked link to the same attachment
  in the in-app browser also ended early. The responsible browser/environment
  component is unconfirmed; this does not isolate the production iframe as the
  cause. Server write counters include socket buffering, not proven browser reads.
- In-app browser SW attachment delivery received a cancellation after 2 MiB of a
  64 MiB fixture, without a page cancel action. The Worker reported cancelled and
  released the source. A separate observation-only Worker run recorded
  `response-stream-cancel` at 1,179,648 bytes, rather than an RPC cancellation or
  request-signal abort. The reason the response consumer cancelled is unresolved.
  This verifies handling of an observed cancellation, not the untested browser
  download-manager Stop action.
- The actual purple button in the in-app browser selected Blob when the isolated
  Worker script returned 404, received all 65 MiB, and reported transfer completion.
  No matching file was found in the user's specified Downloads directory. Browser
  download-event collection also timed out; no pending Save As dialog was found.
  Blob final saving, as well as native/SW saving in this environment, remains
  unverified. Failed/cancelled delivery rows are excluded from throughput results.
- Earlier Chrome acceptance runs remain separate historical evidence; they do
  not turn these current in-app/browser saving outcomes into passes.

#### Release blocker: approximately five-minute SW interruption

A 32 MiB fixture sends 24 KiB every 250 ms, continuously, with the same source
URL and no-store policy. It takes about 356 seconds to finish. The following
long-running controls distinguish source availability from Worker lifetime:

| Path | Total seconds | Received bytes | Result |
| --- | ---: | ---: | --- |
| Original Worker, in-app browser | 300.074 | 28,237,824 | Network error |
| Original Worker, Edge | 305.368 | 28,729,344 | Network error |
| Direct Fetch, in-app browser | 356.551 | 33,554,432 | Complete |
| Private lifetime experiment, in-app browser | 356.505 | 33,554,432 | Complete |

Both original Worker runs were still receiving data near 94 KB/s when they
failed. This is not the application's 45-second idle-read timeout. Direct Fetch
completing the same source rules out a five-minute source cutoff in this fixture.

The original Worker waits for `task.settled` inside the START message event and
also adds it to the attachment fetch event's `waitUntil`. Chromium has a
[five-minute extended-event deadline](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/service_worker/service_worker_event_queue.h).
Its [response stream holds a separate stay-awake token](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/service_worker/fetch_respond_with_observer.cc)
while streaming. These implementation details and the matched controls strongly
identify the long-lived event binding as the cause of this reproduced failure.
Edge's slightly later failure does not establish its precise internal timing.

The private experiment removes only those two whole-transfer waits, adds stop
origin observations and a distinct build marker, and retains the same response
stream, cancellation, source reader, concurrency and buffering. It uses no new
keep-alive heartbeat. Its complete 356.505-second run validates that direction
for this fixture; it is not a production patch or completed download-manager
acceptance. Both waits were removed together, so their individual contributions
have not been isolated.

Before release, implement and review the lifetime change, then repeat actual
file saving, refresh recovery and cancellation. Also handle or explicitly bound
cross-tab tasks waiting over five minutes for a concurrency slot: `attachment()`
currently waits for that slot before returning its Response. The experiment does
not resolve this separate queued-fetch deadline. Closing pages, mobile lock
screens and Safari remain outside this result. This SW finding cannot explain
interruptions from a player's native download command, which bypasses this SW.

At this investigation checkpoint, PR #6 stayed draft, unmerged and undeployed.
The approximately five-minute interruption was a confirmed acceptance blocker;
final saving and browser-specific behaviors above remained unverified. This
investigation changed documentation only; the subsequent implementation is below.

### Lifetime correction, 2026-10-30

Worker `downloads-20261030.3` removes both whole-transfer event waits and the
unused settled promise. A single 120-second deadline bounds the attachment's
cross-tab queue plus all source preparation attempts. Returning the response
clears this deadline. Expiry reports failure, aborts the source and releases its
slot without changing transports or affecting other transfers. Streaming
concurrency, buffering, Range behavior and the confirmed UI remain unchanged.

- 157 frontend tests pass, including three new lifetime/deadline cases. Type
  checking, production build, four prerender checks and initial-load budgets pass.
  An independent review found no blocking implementation issue. A final wording
  correction clarifies that source preparation includes time already queued;
  all 29 Worker/client tests pass again after that correction.
- The actual `.3` candidate in the in-app browser completed the paced 32 MiB
  response in 356.3621 seconds, receiving all 33,554,432 bytes. Its source log
  independently records a complete response. This crosses the former failure
  point while another task times out in the queue and a second stream is cancelled.
  The run preceded only the final preparation-error wording correction; that
  correction changes no transfer or lifetime logic. This is response-stream
  acceptance, not a saved-file hash check.
- In-app browser, two active responses occupying both slots: a third cross-tab
  attachment failed after 120.0195 seconds with zero bytes and no source GET.
  Both existing streams continued. Cancelling the second stream closed its source
  connection; a deliberate retry of the third task then received its complete
  3,001-byte fixture. This is page/response cancellation, not a download-manager
  Stop test. No automatic retry or transport fallback occurred.
- A separate 3,001-byte static attachment baseline bypasses all DokiTool download
  modules. In the in-app browser, the local server wrote the complete response,
  but no matching file appeared in the specified Downloads directory. Chrome's
  direct link visibly returned `ERR_BLOCKED_BY_CLIENT`. No browser permission or
  security setting was changed. This confirms a Chrome client block for that
  baseline, without identifying the responsible component or proving the cause
  of the in-app browser's missing file. Final saving remains unverified.

The reproduced long-response lifetime defect and queue boundary are fixed and
verified at the stream layer. PR #6 remains draft, unmerged and undeployed until
actual saving, download-manager Stop, refresh recovery on this final version,
active Worker upgrades and mobile/browser-lifecycle acceptance are resolved.
