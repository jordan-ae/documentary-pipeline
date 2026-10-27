# Decisions

Rationale for choices that look arbitrary. Read before proposing changes.

## 1. Research first, script from evidence only

Most pipelines write a script then fact-check it. We do the opposite: gather
a structured evidence base, then write only from it.

Fact-checking after the fact is adversarial and unreliable — a model has to
notice that something is missing. Grounding is a lookup: does this sentence
cite a row in the evidence table, yes or no. That check is nearly objective
and it is topic-independent.

Historical content lives or dies on this. A fabricated quote attributed to a
real figure, or a date off by a decade, ends the channel — the audience for
history is disproportionately the kind that checks.

## 2. Slideshow format, not generated video

The one genre where a held still image is a stylistic convention rather than
a budget compromise. This removes motion coherence — the hardest and most
expensive problem in generative video — from the critical path without the
audience reading it as a downgrade.

Consequence: quality lives entirely in script, voice, image relevance and
pacing. There is no B-roll energy to hide a weak script behind.

## 3. Linear script, no orchestrator

Cloudflare Workflows is the right answer eventually. It is the wrong answer in
week 1, because plumbing is where days disappear and it contributes nothing to
whether the video is good. Cached stage outputs give us all the durability we
need: if stage 4 crashes, rerun stage 4.

Port when there is something worth hosting.

## 4. Archival only, no image generation

Four reasons, in order of weight:

1. Generated images need an anachronism gate (models put stirrups on Romans
   and percussion rifles in 1640). That is a whole subsystem.
2. Archival footage looks *better* for history. It is the genre's texture.
3. Wikimedia Commons, LoC and Europeana are free and have proper rights
   metadata.
4. It removes ~$1.60/video and the largest source of gate rejections.

Revisit only for topics where archival coverage is genuinely thin.

## 5. No image-to-video in v1

$3 of a $10 video and the most failure-prone component — faces morph,
architecture warps, and you throw away most attempts. Parallax on stills via
depth displacement gets most of the perceived motion at near-zero marginal
cost. Add hero shots later, with a rejection gate, once everything else works.

## 6. Kokoro during development, production voice at the end

TTS quality is the highest-leverage model choice in the project, but you don't
need it to test timing, alignment or assembly. Kokoro is 82M params, Apache
2.0, runs on CPU. Swap at final integration.

When choosing the production voice, **check the license** — several of the
top-ranked open-weight voice models are non-commercial, which is a
build-on-sand risk. Also evaluate duration-controllable models (IndexTTS-2
class); fitting narration to scene timing matters more here than raw MOS.

## 7. Cards in HTML, not ffmpeg drawtext

drawtext typography is painful and looks dated. Rendering HTML/CSS in headless
Chromium to transparent PNG gives real type control, and it makes the eventual
per-niche theming a swap of CSS tokens rather than a rewrite.

## 8. Soft captions, not burned-in

Burned-in word-level karaoke captions are a short-form convention. On a
13-minute documentary they read as low-effort and fight the tone. Export SRT
sidecars. Reserve burned-in text for deliberate typographic moments — dates,
names, pull quotes.

Word-level alignment is still required regardless, because it's what locks
scene boundaries to narration.

## 9. Human gate at the script, not the finished video

Reading three minutes of text is cheaper than watching thirteen minutes of
video, and it catches the problem before any asset spend. Reviewing finished
videos is the expensive, low-information version of the same decision.

## 10. Why not fully autonomous yet

The generator is not the hard part. The critic is. A model-as-judge has no
idea what holds attention until it's grounded in real retention data, and
that data doesn't exist until we publish. The first videos are calibration
runs with a human in the loop — that's not a failure state, it's how the
training signal gets manufactured.

Gate accretion is the improvement mechanism: when a published video
underperforms, walk the run artifacts, find the stage that let it through,
add the gate that would have caught it. This only works if every run's
artifacts are kept.

## 11. TypeScript, not Python

Python is the default for ML pipelines, so this looks like a mistake. It isn't.

The endgame is Cloudflare Workers, which are JS-native. A Python spine means
rewriting the whole orchestration layer at port time. In TypeScript the port is
a move, not a rewrite.

Zod also beats pydantic for our specific use: we derive JSON Schema directly
from the zod type and pass it to Fireworks `response_format`, so the parser and
the prompt contract cannot drift apart.

**The two things that made this risky both have Node paths:**

- Word-level forced alignment: `nodejs-whisper` (whisper.cpp bindings) with
  `wordTimestamps: true`, `splitOnWord: true`
- TTS: `kokoro-js`, the official ONNX build, CPU-capable

