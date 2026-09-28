# AF6 Studio

An AI-assisted, narration-first video production studio that turns what you
have into an upload-ready MP4:

* **Only a script (or just a topic)** → the studio narrates it (ElevenLabs),
  plans and generates the visuals (Veo / Kling / Higgsfield), adds captions,
  mixes and renders.
* **Script + your own voiceover + your own music** → your recording becomes
  the master timeline (script aligned word by word), your track is mixed
  under it with ducking, and visuals are generated to fit.

Open **Create**, paste the script, optionally drop in the voiceover and
music files, and press **Produce video**. **Autopilot** runs every step,
retries failures, regenerates scenes that fail QA, renders in 1080p and
tells you whether the result is ready to upload.

You can also drive each step by hand. You start from a
topic or a script and pick a **Channel Recipe**. The studio then writes the
script, generates narration and measures its real duration, and cuts scenes
on the narration's word timings. It then plans visuals per scene, generates
assets, assembles a timeline with captions and music, runs QA, and renders
an MP4.

The whole pipeline runs end to end on built-in **mock providers** with no
credentials. When you're ready, connect a real provider from the
**Providers** page and switch scenes to its models:

* **Google Veo + Gemini:** paste a Gemini API key.
* **Kling AI:** paste an API key.
* **Higgsfield API:** paste a key ID and secret.
* **Higgsfield MCP:** sign in with OAuth.
* **ElevenLabs:** paste an API key (narration voices + voiceover transcription).
* **Claude (AI Director):** paste an Anthropic API key (script writing and
  scene planning).

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design.

![Storyboard](docs/screenshots/storyboard.png)

## Install on Windows (.exe)

1. Download **AF6-Studio-Setup-x.y.z.exe** from the repository's
   [Releases](../../releases/tag/desktop-latest) page (release
   `desktop-latest`).
2. Run it. Windows SmartScreen may warn because the installer isn't
   code-signed; click **More info → Run anyway**. Choose where to install;
   no administrator rights are needed.
3. Start **AF6 Studio** from the Start menu or the desktop shortcut. The
   first start takes a few seconds while it creates its database.

Everything runs on your PC: a private database, the studio and the render
worker, with ffmpeg and fonts included. Nothing else needs to be installed.
Your projects, videos and encrypted API keys live in
`%APPDATA%\AF6 Studio`. **File → Open data folder** takes you there, and
the folder is kept if you uninstall. Closing the window stops everything.
Interrupted jobs resume the next time you open the app.

To build the installer yourself on Windows: `npm ci`, then
`npm run desktop:build`. The installer is written to `release/`. Every push
also builds it on GitHub Actions (`.github/workflows/windows-desktop.yml`),
installs it on a clean Windows machine, runs the UI test against the
installed app, and publishes it as `desktop-latest`.

## Quick install (Docker, Windows / macOS / Linux)

