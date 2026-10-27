import OpenAI from "openai";
import { z } from "zod";
import { jsonSchemaFor } from "../schema.ts";
import { usdFor, WRITER, type ModelSpec } from "../models.ts";
import { logCall, addSpend, assertWithinBudget, type CallRecord } from "../cost.ts";

/**
 * The only path to an LLM in this project.
 *
 * Every call is metered, every call is schema-constrained, and every failure
 * prints the offending payload. There is deliberately no unstructured
 * completion helper: if a stage wants free text it can ask for a schema with
 * one string field, and we keep the parse guarantee.
 */

const BASE_URL = "https://api.fireworks.ai/inference/v1";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "FIREWORKS_API_KEY is not set.\n" +
        "Get a key at https://app.fireworks.ai/settings/users/api-keys, then:\n" +
        "  cp .env.example .env && echo 'FIREWORKS_API_KEY=fw_...' >> .env"
    );
  }
  client = new OpenAI({ apiKey, baseURL: BASE_URL, timeout: 300_000, maxRetries: 0 });
  return client;
}

export type CallOpts<T extends z.ZodType> = {
  model: ModelSpec;
  /** Names the schema for the model and labels the log line. */
  name: string;
  schema: T;
  system: string;
  user: string;
  /** Where the JSONL call log goes. */
  costLog: string;
  runId: string;
  stage: string;
  gate?: string;
  /** Hard spend cap for the run, in USD. Checked before every call. */
  budgetUsd: number;
  temperature?: number;
  maxRetries?: number;
  /**
   * Cap on hidden reasoning tokens.
   *
   * Both models reason by default and bill it as output. Measured on a real
   * gate prompt: 6,225 output tokens uncapped, of which ~158 were the actual
   * answer — 97% overhead. `reasoning_effort: "low"` does NOT help (it
   * measured 7,150, worse than the default), but a `thinking` budget does:
   * 1,024 brought the same call to 1,291 tokens with the judgment intact.
   *
   * Defaults by tier, overridable per call.
   */
  thinkingBudget?: number;
};

/** Enough for gate judgments and extraction, which is most calls. */
const CHEAP_THINKING_BUDGET = 1024;

/** Writing and prose criticism earn more room to think. */
const WRITER_THINKING_BUDGET = 4096;

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

export async function complete<T extends z.ZodType>(opts: CallOpts<T>): Promise<z.infer<T>> {
  const maxRetries = opts.maxRetries ?? 3;
  const responseFormat = jsonSchemaFor(opts.name, opts.schema);

  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Before, not after: a run that has already blown its cap must not make
    // one more expensive call to discover that.
    assertWithinBudget(opts.runId, opts.budgetUsd);

    const started = Date.now();
    try {
      const budget =
        opts.thinkingBudget ??
        (opts.model.id === WRITER.id ? WRITER_THINKING_BUDGET : CHEAP_THINKING_BUDGET);

      const res = await getClient().chat.completions.create({
        model: opts.model.id,
        temperature: opts.temperature ?? 0.7,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
        // Cast: neither the Fireworks json_schema form nor `thinking` is in the
        // OpenAI SDK's union. `thinking` and `reasoning_effort` are mutually
        // exclusive — Fireworks rejects requests carrying both.
        response_format: responseFormat as never,
        thinking: { type: "enabled", budget_tokens: budget },
      } as never);

      const usage = {
        input: res.usage?.prompt_tokens ?? 0,
        cachedInput: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        output: res.usage?.completion_tokens ?? 0,
      };

      const record: CallRecord = {
        ts: new Date().toISOString(),
        run_id: opts.runId,
        stage: opts.stage,
        gate: opts.gate ?? null,
        model: opts.model.id,
        attempt,
        input_tokens: usage.input,
        cached_input_tokens: usage.cachedInput,
        output_tokens: usage.output,
        usd: usdFor(opts.model, usage),
        ms: Date.now() - started,
      };
      logCall(opts.costLog, record);
      addSpend(opts.runId, record.usd);

      const raw = res.choices[0]?.message?.content;
      if (!raw) throw new Error("Fireworks returned an empty message.");

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        // Fail loudly with the artifact, per CLAUDE.md. Never salvage.
        throw new Error(
          `${opts.name}: response was not valid JSON despite response_format.\n--- raw ---\n${raw}`
        );
      }

      const parsed = opts.schema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(
          `${opts.name}: response did not match its schema.\n` +
            `--- issues ---\n${JSON.stringify(parsed.error.issues, null, 2)}\n` +
            `--- payload ---\n${JSON.stringify(parsedJson, null, 2)}`
        );
      }

      return parsed.data;
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      const retryable = status !== undefined && RETRYABLE.has(status);

      if (!retryable || attempt === maxRetries) break;

      const backoff = 1000 * 2 ** (attempt - 1);
      console.warn(`  ${opts.name}: ${status}, retrying in ${backoff}ms (${attempt}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  throw lastErr;
}
