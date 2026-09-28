# AF6 Studio: Implementation Architecture

AF6 Studio is an AI-assisted video production studio. The narration is the
master timeline: every scene, visual, caption and music cue hangs off the
measured timing of the narration audio.

```
input → script analysis → (optional research) → script/narration → actual TTS duration
      → scene segmentation → visual planning → asset generation → timeline assembly
      → captions / music / SFX → QA → rendering → package
```

The system is **not** built as `prompt → random clips → concatenate`.

---

## 1. Repository survey (starting point)

The repository was empty when this work began: no commits, framework,
dependencies, database, auth, env vars or media tooling. The product
specification referenced in the build request was not attached, so the build
request itself is the working specification. Everything below is a new
decision. These are the facts about the environment:

| Concern | Finding | Decision |
|---|---|---|
| Runtime | Node 22 available | TypeScript on Node 22 (ESM) |
| Database | PostgreSQL 16 binaries available | PostgreSQL + Drizzle ORM + SQL migrations |
| Queue infra | Redis available, but not required | Durable queue **inside Postgres** (`FOR UPDATE SKIP LOCKED`). Queue state and domain state share transactions, so no second datastore is needed. |
| Media | No ffmpeg by default | `ffmpeg`/`ffprobe` are a system requirement (checked on boot) |
| Auth | None | Phase 1 is a single-operator local studio bound to localhost. See Known limitations. |

## 2. Process topology

```
┌─────────────────────┐   /api (JSON)   ┌────────────────────┐      ┌────────────────┐
│ Web (React + Vite)  │ ──────────────▶ │ API (Fastify)      │ ───▶ │ PostgreSQL     │
│ desktop-first SPA   │ ◀────────────── │ validates, enqueues│ ◀─── │ domain + jobs  │
└─────────────────────┘  poll state     └────────────────────┘      └──────┬─────────┘
                                                                           │ claim/lease
                                         ┌────────────────────┐            │
                                         │ Worker (N slots)   │ ◀──────────┘
                                         │ job handlers       │ ──▶ Provider adapters (mock | real)
                                         │ ffmpeg render      │ ──▶ Storage (local FS; S3-ready interface)
                                         └────────────────────┘
```

* **The API never runs long work.** HTTP handlers validate input, check state
  machine preconditions and budget, write a `jobs` row, and return `202` with
  the job. Anything slow (LLM calls, TTS, generation polling, ffmpeg) runs in
  the worker.
* **The worker** is a separate process (`src/worker/main.ts`) with a configurable
  number of concurrent slots. Several workers can run at once because claims
  use `SKIP LOCKED`.
* **The browser** holds no authoritative state. Every screen is derived from
  `GET /api/projects/:id`, which is polled faster while jobs are active.
  Routes are URL-addressable (`/projects/:id/storyboard`), so a refresh
  restores the exact view.

## 3. Code layout

```
src/
  shared/            # imported by server, worker AND web (no Node APIs)
    schemas.ts       # zod schemas: recipes, script, visual plan, timeline, captions, QA, API DTOs
    stateMachines.ts # pure project + scene transition functions
    constants.ts
  server/
    main.ts          # API entry
    app.ts           # Fastify app factory (used by tests via inject())
    config.ts        # env parsing (zod), secrets stay server-side
    db/              # drizzle schema, client, migrate, seed
    errors.ts        # AppError taxonomy → HTTP mapping
    routes/          # thin HTTP layer
    services/        # deterministic domain logic (segmentation, captions, timeline, QA, costs, budget)
    queue/           # durable Postgres job queue (enqueue, claim, heartbeat, retry, backoff, timeout)
    jobs/            # job handlers (one per job type) + registry
    providers/       # adapter interfaces, registry, mock providers, stubs for real providers
    llm/             # structured-output runner (JSON extraction → zod validation → repair retry)
    media/           # ffmpeg/ffprobe wrappers, WAV synthesis, renderer, packager
    storage/         # StorageAdapter interface + local filesystem implementation
  worker/main.ts     # worker entry
web/                 # React SPA (Vite, Tailwind v4, TanStack Query, React Router)
drizzle/             # generated SQL migrations
tests/               # vitest unit + integration; tests/e2e acceptance
scripts/             # UI smoke test (Playwright), utilities
```

