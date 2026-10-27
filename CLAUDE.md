# CLAUDE.md

## What this is

A pipeline that takes a topic and produces a finished 8–13 minute narrated
historical documentary video: archival stills with Ken Burns motion, verified
narration, chapter cards, captions.

The long-term goal is an autonomous quality harness that works across topics.
**That is not what we are building this week.** See `docs/PLAN.md` for the
actual current scope.

## Current phase: WEEK 1 — hosted demo

**The deliverable is a public Cloudflare URL by Friday that potential
employers can open.** See `docs/PLAN.md`.

The pipeline runs locally on the developer's machine and writes artifacts to
disk. Those artifacts are committed and shipped as static data with the site.
The site does no inference and has no backend.

## Hard constraints for week 1

Read this list before proposing any change to project structure.

**Cloudflare is in scope for HOSTING ONLY.** A static frontend on Workers and
video files in R2. The pipeline does **not** run on Cloudflare this week.

**DO NOT introduce, suggest, or scaffold:**
- Cloudflare Workflows, Containers, Queues, or D1 — week 3+
- Any live generation endpoint or "generate" button in the frontend
- Temporal, Prefect, Dagster, Airflow, or any orchestrator
- LangGraph, CrewAI, AutoGen, or any agent framework
- Langfuse, Promptfoo, or any observability/eval platform — append JSONL
- Docker, Kubernetes, CI/CD pipelines
- A database — state lives in JSON files on disk
- Auth, user accounts, or any form input beyond navigation
- Image generation (we are archival-only, see DECISIONS.md #4)
- Image-to-video / motion synthesis
- Map rendering
- Domain packs / multi-niche abstraction — hardcode history
- Fan-out, candidate generation, or rejection loops — the human is the gate
- Tests beyond a smoke test, unless asked

If a task seems to need one of these, say so and ask. Do not add it silently.

**DO:**
- Keep everything in one linear pipeline, resumable by stage
- Cache every stage output to `runs/<run_id>/<stage>.json` and skip on rerun
- Fail loudly with the offending artifact printed, never fall back silently
- Use `zod` schemas for every artifact — definitions in `docs/ARCHITECTURE.md`
- Derive JSON Schema from the zod schema and pass it to Fireworks
  `response_format`. Never hand-write a schema that duplicates a zod type.

## Stack

**TypeScript throughout. No Python anywhere in this project.** If a task looks
like it needs a Python sidecar, stop and ask — there is a Node path for
everything we need and adding a second runtime breaks the Cloudflare port.

- **Runtime:** Node 22+, TypeScript strict mode, `tsx` for running scripts
- **LLM:** Fireworks via the OpenAI SDK (`baseURL:
  https://api.fireworks.ai/inference/v1`, `FIREWORKS_API_KEY`)
  - Research + scripting: `accounts/fireworks/models/kimi-k3`
  - Gates + classifiers: `accounts/fireworks/models/glm-5p3-flash`
  - Verify exact model IDs against the Fireworks model library before use
- **Schemas:** `zod`, with JSON Schema derived for structured output
- **TTS:** `kokoro-js` (ONNX, runs on CPU) during development. Swap to the
  production voice only at final integration.
- **Alignment:** `nodejs-whisper` (whisper.cpp bindings) with
  `wordTimestamps: true` and `splitOnWord: true`. Requires build tools
  (`build-essential`) and a one-time model download.
- **Assembly:** ffmpeg via `execa`, explicit argument arrays, no wrapper libs
  (no fluent-ffmpeg — build filter graphs as strings so they're debuggable)
- **Cards/overlays:** HTML+CSS rendered in headless Chromium (playwright) to
  transparent PNG, composited by ffmpeg. Never ffmpeg `drawtext`.
- **Archives:** Wikimedia Commons, Library of Congress (plain `fetch`, no SDKs)
- **Frontend:** Vite + React + Tailwind, deployed to Cloudflare Workers static
  assets via `wrangler`. Reads committed run artifacts as static JSON.
- **Video hosting:** Cloudflare R2, public bucket (egress is free)

## Preserve gate failures

When a gate rejects something during development, **save the failure artifact**
to `fixtures/failures/`. A grounding gate catching a fabricated date, or an ASR
diff catching a mispronounced name, is the most persuasive content on the demo
site. A pipeline that only ever shows clean passes proves nothing.

## Cost discipline

Every LLM call is metered and we are on a tight budget.

- Default to the cheap model. Only use kimi-k3 for research and script writing.
- Route anything non-interactive through the **batch endpoint** (50% off).
- Cache the evidence base in context — cached input is ~10x cheaper.
- **Never** re-run research to test a downstream stage. Use fixtures in
  `fixtures/`. If a fixture doesn't exist for what you're testing, ask before
  running a live pipeline.
- Target: under $3 per full run at 3-minute length, under $8 at 13 minutes.

## The one non-negotiable

**Every factual claim in the script must map to an entry in the evidence base.**
The script is written from gathered evidence, not from model memory. An
unmapped claim fails the grounding gate and the script is regenerated, not
patched. This is the check that keeps the project from being a liability.

## Reference

- `docs/ARCHITECTURE.md` — pipeline stages, artifact schemas, gate definitions
- `docs/PLAN.md` — day-by-day week 1 scope
- `docs/DESIGN.md` — **read before writing any frontend code**
- `docs/DECISIONS.md` — why things are the way they are; read before arguing
