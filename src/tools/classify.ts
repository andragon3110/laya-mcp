import type { LayaClient } from "../client.js";
import { LIMITS, assertCount } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const classifyTool: ToolDefinition = {
  name: "laya_classify",
  description:
    "Batch-classify items against a shared catalog of classes. One catalog is sent once and every item is " +
    "scored in parallel. Includes an optional 'other' / 'manual_review' class to surface low-confidence cases. " +
    "At most 64 items per call (one question per item, matching the server question budget); larger batches " +
    "are rejected with input_too_large.",
  inputSchema: {
    type: "object",
    properties: {
      purpose: { type: "string", description: "Why you are classifying these items (helps the description)." },
      items: {
        type: "array",
        maxItems: LIMITS.maxClassifyItems,
        description: "Items to classify (max 64). Each needs `id` and `text`.",
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
        },
      },
      classes: {
        type: "array",
        description: "Catalog. Each entry needs `id` (the label) and `description` (what it means).",
        items: {
          type: "object",
          properties: { id: { type: "string" }, description: { type: "string" } },
          required: ["id", "description"],
        },
      },
    },
    required: ["purpose", "items", "classes"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const items = Array.isArray(args.items) ? args.items : [];
    const classes = Array.isArray(args.classes) ? args.classes : [];
    assertCount(
      items.length,
      LIMITS.maxClassifyItems,
      "items",
      `laya_classify accepts at most ${LIMITS.maxClassifyItems} items per call (one server question each); split into batches`,
    );
    const criteria: Record<string, string> = {};
    for (const c of classes) {
      if (c && typeof c.id === "string") criteria[c.id] = String(c.description ?? "").slice(0, 240);
    }
    if (!criteria.other && !criteria.manual_review) criteria.other = "None of the defined classes fit.";
    const out: Record<string, unknown> = {};
    items.forEach((item: { id?: string }, i: number) => {
      if (!item || typeof item.id !== "string") return;
      out[`class_${i}_${item.id}`] = {
        type: "choice",
        instructions: `Assign item "${item.id}" to the class that best matches: ${args.purpose ?? ""}.`,
        criteria,
      };
    });
    return out;
  },
};

export async function handleClassify(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const items = Array.isArray(args.items) ? args.items : [];
  const result = await runTool(client, args, classifyTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const classifications = items.map((item: { id?: string }, i: number) => {
      const ans = a[`class_${i}_${item.id}`];
      return {
        id: item.id,
        classification: ans?.choice ?? "other",
        confidence: ans ? Math.max(...Object.values(ans.probabilities ?? {})) : 0,
      };
    });
    return JSON.stringify({ classifications, latency_ms: raw.latencyMs }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