## 4. Data model (PostgreSQL)

| Table | Purpose |
|---|---|
| `recipes` | Channel Recipes: format, pacing, scene length bounds, style, default providers/models per capability, captions, music, script structure. Built-ins are seeded; users can duplicate and edit them. |
| `projects` | One video. Holds `status` (project state machine), a frozen `recipe_snapshot`, validated `script`, narration timing, captions, music settings, `timeline`, `qa_report`, budget and `last_error`. |
| `scenes` | Ordered scenes. Timing comes from narration word timestamps (`start_sec`/`end_sec`). Also holds narration slice, visual brief, prompt, provider/model, references, `status` (scene state machine), `locked`, `selected_asset_id`, `quality_status`. |
| `generations` | Every provider request: kind, provider, model, prompt, params, `external_id`, status, progress, deadline, output asset, estimated and actual cost. This is what makes generation resumable: a restarted worker polls the existing `external_id` and never resubmits. |
| `assets` | Every file: images, videos, narration, music, uploads, renders, packages. Records storage key, mime, size, probed duration and dimensions. |
| `jobs` | Durable queue: type, payload, status, priority, `run_at`, attempts / max attempts, lease (`locked_by`, `locked_until`), timeout, progress, error, result, `dedupe_key` (partial unique index on active jobs). |
| `cost_entries` | Cost ledger: estimate and actual rows per generation, with provider, model, units, unit cost and amount. |
| `settings` | Key/value runtime settings, such as mock provider simulation (latency, failure rate, timeout rate) and the default budget. |
| `mock_provider_tasks` | The mock provider's own "remote" task store. It lets the mock behave like a real async API that survives worker restarts. |

## 5. State machines (pure, unit tested — `src/shared/stateMachines.ts`)

### Project

Stable stages, in order:
`draft → scripted → narrated → segmented → planned → assets_ready → assembled → qa_passed | qa_failed → rendered`

Busy stages: `scripting`, `narrating`, `segmenting`, `planning`, `producing`,
`qa_running`, `rendering`.

`nextProjectStatus(current, event)` is the only way status changes.

* A `*_START` event is allowed only when the project has reached the step's
  prerequisite stage and is not in a busy stage. `producing` is the one
  exception, because scene generation can run beside captions and music.
* Starting an earlier step on a later-stage project is an explicit **rewind**.
  The service layer invalidates downstream data (for example, new narration
  invalidates scenes, timeline, QA and render).
* A `*_FAILED` event returns the project to the stable stage it came from and
  records `last_error`. Failures are never silent.
* Anything that changes the timeline (scene edits, new captions or music)
  after assembly calls `markTimelineStale`. The project drops back to
  `assets_ready` (or `planned`), so stale QA or renders can't be shipped.

### Scene

`pending → planned → queued → generating → generated | failed`, plus
`generated → queued` (regenerate: the current asset stays until the new one
succeeds). `locked` is an orthogonal flag. Locked scenes reject regenerate,
prompt edits, duration changes and replacement. `quality_status`
(`unchecked | pass | warn | fail`) is set by QA.

## 6. Durable job queue (`src/server/queue`)

* **Enqueue** runs in the same transaction as the state transition that
  motivates it. If one fails, neither is committed.
