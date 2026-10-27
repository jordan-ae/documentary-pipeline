import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Failure, GateResult } from "./artifacts.ts";

/**
 * Stage runner: cache, gate, retry, or abort loudly.
 *
 * Per docs/DECISIONS.md #3 this is deliberately not an orchestrator. A stage is
 * a plain async function; the only machinery here is the caching and the gate
 * retry loop, which is all the durability the project needs. If stage 4 crashes
 * you rerun stage 4.
 */

export const MAX_ATTEMPTS = 3;

export type RunContext = {
  runId: string;
  /** runs/<run_id> */
  dir: string;
  /** runs/<run_id>/cost.jsonl */
  costLog: string;
  /** Stages to recompute even though a cached output exists. */
  force: Set<string>;
  /** Hard spend cap for this run, in USD. */
  budgetUsd: number;
};

/** Default cap. A full script-path run should land well under this. */
export const DEFAULT_BUDGET_USD = 1.0;

export function createRun(
  runId: string,
  force: string[] = [],
  budgetUsd: number = DEFAULT_BUDGET_USD
): RunContext {
  const dir = join("runs", runId);
  mkdirSync(dir, { recursive: true });
  return { runId, dir, costLog: join(dir, "cost.jsonl"), force: new Set(force), budgetUsd };
}

export type Gate<T> = (artifact: T, ctx: RunContext) => Promise<GateResult> | GateResult;

export type StageSpec<T extends z.ZodType> = {
  ctx: RunContext;
  name: string;
  schema: T;
  /**
   * Produce the artifact. On a retry, `failures` holds every gate failure from
   * the previous attempt — pass them into the prompt as extra context.
   */
  produce: (failures: Failure[], attempt: number) => Promise<z.infer<T>>;
  gates?: Gate<z.infer<T>>[];
};

/** Thrown when a stage cannot satisfy its gates. Carries the artifact for inspection. */
export class GateAbort extends Error {
  // Explicit fields rather than constructor parameter properties: Node's
  // strip-only type removal cannot synthesise the assignments those imply.
  readonly stage: string;
  readonly failures: Failure[];
  readonly artifact: unknown;

  constructor(stage: string, failures: Failure[], artifact: unknown) {
    super(
      `Stage "${stage}" failed its gates after ${MAX_ATTEMPTS} attempts.\n` +
        failures.map((f) => `  [${f.code}] ${f.message}` + (f.offending ? `\n      ${f.offending}` : "")).join("\n")
    );
    this.name = "GateAbort";
    this.stage = stage;
    this.failures = failures;
    this.artifact = artifact;
  }
}

export async function stage<T extends z.ZodType>(spec: StageSpec<T>): Promise<z.infer<T>> {
  const { ctx, name, schema } = spec;
  const path = join(ctx.dir, `${name}.json`);

  if (existsSync(path) && !ctx.force.has(name)) {
    const cached = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (cached.success) {
      console.log(`  ${name}: cached`);
      return cached.data;
    }
    // A cached file that no longer matches its schema means the schema changed.
    // Silently regenerating would hide that, and silently using it is worse.
    throw new Error(
      `Cached ${path} no longer matches its schema. The schema changed since this run.\n` +
        `Delete the file or pass --force ${name} to regenerate.\n` +
        `--- issues ---\n${JSON.stringify(cached.error.issues, null, 2)}`
    );
  }

  let failures: Failure[] = [];
  let lastArtifact: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const label = attempt === 1 ? name : `${name} (attempt ${attempt})`;
    console.log(`  ${label}: generating`);

    const artifact = await spec.produce(failures, attempt);
    lastArtifact = artifact;

    failures = [];
    for (const gate of spec.gates ?? []) {
      const result = await gate(artifact, ctx);
      if (result.passed) {
        console.log(`    gate ${result.gate}: pass`);
        continue;
      }
      console.log(`    gate ${result.gate}: FAIL (${result.failures.length})`);
      for (const f of result.failures) {
        console.log(`      [${f.code}] ${f.message}`);
        if (f.offending) console.log(`        ${f.offending}`);
      }
      preserveFailure(ctx, name, result, artifact, attempt);
      failures.push(...result.failures);
    }

    if (failures.length === 0) {
      writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n");
      console.log(`  ${name}: written`);
      return artifact;
    }
  }

  throw new GateAbort(name, failures, lastArtifact);
}

/**
 * Save every gate rejection to fixtures/failures/.
 *
 * CLAUDE.md is explicit that this is not debug logging: a grounding gate
 * catching a fabricated date is the most persuasive thing on the demo site. A
 * pipeline that only ever shows clean passes proves nothing, so these files are
 * deliberately kept rather than cleaned up.
 */
function preserveFailure(
  ctx: RunContext,
  stageName: string,
  result: GateResult,
  artifact: unknown,
  attempt: number
): void {
  const dir = join("fixtures", "failures");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ctx.runId}__${stageName}__${result.gate}__a${attempt}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { run_id: ctx.runId, stage: stageName, gate: result.gate, attempt, ts: new Date().toISOString(), failures: result.failures, artifact },
      null,
      2
    ) + "\n"
  );
  console.log(`      saved: ${file}`);
}

export function pass(gate: string): GateResult {
  return { gate, passed: true, failures: [] };
}

export function fail(gate: string, failures: Failure[]): GateResult {
  return { gate, passed: failures.length === 0, failures };
}