The easiest way to try it. You only need
[Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
and running.

1. Download this repository:
   * **Code → Download ZIP** on GitHub, then unzip it;
   * or `git clone`.
2. Open a terminal in the folder (on Windows, PowerShell) and run:

   ```bash
   docker compose up -d --build
   ```

   The first run downloads and builds everything, which takes a few minutes.
3. Open **http://localhost:8787** in your browser.

Useful commands:

* **Stop:** `docker compose down`. Your projects and keys are kept.
* **Start again:** `docker compose up -d`.
* **Update to a newer version:** download it again, then run
  `docker compose up -d --build`.
* **Logs:** `docker compose logs -f api worker`.

About the Docker install:

* Your projects, rendered videos and encrypted keys are stored in Docker
  volumes (`studiodata`, `pgdata`).
* The studio has no login, so it only listens on your own computer
  (`127.0.0.1`).
* Out of the box it runs on the simulated providers. Open **Providers** to
  add your ElevenLabs, Veo, Kling, Higgsfield or Claude keys.

The rest of this README covers running from source (for development).

## Requirements

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22 | API, worker, build |
| PostgreSQL | ≥ 14 (tested on 16) | projects, scenes, jobs queue, cost ledger |
| ffmpeg + ffprobe | ≥ 5 (tested on 6.1), built with `libfreetype` and `libass` | mock media, duration measurement, rendering |

On macOS: `brew install node postgresql@16 ffmpeg`.
On Debian/Ubuntu: `apt install postgresql ffmpeg`.
Alternatively, run Postgres with `docker compose up -d postgres`.

## Setup

```bash
npm install
cp .env.example .env            # adjust DATABASE_URL if needed

# Database: either use docker compose (database only)…
docker compose up -d postgres   # creates databases "studio" and "studio_test" (user/password: studio)
# …or create them on an existing server:
createuser -P studio            # password: studio
createdb -O studio studio
createdb -O studio studio_test

npm run db:migrate              # applies SQL migrations + seeds built-in recipes (idempotent)
```

The API and the worker also apply pending migrations on start.

## Run

**Development** (hot reload; three processes):

```bash
npm run dev
# web  → http://127.0.0.1:5173   (proxies /api to the API)
# api  → http://127.0.0.1:8787
# worker executes all background jobs
```

**Production build**:

```bash
npm run build                   # web → dist/web, server/worker → dist/
npm start                       # API (serves the web app) + worker → http://127.0.0.1:8787
```

The API and worker are separate processes. You can scale workers
horizontally (`npm run start:worker` several times). Jobs are claimed with
`SKIP LOCKED` and leases.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://studio:studio@localhost:5432/studio` | Main database |
| `TEST_DATABASE_URL` | `postgres://studio:studio@localhost:5432/studio_test` | Used by tests (**tables are truncated**) |
| `STORAGE_DIR` | `./data/storage` | Generated media, renders, packages |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | API bind address |
| `WORKER_CONCURRENCY` | `4` | Parallel jobs per worker process |
| `WORKER_POLL_MS` | `500` | Queue poll interval when idle |
| `MAX_UPLOAD_MB` | `200` | Upload size limit |
| `FFMPEG_PATH` / `FFPROBE_PATH` | `ffmpeg` / `ffprobe` | Media binaries |
| `SECRETS_KEY` | auto-generated key file | Encrypts provider credentials at rest (32 bytes, base64: `openssl rand -base64 32`). Set it explicitly in production and back it up. |
| `PUBLIC_BASE_URL` | `http://HOST:PORT` | Public URL of this server, used as the OAuth redirect for MCP sign-in |

Provider credentials are **not** environment variables. You enter them on
the Providers page. They are checked with a free request before saving,
encrypted with AES-256-GCM, and never sent back to the browser.

## Connecting real providers

Open **Providers**, click **Connect** on a provider, and paste its
credential (or sign in, for MCP). Enabled models then appear in:

* Channel Recipe defaults
* each scene's model picker
* the Storyboard's project-wide Video/Image model switch

| Provider | You need | What you get | Source the adapter was built from |
|---|---|---|---|
| **Google Veo + Gemini** | A Gemini API key ([AI Studio](https://aistudio.google.com/apikey)) | Veo video models + Gemini image models, **discovered from your key** | Official `@google/genai` SDK request mapping |
| **Kling AI** | A Kling API key ([console](https://kling.ai/dev/api-key)) | Kling 3.0 Turbo / 3.0 / 2.6 / 2.5 Turbo video, Kling Image 3.0 / 2.1 | Official Kling API docs (2026-09-20). Official prices pre-filled. |
| **Higgsfield API** | Key ID + secret (Higgsfield console) | Any Higgsfield endpoint you add (image or video), with optional per-endpoint extra input | Official `@higgsfield/client` v2 SDK |
| **Higgsfield MCP** | Your Higgsfield account (OAuth sign-in) | Higgsfield's model catalog (Seedance, Kling, Veo, GPT Image, …) via the official MCP server | Live tool schemas of `https://mcp.higgsfield.ai/mcp`, official MCP SDK |
| **ElevenLabs** | An API key ([settings](https://elevenlabs.io/app/settings/api-keys)) | Your voices as narration voices (exact per-word timestamps), TTS models, and Scribe transcription to align uploaded voiceovers | Official `@elevenlabs/elevenlabs-js` SDK wire format |
| **Claude (AI Director)** | An Anthropic API key ([console](https://console.anthropic.com/settings/keys)) | Script writing, script analysis and per-scene visual planning (`claude-opus-5` by default). Every response is still validated against strict schemas. | Official `@anthropic-ai/sdk` |

**Which to pick:** ElevenLabs for the voice; Claude as the director; for
visuals, Higgsfield MCP for the widest catalog with one sign-in, Kling for
the best price on motion, Veo for top-end cinematic shots. You can connect
several and mix them per scene. Keep images for most scenes and use video
for hero scenes to control cost.

How it behaves:

* **Prices:** every model has a USD price per second or per image, which
  feeds the budget guard and the cost ledger. Kling prices are pre-filled
  from its official price list. For Google, Higgsfield and MCP models, you
  enter your own price. **Generation is refused for a model without a
  price**, so the budget guard always works.
* **Durations:** video models declare allowed clip lengths. The studio
  requests the shortest allowed length that covers the scene; the renderer
  trims or loops to the exact narration timing.
* **No double billing after a crash:** Kling submissions carry an
  idempotency key (`external_task_id`). A worker that crashes after
  submitting finds the existing task instead of paying twice.
* **Higgsfield MCP never spends your unlimited/free-trial allowance** on
  its own (`use_unlim: false` is always sent).
* **Status of these adapters:** they were built against the sources above
  and verified against local servers that implement those documented
  contracts (`tests/providers.test.ts`). They have not been run against the
  live services yet, because no credentials exist in this environment.
  Connect a key, generate one scene, and check it before running a whole
  project.

## Producing a video (Autopilot)

1. **Create** → *My script* (or *Just a topic*), pick a Channel Recipe.
2. Optional: attach **Voiceover** and **Music** (wav, mp3, m4a, aac, flac or
   ogg). The files are validated with ffprobe; anything else is rejected.
3. Choose the voice and the video/image models. The page warns you about
   anything that would still be simulated.
4. **Produce video.** Autopilot is a durable background job, so you can
   close the browser. It runs script → narration or voiceover alignment →
   scenes → visual plan → generation (with up to two rounds of fixes for
   failed scenes) → captions → music → timeline → QA (fixing and re-checking
   up to twice) → render → package. It stops, with the reason shown,
   when a step can't succeed: missing price, budget reached, or a
   non-retryable provider error. Fix the cause and press **Run again**.

**How the voiceover is aligned:** with ElevenLabs connected, it is
transcribed and the transcript is aligned to your script (exact timings).
Without it, the studio aligns your script to the recording's speech pauses
(approximate, but close enough for scene cuts and captions). The Audio tab
shows which method was used.

**Music:** upload your own track or pick one from your library. No real
music-generation provider is integrated yet. Without an uploaded track,
Autopilot produces the video without music.

**Ready to upload?** After rendering, the Publish tab checks:

* the resolution;
* loudness, normalised to −14 LUFS integrated with a true peak of at most
  −1.5 dBTP (YouTube's reference);
* black frames;
* long silences;
* that nothing in the video is simulated (mock visuals or voice).

A video made with mock providers renders fine, but it is marked **Not
yet** ready to upload.

## Tests

```bash
npm test                # unit + integration (state machines, queue, providers, segmentation, LLM validation, QA)
                        # + provider contract tests against local fake Google/Kling/Higgsfield/MCP(+OAuth)/ElevenLabs/Anthropic servers
                        # + Autopilot: topic-only, script+voiceover+music (transcription and pause alignment), budget stop
npm run test:e2e        # full 18-step acceptance workflow through the HTTP API, incl. worker-crash recovery and real MP4 render
npm run typecheck

# UI smoke test (Playwright + Chromium) against a running build:
npm run build && npm start &          # in another terminal
npm run test:ui                        # screenshots → ./screenshots
```

Tests run against `TEST_DATABASE_URL` with `NODE_ENV=test`. In that mode
the provider registry refuses any real provider whose endpoint is not a
local fake server, so tests can never reach a real API or spend credits.

## Using the mock provider

* **Settings → Mock provider simulation** sets latency, random failure rate,
  random timeout rate and the timeout deadline.
* Put `[mock:fail]` or `[mock:timeout]` in a scene prompt to force that
  outcome. This lets you watch retries, backoff, timeouts and error
  surfacing.
* Put `[mock:invalid-json]` in a topic to make the mock LLM return malformed
  JSON once. It exercises the validation/repair path.
* All mock costs are labelled *simulated*.

## Workflow

**Create → Script → Narration (measured, or your aligned voiceover) → Scenes → Visual plan → Generate
visuals → Captions / Music → Assemble timeline → QA → Render → Package.**

Each step is available both from the studio header ("next step") and from
its tab. Everything is persisted server-side, and jobs keep running if you
close the browser.