* **Claim**: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`. It picks
  `queued` jobs whose `run_at <= now()` **or** `running` jobs whose lease has
  expired (crashed worker), so work resumes automatically.
* **Heartbeat** extends the lease and persists progress and message.
* **Timeout**: every handler runs under an `AbortSignal` with a per-type
  `timeout_ms`. A timeout counts as a retryable failure.
* **Retry**: retryable errors are re-queued with exponential backoff plus
  jitter until `max_attempts`. Non-retryable errors (validation, missing
  configuration, budget exceeded, invalid state) fail immediately.
* **Reschedule** (polling): a handler can return `reschedule(delayMs)`, which
  puts the job back in the queue without spending an attempt. Provider
  polling works this way, so no worker slot is held while a remote
  generation runs.
* **Dedupe**: a partial unique index on `dedupe_key` for active jobs stops
  double clicks from creating duplicate work.
* **Terminal failure hooks**: each handler has `onFailed`, which reverts the
  domain state (project or scene) through the state machine. This also runs
  when a job fails because its lease expired too many times.
* **Cancel / retry** are exposed over the API and in the Jobs UI.

## 7. Provider abstraction (`src/server/providers`)

```ts
interface GenerationProvider {
  id; displayName; transport: 'mock' | 'api' | 'mcp'; implemented: boolean;
  capabilities: ('image'|'video'|'tts'|'music')[];
  models: ModelInfo[];                    // pricing units, limits, capability
  configStatus(): { configured; missingEnv[] }   // booleans only, never values
  estimateCost(req): CostEstimate
  submit(req, ctx): { externalId }
  poll(externalId, ctx): { status, progress, output?, error?, actualCost? }
  cancel?(externalId)
}
interface LlmProvider { id; complete(req): { text, usage } }   // raw text; validation lives elsewhere
```

* **Registry** resolves `provider/model` for a capability and refuses to use a
  provider that is not implemented or not configured. The API returns a typed
  `PROVIDER_NOT_AVAILABLE` error; nothing falls back silently.
* **Mock providers** (image, video, TTS, music, LLM) simulate the whole
  lifecycle: async submit, progress while polling, success, failure, timeout
  and cost. Outputs are real media (PNG/MP4 via ffmpeg, WAV synthesized in
  Node) so the rest of the pipeline is exercised end to end. Failure, timeout
  and latency behaviour come from `settings` and can be forced per prompt
  with `[mock:fail]` / `[mock:timeout]` for tests and demos.
* **Real providers** (`providers/real/`) extend `RealProvider`. Their
  credentials and enabled models come from a **connection**, not from code or
  env:

  | Adapter | Auth | Submit / poll | Built from |
  |---|---|---|---|
  | `google` | `x-goog-api-key` | Veo via `:predictLongRunning` + operation polling; Gemini images via `:generateContent` (stored immediately, then "polled") | `@google/genai` v2.24 mapping |
  | `kling` | `Bearer <API key>` | `/text-to-video/{model}` + `GET /tasks`; `/v1/images/generations`; `external_task_id` for idempotent recovery | Official docs snapshot 2026-09-20 |
  | `higgsfield-api` | `Key id:secret` | `POST /{endpoint}` + `/requests/{id}/status` | `@higgsfield/client` v2 |
  | `higgsfield-mcp` | OAuth 2.1 (DCR + PKCE) or bearer token | MCP tools `generate_image`/`generate_video` + `jobs_wait`; `models_explore` for the catalog | Live tool schemas + `@modelcontextprotocol/sdk` |

* **Connections** (`provider_connections` table, `providers/connections.ts`)
  work like this:
  * Secrets are AES-256-GCM encrypted (`security/secrets.ts`).
  * The API and worker keep a 2-second cache so provider lookups stay
    synchronous. The worker refreshes it before every job, and the API on
    every request.
  * Credentials are validated with a free request before they are stored.
    Bad credentials are never saved.
  * The browser only ever sees a hint (`…abcd`).
* **Pricing** is per model and user-editable (Kling defaults come from the
  official price list). A model with no price cannot be used, which keeps
  the budget guard meaningful.
* **Downloads** of provider outputs follow redirects manually. Credential
  headers are sent only to the original host.
* **MCP OAuth**: `PUT /api/connections/higgsfield-mcp` returns an
  authorization URL. The provider redirects to
  `/api/connections/oauth/callback`. The state is checked against the stored
  value, then the SDK's `finishAuth` exchanges the code (PKCE), and tokens
  are stored encrypted and refreshed by the SDK.

## 8. LLM usage and structured output

LLMs are used only for creative or structural judgement:

* script and story structure from a topic
* analysis of a pasted script (title, summary, sections; the narration text
  is kept verbatim)
* visual briefs per scene

Every call goes through `runStructured(schema, prompt)`. The steps are:
extract JSON, parse it, validate with a strict zod schema
(`.strict()`, bounded strings, enums), check cross-field invariants (for
example, a visual plan must cover exactly scenes 1..N), and allow one repair
round with the validation errors fed back. After that the job fails with
`LLM_OUTPUT_INVALID`.

User input and imported text are **untrusted data**. They are
length-limited, control characters are stripped, and they are wrapped in
delimited data blocks in prompts. They are never interpolated into ffmpeg
filter strings; text reaches ffmpeg only through `textfile=` or escaped ASS
files.

Deterministic work is **never** done by the LLM. That includes TTS timing
measurement (ffprobe), scene segmentation, caption cue building, timeline
assembly, QA checks, cost maths, state transitions, retries, file handling
and rendering.

## 9. Narration-first timeline

1. The TTS provider returns audio and word timings. The worker **measures**
   the real duration with `ffprobe` and rescales the timings if they drift
   from the measured length.
2. **Segmentation** (deterministic) walks the sentences and groups them into
   scenes within the recipe's `[minSceneSec, maxSceneSec]`. Long sentences
   split at word boundaries. Scene `start/end` are word timestamps, and the
   scenes tile `[0, narrationDuration]` with no gaps.
3. **Changing a scene's duration** moves its boundary with the next scene,
   snapped to a word boundary. Narration text moves with the boundary, and
   the total always equals the narration length.
4. **Captions** are built from the word timings (chunked by characters,
   words and punctuation).
5. **The timeline** (`TimelineSchema`) is assembled deterministically: a
   video track (one clip per scene, fitted to scene duration), a narration
   track, a music track (with sidechain ducking) and a caption track.
6. **The renderer** consumes only the timeline JSON. It normalizes each scene
   clip to exact duration (image → slow pan, video → trim or loop), concats
   them, mixes narration with ducked music, burns ASS captions, and reports
   progress from `ffmpeg -progress`. It then verifies the output with ffprobe
   (streams present, duration within tolerance).

## 10. Cost tracking

* Every adapter prices its own models (`estimateCost`), labelled
  *simulated* for mock.
* Before enqueueing, the budget guard checks
  `spent + outstanding estimates + new estimate ≤ project budget`. If not, it
  returns `BUDGET_EXCEEDED` (HTTP 402), nothing is enqueued, and the UI shows
  the numbers.
* An estimate row is written at submit and an actual row at completion.
  Failed mock jobs cost 0, matching the typical provider refund policy.
* The Costs page aggregates by project, provider, model and kind.

## 11. Storage

`StorageAdapter` has `put`, `path`, `stat`, `delete` and `createReadStream`.
Phase 1 ships `LocalStorage` rooted at `STORAGE_DIR`, with keys like
`projects/<id>/scenes/<sceneId>/<genId>.png`. All keys are generated
server-side and path traversal is rejected. Files are served through
`/api/assets/:id/file`, which looks up the id and uses a Range-capable stream
so video seeks work. An S3 adapter can be dropped in behind the same
interface.

Uploads (asset replacement) are validated: size limit, extension and mime
allow-list, probed with ffprobe, and rejected when they don't decode.

## 12. Error handling

* `AppError(code, message, httpStatus, retryable, details)` is the single
  error type. The Fastify error handler maps it to
  `{ error: { code, message, details } }`. Zod request errors become
  `VALIDATION_ERROR` (400).
* Job errors are persisted to `jobs.error`, `generations.error`,
  `scenes.error` and `projects.last_error`, and shown in the UI next to the
  thing that failed, with a retry action.
* The web client throws typed `ApiError`s. Mutations show toasts, and screens
  show inline error states.

## 13. Frontend

Built with React 19, React Router, TanStack Query, Tailwind v4 and lucide
icons. It is dark, dense and desktop-first.

* **Global nav**: Dashboard, Projects, Create, Templates (Channel Recipes),
  Assets, Voices, Providers, Jobs, Costs, Settings.
* **Studio**: Script, **Storyboard** (the primary workspace), Assets,
  Timeline, Audio, QA, Publish. A header shows the project stage rail,
  budget and active jobs.
* **Storyboard scene card** shows number, duration, narration, strategy,
  asset, provider/model, prompt, references, generation state and progress,
  cost and quality. Its actions are generate, regenerate, alternatives,
  change model, edit prompt, replace, lock, change duration and preview. Each
  action maps to a real API call.
* **Preview**:
  * The scene preview plays the scene visual with the matching narration
    slice and live captions.
  * The timeline preview is a composite player. The narration audio is the
    clock, and it drives visual, caption and music playback before anything
    is rendered.

## 14. Testing

* **Unit**: state machines, segmentation, duration adjustment, captions,
  timeline assembly, QA rules, cost and budget maths, LLM output validation
  (valid, invalid and repaired), WAV synthesis.
* **Integration** (real Postgres test DB): queue semantics (claim, lease
  expiry, reclaim, retry with backoff, non-retryable failure, reschedule,
  timeout, dedupe, cancel) and mock provider lifecycle (success, fail,
  timeout).
* **E2E acceptance**: drives the HTTP API through the 18-step workflow with
  an in-process worker, simulates a worker crash mid-generation, verifies the
  work resumes, renders a real MP4, validates it with ffprobe, downloads the
  package and reopens the project.
* **UI smoke** (Playwright + Chromium): clicks through the studio, reloads
  mid-job, confirms state survives and captures screenshots.
* No test ever uses real provider credits: the registry refuses real
  adapters in `NODE_ENV=test`.

## 15. Production mode (Phase 2)

* **Voiceover as master timeline:** the `narration.align` job aligns the
  script to an uploaded recording (`projects.voiceover_asset_id`).
  * With ElevenLabs connected, it uses Scribe word timestamps and
    Needleman–Wunsch alignment to the script.
  * Otherwise it uses `silencedetect` pauses, anchoring sentence and clause
    boundaries and distributing words by a letters/syllables weight
    (`services/alignment.ts`).
  * `narration_timing_source` records which method was used:
    `tts_timestamps`, `transcription`, `pause_alignment` or `simulated`.
* **ElevenLabs TTS:** `/with-timestamps` returns character alignment, which
  is folded into word timings.
* **Claude:** `getLlm()` returns the Claude adapter when an `anthropic`
  connection is enabled.
  * It uses adaptive thinking and server-side fallbacks, and handles the
    `refusal` stop reason.
  * The output still goes through `runStructured` (zod validation plus one
    repair round).
  * Token cost is recorded in the ledger.
* **Autopilot (`services/autopilot.ts`):**
  * The `project.autopilot` job is a deterministic, self-rescheduling state
    machine over the project stage. Its state is stored in
    `projects.autopilot`.
  * Each tick either enqueues the next step's job or waits. A step whose job
    failed (detected by `expect{step, from}`) is retried up to 3 times.
  * Failed scenes are regenerated for up to 2 rounds. QA failures trigger
    fix-and-recheck for up to 2 rounds.
  * Non-retryable errors (budget, missing price, validation) stop the run
    with the reason.
  * Because the job has dedupe keys, and all state is in the DB, it
    survives browser refreshes and worker restarts.
* **Render:**
  * The mix is normalised with `loudnorm=I=-14:TP=-1.5:LRA=11`.
  * The `hd` preset renders at 1920×1080.
  * After rendering, `media/analyze.ts` (`ebur128`, `blackdetect`,
    `silencedetect`) produces `projects.render_report`.
  * `publishReady` is false if any check fails, or if any narration or
    visual is simulated.

## 16. Desktop app (Windows installer)

The desktop app ships the same production build, with no separate code
path.

* **`desktop/main.cjs`** is the Electron main process. It:
  1. starts a private PostgreSQL 17 cluster in
     `%APPDATA%\AF6 Studio\database`, listening on 127.0.0.1, with a
     random scram password stored next to it. The binaries come from
     `@embedded-postgres` and are run with `initdb` / `pg_ctl`. On Windows,
     `pg_ctl` drops administrator rights, which postgres requires, so the
     app also works for admin accounts;
  2. spawns `dist/server/main.js` and `dist/worker/main.js` as child
     processes using Electron's bundled Node (`ELECTRON_RUN_AS_NODE`);
  3. waits for `/api/health`, then loads `http://127.0.0.1:<port>` in the
     window.
