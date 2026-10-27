import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cost + call log. Append-only JSONL, per CLAUDE.md: no observability platform,
 * just a file we can sum. One line per LLM call, written as the call returns so
 * a crashed run still accounts for what it spent.
 */

export type CallRecord = {
  ts: string;
  run_id: string;
  stage: string;
  /** Set when the call is a gate rather than a generation step. */
  gate: string | null;
  model: string;
  attempt: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  usd: number;
  ms: number;
};

export function logCall(path: string, record: CallRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

export function summarize(records: CallRecord[]) {
  const usd = records.reduce((a, r) => a + r.usd, 0);
  const byModel: Record<string, { calls: number; usd: number }> = {};
  for (const r of records) {
    const bucket = (byModel[r.model] ??= { calls: 0, usd: 0 });
    bucket.calls += 1;
    bucket.usd += r.usd;
  }
  return { calls: records.length, usd, byModel };
}

/** Cents, not dollars — most stages cost well under a dollar. */
export function fmtUsd(usd: number): string {
  return usd < 1 ? `${(usd * 100).toFixed(2)}c` : `$${usd.toFixed(2)}`;
}

/* ------------------------------------------------------------ budget guard */

/**
 * Running spend per run, so a bad gate loop cannot quietly burn money.
 *
 * This exists because a single aborted run once made 12 calls and 209k output
 * tokens retrying a gate that could not pass, and produced no artifact. The
 * cap turns that from a billing surprise into a loud stop.
 */
const spentByRun = new Map<string, number>();

export class BudgetExceeded extends Error {
  readonly runId: string;
  readonly spent: number;
  readonly budget: number;

  constructor(runId: string, spent: number, budget: number) {
    super(
      `Run "${runId}" hit its spend cap: ${fmtUsd(spent)} of ${fmtUsd(budget)} budget.\n` +
        `Nothing further will be requested. Raise it with --budget <usd> if this is expected,\n` +
        `but check runs/${runId}/cost.jsonl first — a run that spends this much without\n` +
        `finishing is usually a gate rejecting work it should accept.`
    );
    this.name = "BudgetExceeded";
    this.runId = runId;
    this.spent = spent;
    this.budget = budget;
  }
}

export function addSpend(runId: string, usd: number): number {
  const total = (spentByRun.get(runId) ?? 0) + usd;
  spentByRun.set(runId, total);
  return total;
}

export function getSpend(runId: string): number {
  return spentByRun.get(runId) ?? 0;
}

/**
 * Checked BEFORE each call, using spend already incurred.
 *
 * Overshoot is bounded by the number of calls in flight, not by one call,
 * because concurrent requests all clear this check before any of them reports
 * its cost. That is why the fan-out in evidence_base and grounding is bounded
 * rather than an unbounded Promise.all.
 */
export function assertWithinBudget(runId: string, budget: number): void {
  const spent = getSpend(runId);
  if (spent >= budget) throw new BudgetExceeded(runId, spent, budget);
}
