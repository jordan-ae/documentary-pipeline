import { z } from "zod";

/**
 * zod -> JSON Schema for Fireworks `response_format`.
 *
 * CLAUDE.md: never hand-write a schema that duplicates a zod type. This is the
 * only place a schema is produced, so the parser and the prompt contract cannot
 * drift apart.
 *
 * Fireworks accepts OpenAI-style {type:"json_schema", json_schema:{name,schema}}
 * and resolves in-document $defs/$ref, so nested and reused zod types survive.
 */

type JsonNode = Record<string, unknown>;

/**
 * Constrained decoding is much better behaved when every object is closed and
 * every property is required. zod's default object mode leaves
 * additionalProperties unset and omits nullable fields from `required`, which
 * lets the model skip keys we rely on. Tighten both, recursively.
 */
function harden(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(harden);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const n = node as JsonNode;

  if (n.type === "object" && n.properties && typeof n.properties === "object") {
    n.additionalProperties = false;
    n.required = Object.keys(n.properties as JsonNode);
  }

  for (const key of Object.keys(n)) harden(n[key]);
}

export function jsonSchemaFor(name: string, schema: z.ZodType): JsonNode {
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as JsonNode;

  harden(json);

  return {
    type: "json_schema",
    json_schema: { name, schema: json },
  };
}
