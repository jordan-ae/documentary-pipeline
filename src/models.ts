/**
 * Model registry.
 *
 * IDs and prices verified against the Fireworks model library on 2026-09-14.
 * CLAUDE.md requires verifying IDs before use — if you change a model, re-check
 * the ID *and* the price, because the cost meter reports nonsense otherwise.
 *
 *   kimi-k3        accounts/fireworks/models/kimi-k3        $3.00 / $0.30 / $15.00
 *   glm-5p3-flash  accounts/fireworks/models/glm-5p3-flash  $0.15 / $0.03 / $0.50
 *
 * (input / cached input / output per 1M tokens, confirmed against
 * docs.fireworks.ai/serverless/pricing on 2026-09-14)
 *
 * Note kimi-k3 is ~20x the output price of the flash model. Per CLAUDE.md it is
 * reserved for research and script writing. Gates and classifiers use CHEAP.
 */

export type ModelSpec = {
  id: string;
  /** USD per 1M tokens. */
  price: { input: number; cachedInput: number; output: number };
};

/** Research and script writing only. Expensive. */
export const WRITER: ModelSpec = {
  id: "accounts/fireworks/models/kimi-k3",
  price: { input: 3.0, cachedInput: 0.3, output: 15.0 },
};

/** Gates, classifiers, extraction, and the vision semantic_match. Default. */
export const CHEAP: ModelSpec = {
  id: "accounts/fireworks/models/glm-5p3-flash",
  price: { input: 0.15, cachedInput: 0.03, output: 0.5 },
};

export function usdFor(
  spec: ModelSpec,
  usage: { input: number; cachedInput: number; output: number }
): number {
  const uncachedInput = Math.max(0, usage.input - usage.cachedInput);
  return (
    (uncachedInput * spec.price.input +
      usage.cachedInput * spec.price.cachedInput +
      usage.output * spec.price.output) /
    1_000_000
  );
}
