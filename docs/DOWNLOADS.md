# Browser download delivery

The existing download button resolves the selected work, episode and source before
handing a complete file to `frontend/src/downloads/manager.ts`. Layout and parser
APIs are unchanged. Ordinary CDN files travel directly to the user's browser.
Weibo's signed `/api/media/weibo` route remains a server relay when required.

## Policy and modules

1. `native.ts`: a single GET, bounded to three seconds, checks visible attachment
   headers and a safe filename with the correct media extension. Its body is
   cancelled immediately. Hidden or unavailable headers mean unknown eligibility.
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
   unavailable before START. Known file length must be at most **64 MiB**; actual
   received bytes also enforce this limit. Unknown lengths are refused. One Blob
   transfer runs per page, and object URLs retain the existing four-second release
   delay. CORS errors, source failures and ambiguous START acknowledgements never
   silently fall back to Blob.

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
  temporary communication failure remains unknown and can recover on a later reply.
- A source can change to one of up to three frozen, equivalent alternatives only
  before the attachment response starts. After delivery starts, a stream error
  fails that attempt. There is no automatic cross-source Range resume or byte
  splicing. Retrying creates a new task; matching resolution is not proof of byte
  identity.
- The Worker times out only an outstanding upstream read or header wait (45 seconds),
  not time spent waiting on downstream backpressure. Blob uses 30-second network
  waits. Neither is a total-duration limit.
- HTTP 206/Content-Range are not accepted as complete files. Known length, empty
  bodies and media/error-page responses are checked. Unknown source length remains
  unknown in the UI. Stream completion means bytes were handed to the browser,
  not independently verified disk persistence.
- Manual opening of a source remains available. For an active/uncertain Worker
  transfer it first confirms cancellation, then asks for a second real click to
  open the source. This avoids duplicate transfers and popup activation problems.
- Bilibili lazy episode selection, segmented/HLS merging and ZIP assembly keep
  their existing pipelines. ZIP and segmented downloads are not claimed to be
  streaming or refresh-resumable by this change.

## Deployment

Publish `frontend/dist/downloads/worker.js` along with the build. Apply the
`/downloads/*` static-file block in `ops/examples/snap.caddy`: use revalidation
(`Cache-Control: no-cache`), correct JavaScript MIME, and **404 for missing files**.
Do not route a missing Worker or `/downloads/file/*` to the SPA. The latter URL is
answered by an active Worker only. HTTPS (or localhost) is required.

There is no forced `skipWaiting`; installing a new version must not replace a
Worker with in-flight downloads. Future protocol-breaking updates need a migration
plan. The download modules load on demand; an empty-history homepage does not
register a Worker or load its client.

## Acceptance

Automated tests cover native eligibility, bounded Blob, delivery selection,
concurrency, cancellation, Worker streams, first-byte failover, truncation, token
ownership, missing tasks, uncertain acknowledgements, late completion and refresh
queries. Existing UI tests retain selection, Bilibili, Weibo and ZIP regressions.
These tests are not a substitute for browser-managed file saving.

Before release, check actual saved bytes/name/playability in Chrome, Edge and iOS
Safari/WeChat; first registration, refresh during transfer, cancellation after
refresh, slow sources, disconnects, old/new Worker versions and both fallback paths.
Closing a browser or OS suspension is not guaranteed to preserve a transfer.

### Local production-build acceptance, 2026-10-30

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

The PR stays draft until the release-blocking native/Edge/mobile browser checks
are resolved or explicitly accepted for the initial desktop release.
