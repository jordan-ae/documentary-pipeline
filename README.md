# documentary-pipeline

Topic in, narrated long-form history documentary out, with every sentence in the script traceable to a source.

Most AI video pipelines write a script and fact-check it afterwards. This one researches first: it builds an evidence base of atomic, sourced claims and then writes only from that evidence. Every stage writes a typed artifact to `runs/<run_id>/`, and a gate checks it before the next stage runs. The pipeline stops for human approval at the script, before any money goes on narration.

## Pipeline

```
topic
  → treatment        [gate: viability]
  → evidence_base    [gate: sufficiency]
  → beat_sheet       [gate: structure]
  → script           [gates: grounding, prose, read_time]   ← human approval
  → narration        [gate: asr_diff]
  → shot_list → asset_manifest → assembly_spec → video.mp4
```

It's linear on purpose, not an agent: the path is known, so stages are plain functions with model calls inside them. Rerunning skips any stage whose artifact already exists, unless you pass `--force <stage>`.

## The gates

- **viability**: can the treatment sustain its runtime? It needs a conflict, a timeline and a reveal, or the script reads like an encyclopedia entry stretched to length.
- **sufficiency**: is the evidence base enough to write from? Counts, source diversity and claim atomicity are computed in code; only coverage of the central question goes to a model.
- **structure**: do the story's open loops close, and is the reveal held back? Loop bookkeeping and evidence IDs are checked as graph properties in code.
- **grounding**: the one that can't be skipped. Claims are extracted from the script with no evidence in view, then each one is verified against the evidence it cites. If extraction could see the evidence, it would quietly skip the invented sentences, and they could never fail.
- **prose**: runs on the expensive model and looks for the tells of generated writing, rather than asking "is this good?", which only produces flattery.
- **read_time**: arithmetic, calibrated at 162 words per minute measured from the TTS voice actually used.
- **asr_diff**: transcribes the narration back and compares it with the script, to catch mispronounced names, dropped words and mangled numbers.

Every model call is logged with its tokens and cost to `runs/<run_id>/cost.jsonl`, and a run stops at its budget.

## Status

Built: treatment, evidence base, beat sheet, script and narration, with their gates. Next up: the shot list, the archival asset manifest from Wikimedia Commons, and assembly. One sample run, *1900 Galveston hurricane*, is in `runs/`, and `fixtures/failures/` holds real gate failures from it.

[`docs/`](docs) has the architecture, the design brief for the demo site, the week-one plan, and the reasoning behind the choices that look arbitrary.

## Run it

Needs Node 22 or newer, plus a Fireworks API key for the models and a BreezeBlue key for narration.

```bash
npm install
cp .env.example .env    # add FIREWORKS_API_KEY and BREEZE_API_KEY
npm run run -- --topic "1900 Galveston hurricane" --runtime 600
npm run run -- --run-id 1900-galveston-hurricane --narrate    # after you approve the script
```

## License

[MIT](LICENSE)
