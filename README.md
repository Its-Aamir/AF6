# AF6 Studio

An AI-assisted, narration-first video production studio. You start from a
topic or a script and pick a **Channel Recipe**. The studio then writes the
script, generates narration and measures its real duration, and cuts scenes
on the narration's word timings. It then plans visuals per scene, generates
assets, assembles a timeline with captions and music, runs QA, and renders
an MP4.

**Phase 1** (this repository) ships the complete pipeline on **mock
providers**, so the whole workflow runs end to end without credentials or
credits. Real providers (Veo, Kling, Higgsfield API/MCP) are registered as
adapter descriptors only. They will be implemented against their official
docs once credentials are available.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design.

![Storyboard](docs/screenshots/storyboard.png)

## Requirements

| Tool | Version | Why |
|---|---|---|
| Node.js | ≥ 22 | API, worker, build |
| PostgreSQL | ≥ 14 (tested on 16) | projects, scenes, jobs queue, cost ledger |
| ffmpeg + ffprobe | ≥ 5 (tested on 6.1), built with `libfreetype` and `libass` | mock media, duration measurement, rendering |

On macOS: `brew install node postgresql@16 ffmpeg`.
On Debian/Ubuntu: `apt install postgresql ffmpeg`.
Alternatively, run Postgres with `docker compose up -d`.

## Setup

```bash
npm install
cp .env.example .env            # adjust DATABASE_URL if needed

# Database: either use docker compose…
docker compose up -d            # creates databases "studio" and "studio_test" (user/password: studio)
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
| `GOOGLE_VEO_API_KEY`, `KLING_ACCESS_KEY`, `KLING_SECRET_KEY`, `HIGGSFIELD_API_KEY`, `HIGGSFIELD_MCP_URL` | none | Reserved for future adapters. Only presence is reported, on the Providers page. Not used in Phase 1. |

Secrets are read on the server only. The browser never receives key values.

## Tests

```bash
npm test                # unit + integration (state machines, queue, providers, segmentation, LLM validation, QA)
npm run test:e2e        # full 18-step acceptance workflow through the HTTP API, incl. worker-crash recovery and real MP4 render
npm run typecheck

# UI smoke test (Playwright + Chromium) against a running build:
npm run build && npm start &          # in another terminal
npm run test:ui                        # screenshots → ./screenshots
```

Tests run against `TEST_DATABASE_URL` with `NODE_ENV=test`. The provider
registry refuses every non-mock provider in that mode, so tests can never
spend real credits.

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

**Create → Script → Narration (measured) → Scenes → Visual plan → Generate
visuals → Captions / Music → Assemble timeline → QA → Render → Package.**

Each step is available both from the studio header ("next step") and from
its tab. Everything is persisted server-side, and jobs keep running if you
close the browser.
