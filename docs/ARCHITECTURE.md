# Architecture

## Shape

A linear pipeline of stages. Each stage reads typed artifacts and writes typed
artifacts to `runs/<run_id>/`. Rerunning the pipeline skips any stage whose
output file already exists unless `--force <stage>` is passed.

This is not an agent. The path is known. Stages are plain functions with LLM
calls inside them.

```
topic
  → treatment        [gate: viability]
  → evidence_base    [gate: sufficiency]
  → beat_sheet       [gate: structure]
  → script           [gates: grounding, prose, read_time]   ← HUMAN APPROVAL
  → narration        [gate: asr_diff]
  → shot_list
  → asset_manifest   [gate: semantic_match]
  → assembly_spec
  → video.mp4
```

## Artifacts

All zod schemas in `src/artifacts.ts`, with inferred types exported alongside
(`export type Treatment = z.infer<typeof Treatment>`). Field notation below is
shorthand — translate to zod, and use `.describe()` on fields whose meaning the
model needs to understand, since those descriptions carry into the JSON Schema
sent to Fireworks.

### Treatment
```
topic: str
angle: str                  # the specific take, not the subject
central_question: str       # what the video answers
why_long_form: str          # justification for 13 min
target_runtime_s: int
```

### EvidenceBase
```
entries: list[Evidence]

Evidence:
  id: str                   # e1, e2, ...
  claim: str                # one atomic fact
  source_url: str
  source_title: str
  source_type: str          # academic | archive | reference | news
  confidence: str           # high | medium | contested
  quote: str | None         # supporting excerpt, <=25 words
```

Contested facts stay in as `contested` with both positions. Never silently
resolve a disagreement between sources.

### BeatSheet
```
hook: str                   # the first 15 seconds
beats: list[Beat]

Beat:
  id: str
  chapter_title: str        # used for chapter cards + YouTube timestamps
  summary: str
  open_loop: str | None     # question planted here, resolved at beat X
  resolves: str | None      # beat id whose loop this closes
  evidence_ids: list[str]
```

### Script
```
segments: list[Segment]

Segment:
  id: str
  beat_id: str
  text: str                 # narration prose
  evidence_ids: list[str]   # every factual claim's support
```

### Narration
```
audio_path: str
duration_s: float
words: list[Word]           # {text, start_s, end_s} from WhisperX
```

### ShotList
```
scenes: list[Scene]

Scene:
  id: str
  segment_id: str
  start_s: float            # locked to narration word timings, never estimated
  end_s: float
  visual_brief: str         # what should be on screen
  search_terms: list[str]   # for archive retrieval
  period: str               # e.g. "1914-1918" — used by relevance checks
  place: str | None
```

Scene boundaries snap to word boundaries in `Narration.words`. Do not compute
scene timing from word counts or estimated WPM.

### AssetManifest
```
assets: list[Asset]

Asset:
  scene_id: str
  local_path: str
  source_url: str
  source_name: str          # Wikimedia Commons | LoC | Europeana
  license: str              # captured at retrieval, never inferred later
  attribution: str
  width: int
  height: int
```

License and attribution are captured at retrieval time. A missing license
field is a hard failure, not a warning.

### AssemblySpec
```
scenes: list[SceneRender]   # image path, kenburns params, transition
cards: list[Card]           # title + chapter cards with timings
audio: AudioMix             # narration path, music path, duck params
output: OutputSpec          # resolution, fps, codec
```

## Gates

Each gate is a function `(artifact, context) -> GateResult` where
`GateResult = {passed: bool, failures: list[Failure]}`. Gates never mutate.
A failed gate returns to the previous stage with failures as extra context.
Max 3 attempts per stage, then the run aborts.

| Gate | Stage | Model | Checks |
|---|---|---|---|
| `viability` | treatment | cheap | conflict, timeline, reveal present; can sustain runtime |
| `sufficiency` | evidence_base | cheap | min entry count; >=2 independent sources on load-bearing claims |
| `structure` | beat_sheet | cheap | hook poses a question in 15s; loops planted and resolved; conclusion not front-loaded |
| `grounding` | script | cheap | **every claim maps to an evidence id** |
| `prose` | script | kimi-k3 | register, LLM tells, sentence rhythm variation |
| `read_time` | script | none | word count vs target runtime at configured WPM |
| `asr_diff` | narration | none | re-transcribe audio, diff against script text |
| `semantic_match` | asset_manifest | cheap vision | image matches its scene brief and period |

### grounding (the important one)

1. Extract every factual assertion from the script as a list of atomic claims.
2. For each, ask whether it is supported by the segment's `evidence_ids`.
3. Any unsupported claim = failure, with the claim text in the failure.

Dates, numbers, names, and quotations are always treated as factual claims.
Rhetorical connective tissue is not. When unsure, treat it as a claim.

### asr_diff

Pure code, no LLM. Re-transcribe the generated audio with `nodejs-whisper`,
normalize both sides (lowercase, strip punctuation, spell out numerals), diff. Catches mispronounced proper nouns, dropped words, and
mangled numbers — the main TTS failure modes in historical content. Run a
lexicon substitution pass on proper nouns *before* synthesis.

## Archive retrieval

Query each of Wikimedia Commons, Library of Congress, and Europeana with the
scene's `search_terms`. Collect candidates, score by resolution and period
match, run `semantic_match` on the top few, take the first pass.

If no asset passes for a scene, fall back to extending the neighbouring scene
rather than inserting an unverified image. A longer hold on a good image is
better than a wrong image.

## Assembly

ffmpeg, explicit commands, built as a filter graph string. Ken Burns via
`zoompan`. Vary pan direction across consecutive scenes so it doesn't feel
mechanical. Crossfade transitions. Music bed sidechain-ducked under narration.

Cards render as transparent PNGs from HTML templates via playwright, then
overlay. Chapter card timings come from `BeatSheet.chapter_title` boundaries,
and the same boundaries produce the YouTube chapter timestamps in the
description.

Captions export as SRT/VTT sidecar files. **Do not burn captions into the
video** — burned-in word-level captions are a short-form convention and read
as low-effort on long-form documentary.