**Known friction:** any *other* local ML — depth estimation for parallax,
image embeddings for retrieval scoring — has a thinner Node story. Solve those
with hosted APIs (fal) rather than reintroducing Python. A second runtime in
this project is a bigger cost than a few cents of inference.

## 12. Cost shape (for reference)

At 13 minutes, production: ~$3 text, ~$0.30 TTS, ~$1.60 images (if generating),
~$3 motion (if used), ~$0.40 render and storage. Roughly $10 published, $7
without motion, $3–4 with aggressive model laddering and batch endpoints.

Breakeven at documentary RPM is roughly 1,500–3,500 views. Inference cost is
not the constraint. Attention is.

Corollary: the gate stack costs cents per run. Rejecting a bad video costs
dollars. Publishing one costs the channel. There is no argument for running
fewer gates.

## 13. Evidence is retrieved in code, not recalled by a model

Added day 1. The docs specified `source_url` on every evidence entry and a
`sufficiency` gate wanting two independent sources, but never said where the
evidence *text* comes from. Fireworks has no search grounding, so the default
reading — kimi-k3 "does research" — means the model supplies the URLs.

It would supply them fluently and they would be fabricated. Worse, the
grounding gate would still pass: it checks script claims against evidence rows,
so inventing the rows first makes every downstream check succeed. That is the
failure mode decision #1 exists to prevent, arrived at from the other side.

So retrieval is code. `src/clients/wikimedia.ts` fetches article text over the
Wikimedia REST API; the model sees only text we actually fetched and never
emits a URL — ids and `source_url` are attached afterwards from the fetch that
produced the text. Extraction runs one call per article, because several
articles sharing a context lets the model attribute a claim to the wrong
source, and correct attribution is the only thing the stage is for.

**Consequence for model routing.** CLAUDE.md reserves kimi-k3 for "research".
Once retrieval is real, this stage is mechanical extraction from supplied text,
not research, so it runs on the flash model: measured at $0.007 vs $0.184 per
pass on the Galveston evidence base. It is the highest-token stage in the
pipeline, so this is where laddering actually pays.

**Known limitation, deliberately visible.** The corpus is Wikipedia alone, so
two articles agreeing are not two independent sources. `sufficiency` therefore
ships with `requireCorroboration: false` and prints the corroboration
percentage on every run rather than hiding the gap. The upgrade path is already
built: each run writes `candidate_sources.json`, the real third-party URLs
those articles cite, parsed from their `{{cite}}` templates — 181 of them for
Galveston, 26 academic and 93 news. Fetching those is what turns the check on.

## 14. BreezeBlue for narration, ahead of the kokoro step

Added day 1, at the developer's request, and it supersedes the development
half of #6. The stack line in CLAUDE.md still names `kokoro-js`; that line is
now stale.

Breeze TTS 2 tops the Artificial Analysis open-weight TTS leaderboard, and #6
already conceded that TTS quality is the highest-leverage model choice in the
project. Going straight to it skips a swap later.

**The licence problem, unresolved.** #6 said to check the licence, and the
check fails in the way #6 predicted. Breeze TTS 2 weights are under the
*BreezeBlue Research and Non-Commercial License*. Commercial rights to
generated audio come only from their hosted platform on an **active paid
subscription** — a dev/demo key is not that. The inference code is Apache 2.0,
which does not extend to the weights.

So: fine for the hiring demo, not settled for a monetised channel, and #12
assumes a monetised channel. Resolve before any published video depends on it.
Options are a paid Breeze subscription, or keeping Breeze for the demo and
swapping at final integration exactly as #6 originally planned.

**Measured behaviour the pipeline now depends on:**

- `output_format=wav` is 24 kHz mono PCM, the model's native rate. `pcm_*` is
  headerless and unusable; mp3 would be a lossy round-trip before alignment.
- Synthesis runs at ~3x realtime. A 10-minute narration is ~30 minutes
  sequential, so segments are synthesised concurrently and cached.
- **Output is non-deterministic.** The same text resynthesised returns a
  different duration. Segment audio is therefore never regenerated once it
  exists, because every downstream timing would shift under it.
- `voice_settings.speed` is a weak lever: 0.9 measured identical to 1.0, 0.85
  moved 179 -> 160 wpm. The free-text `instructions` field is the effective
  control over register, so delivery direction lives there.
- Real rate is **162 wpm** including inter-segment gaps, not the 145 this
  project assumed. `read_time` is recalibrated and every run now records
  `measured_wpm` so the constant can be re-derived from data rather than guessed.

Voice default is `voc_an4aj9p66p9t` (Aquilo). Of 50 voices, 31 are categorised
gaming and several nominal "narration" voices are written for fantasy
("deity-like presence"); this is the most neutral documentary fit.
