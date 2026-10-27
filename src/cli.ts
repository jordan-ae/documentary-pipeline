import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRun, GateAbort, DEFAULT_BUDGET_USD } from "./pipeline.ts";
import { runTreatment } from "./stages/treatment.ts";
import { runEvidenceBase } from "./stages/evidence_base.ts";
import { runBeatSheet } from "./stages/beat_sheet.ts";
import { runScript } from "./stages/script.ts";
import { runNarration } from "./stages/narration.ts";
import { fmtUsd, summarize, BudgetExceeded, type CallRecord } from "./cost.ts";
import { countWords, NARRATION_WPM } from "./gates/read_time.ts";

/**
 * The pipeline entry point. Linear by design (docs/DECISIONS.md #3).
 *
 *   npm run run -- --topic "1900 Galveston hurricane" --runtime 600
 *   npm run run -- --run-id galveston-1900 --force script
 */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

async function main() {
  // Node loads .env natively; absent is fine, the client reports a clear error.
  if (existsSync(".env")) process.loadEnvFile(".env");

  const topic = arg("topic");
  const angleHint = arg("angle");
  const targetRuntimeS = Number(arg("runtime", "600"));
  const forceRaw = arg("force");
  const force = forceRaw ? forceRaw.split(",").map((s) => s.trim()) : [];

  // Narration is opt-in. DECISIONS.md #9 puts the human gate at the script,
  // before any asset spend — and narration is where spend and wall-clock
  // start (Breeze runs at ~3x realtime). Passing --narrate IS the approval.
  const narrate = process.argv.includes("--narrate");
  const skipAlign = process.argv.includes("--skip-align");
  const voiceId = arg("voice");

  if (!topic && !arg("run-id")) {
    console.error(
      "usage: npm run run -- --topic <topic> [--angle <hint>] [--runtime <seconds>]\n" +
        "                     [--force <stage,stage>] [--budget <usd>] [--narrate] [--skip-align] [--voice <id>]"
    );
    process.exit(1);
  }

  const budgetUsd = Number(arg("budget", String(DEFAULT_BUDGET_USD)));
  const runId = arg("run-id") ?? slug(topic!);
  const ctx = createRun(runId, force, budgetUsd);

  console.log(`\nrun ${runId}`);
  console.log(`  target runtime ${targetRuntimeS}s`);
  console.log(`  spend cap ${fmtUsd(budgetUsd)} (raise with --budget <usd>)`);
  if (force.length) console.log(`  forcing: ${force.join(", ")}`);
  console.log("");

  const started = Date.now();

  try {
    const treatment = await runTreatment(ctx, {
      topic: topic ?? runId,
      targetRuntimeS,
      ...(angleHint ? { angleHint } : {}),
    });
    console.log(`    angle: ${treatment.angle}`);
    console.log(`    question: ${treatment.central_question}\n`);

    const evidence = await runEvidenceBase(ctx, { treatment });
    console.log("");

    const beatSheet = await runBeatSheet(ctx, { treatment, evidence });
    console.log(`    ${beatSheet.beats.length} beats\n`);

    const script = await runScript(ctx, { treatment, evidence, beatSheet });
    console.log("");

    // The human gate. Write the script as plain prose next to the JSON,
    // because nobody reviews narration by reading JSON.
    const words = script.segments.reduce((a, s) => a + countWords(s.text), 0);
    const readable = [
      `# ${treatment.topic}`,
      ``,
      `${treatment.angle}`,
      ``,
      `${words} words, ~${Math.round((words / NARRATION_WPM) * 60)}s`,
      ``,
      ...beatSheet.beats.flatMap((b) => [
        `## ${b.chapter_title}`,
        ``,
        ...script.segments
          .filter((s) => s.beat_id === b.id)
          .map((s) => `${s.text}\n\n<sub>${s.evidence_ids.join(", ") || "no claims"}</sub>\n`),
      ]),
    ].join("\n");
    const readablePath = join(ctx.dir, "script.md");
    writeFileSync(readablePath, readable);

    console.log(`script passed all gates.`);
    console.log(`  read it: ${readablePath}`);

    if (!narrate) {
      console.log(`  HUMAN APPROVAL required before narration (DECISIONS.md #9).`);
      console.log(`  when the script reads well, rerun with --narrate`);
    } else {
      console.log("");
      const narration = await runNarration(ctx, {
        script,
        ...(voiceId ? { voiceId } : {}),
        ...(skipAlign ? { skipAlign } : {}),
      });
      console.log("");
      console.log(`narration: ${narration.audio_path}`);
      console.log(`  ${narration.duration_s.toFixed(1)}s, ${narration.measured_wpm} wpm, voice ${narration.voice_id}`);
      console.log(`  ${narration.words.length} word timings, ${narration.segments.length} segment offsets`);
    }
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      console.error(`\n${err.message}`);
    } else if (err instanceof GateAbort) {
      console.error(`\n${err.message}`);
      console.error(`\nRejected artifacts saved under fixtures/failures/ — keep them, they are demo material.`);
    } else {
      console.error(`\n${(err as Error).message}`);
    }
    report(ctx.costLog, started);
    process.exit(1);
  }

  report(ctx.costLog, started);
}

function report(costLog: string, started: number) {
  if (!existsSync(costLog)) return;
  const records: CallRecord[] = readFileSync(costLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const s = summarize(records);

  console.log(`\ncost: ${fmtUsd(s.usd)} over ${s.calls} calls, ${Math.round((Date.now() - started) / 1000)}s wall`);
  for (const [model, m] of Object.entries(s.byModel)) {
    console.log(`  ${model.replace("accounts/fireworks/models/", "")}: ${m.calls} calls, ${fmtUsd(m.usd)}`);
  }
  const cached = records.reduce((a, r) => a + r.cached_input_tokens, 0);
  const input = records.reduce((a, r) => a + r.input_tokens, 0);
  if (input) console.log(`  prompt cache hit: ${Math.round((cached / input) * 100)}% of input tokens`);
}

main();
