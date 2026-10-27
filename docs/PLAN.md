# Week 1 plan

**Primary goal: a live Cloudflare URL that potential employers can open by
Friday.** Everything else is subordinate to that.

Deliverable: a hosted site showing 2–3 finished documentary videos, each with
a browsable trail of the real pipeline artifacts that produced it, plus a short
written case study.

**Not** delivered this week: live generation in the browser, autonomy,
cross-niche generality, calibrated quality gates.

## What the site is

Static site on Cloudflare Workers. Videos in R2. No backend, no database, no
live inference.

For each completed run, the pipeline writes `runs/<run_id>/` and those JSON
artifacts are committed and shipped with the site. The frontend reads them
directly.

Three views:

1. **Video** — the finished mp4, chapters, description
2. **Pipeline replay** — step through treatment → evidence base → beat sheet →
   script → shot list → assets, showing the real artifact at each stage and
   the gate result. This is the view that gets you hired. Include at least one
   run where a gate **caught something** — a claim that failed grounding, an
   ASR diff that caught a mispronunciation. A visible catch proves the harness
   does work, where a clean pass proves nothing.
3. **Case study** — one page of prose: the problem, why grounding-first, why
   archival-only, the cost model. Employers read.

Label the replay as a recorded run. The artifacts are real; do not imply live
generation.

## Day 1 — script path

- `treatment`, `evidence_base`, `beat_sheet`, `script` stages
- Install build tools + download the whisper model while research calls run

Done when: one script reads well enough that you'd watch it. Save everything
to `fixtures/`. Do not proceed until the writing is good.

## Day 2 — gates and voice

- `grounding` gate, `read_time` gate
- Proper-noun lexicon pass, TTS via `kokoro-js`
- `nodejs-whisper` alignment → word-level timings, `asr_diff` gate

Done when: `narration.json` has word timings and the ASR diff is clean.
**Keep a screenshot or saved artifact of any gate failure you hit today.** It
is demo material.

## Day 3 — visuals and assembly

Compressed — two days of work in one. Cut depth if needed, not breadth.

- `shot_list` from word timings
- Wikimedia Commons + Library of Congress clients (drop Europeana)
- `semantic_match` gate, `asset_manifest`
- ffmpeg: Ken Burns, hard cuts, audio mix

Done when: **a watchable mp4 exists.** Ugly is acceptable.

## Day 4 — frontend

- `npm create cloudflare@latest`, deploy an empty page to a `workers.dev` URL
  **in the first hour**. Get the link live before it has anything on it.
- Artifact viewer components, pipeline replay stepper
- R2 bucket for video hosting

Done when: the URL loads and plays one video.

## Day 5 — content

- Run the pipeline on 2 more topics
- Title card + chapter cards, SRT export
- Write the case study page

## Day 6 — polish and hardening

- Mobile layout (they will open it on a phone)
- Check the link from a logged-out browser on another network
- Loading states, no broken images, no console errors

## Day 7 — buffer

## Cut order if behind

1. Third video — two is enough
2. Chapter cards
3. Music bed
4. `semantic_match` gate — review assets by hand
5. Second and third video drop to 5–6 minutes; keep one at full length

Never cut: the grounding gate, the pipeline replay view, a working public URL.

## The rule for this week

If it is Thursday and the site is not live, stop building pipeline and ship
what exists. **A deployed URL with one good video beats a perfect local
pipeline nobody can see.**