* **External links:** `window.open` and off-origin navigation (OAuth sign-in,
  provider consoles) go to the system browser.
* **Shutdown:** closing the window stops the API and worker (graceful, then
  forced after 5 s) and then the database.
* **Crash recovery:**
  * If the Electron process dies, the children notice through
    `AF6_PARENT_PID` (`src/server/parent.ts`) and exit.
  * On the next start, a Postgres left running on the data directory is
    stopped with `pg_ctl` before starting.
  * The job queue's leases resume interrupted jobs.
* **Windows portability** in the server:
  * Filtergraph paths go through `filterPath` (forward slashes, escaped
    `:`; spaces and non-ASCII are fine).
  * Concat lists use relative names.
  * Fonts come from `FONT_DIR`.
  * The e2e suite runs green with storage in a directory named
    `we:ird dír ü`.
* **`scripts/build-desktop.mjs`** stages the app and its production
  dependencies, installing the target OS's PostgreSQL binaries via
  `npm --os/--cpu`. It bundles:
  * ffmpeg/ffprobe 6.1.1 (GPL build with libass/freetype/x264), pinned by
    SHA-256;
  * DejaVu fonts;
  * on Windows, the MSVC runtime DLLs (app-local).

  electron-builder then produces a per-user NSIS installer. `asar` is off
  because the ESM children and the Postgres binaries are run from disk.
* **CI:** `.github/workflows/windows-desktop.yml` runs on `windows-latest`.
  It builds the installer, installs it silently, launches the installed app
  and runs `scripts/ui-smoke.ts` against it. Only then does it publish the
  `desktop-latest` pre-release.

## 17. Phase plan

* **Phase 1:** core studio with mock providers. Done.
* **Phase 2 (real production):**
  * Done:
    * Real media providers (Google Veo/Gemini, Kling, Higgsfield API/MCP).
    * ElevenLabs TTS and transcription.
    * Claude director.
    * Voiceover and music upload with alignment.
    * Autopilot.
    * Loudness normalisation and the publish-readiness report.
  * Open:
    * Real music/SFX generation.
    * Image-to-video.
    * Research step.
* **Phase 3 (multi-provider engine):**
  * Done: capability-based model catalog, per-model prices, and budget
    guard.
  * Open:
    * Automatic routing and fallback between providers.
    * Health monitoring.
    * Custom REST and custom MCP providers.
    * Per-provider rate limits.
* **Phase 4:**
  * YouTube intelligence (titles, thumbnails, SEO).
  * Publishing integrations.
  * Auth and multi-user.
  * S3 storage.
  * SSE push.
