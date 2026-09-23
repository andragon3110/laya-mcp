import type { LayaClient } from "../client.js";
import { classifyEvidence, winnerOf } from "../evidence.js";
import { LIMITS, assertCount } from "../limits.js";
import { evaluateForTool } from "../policy/mode.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, shadowSchema, envelopeMetadataProperties } from "../tool.js";

export const classifyTool: ToolDefinition = {
  name: "laya_classify",
  description:
    "Batch-classify items against a shared catalog of classes. One catalog is sent once and every item is " +
    "scored in parallel. Includes an optional 'other' / 'manual_review' class to surface weak-signal cases. " +
    "Each item returns its raw, uncalibrated winner_probability (never a confidence) plus the deterministic " +
    "ALLOW/ESCALATE `decision` from the versioned classify@1.0.0 policy. An ESCALATE decision is authoritative. " +
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
  outputSchema: {
    type: "object",
    properties: {
      ...envelopeMetadataProperties(),
      classifications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            classification: { type: "string" },
            winner_probability: {
              type: ["number", "null"],
              description: "Top raw share (never a confidence); null when the answer is missing or the dict came back empty.",
            },
          },
          required: ["classification", "winner_probability"],
        },
      },
      decision: decisionSchema(["ALLOW", "ESCALATE"]),
      shadow: shadowSchema(),
      latency_ms: { type: "number" },
      evidence: evidenceSchema("Classify evidence bundle (per-item choice signals)."),
      abstention: abstentionSchema(),
    },
    required: ["classifications", "decision", "latency_ms", "evidence", "abstention"],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
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

/**
 * P1-T6 (breaking): `laya_classify` routes the labels through the engine.
 * Each entry's legacy `confidence` number (Math.max over the raw choice
 * dict, uncalibrated -- and 0 when the backend gave no answer) is now the
 * honestly named `winner_probability` (null when the answer is missing or
 * the dict came back empty; the P1-T3 -Infinity bugfix stays), and the
 * output carries the ALLOW-or-ESCALATE `decision` from classify@1.0.0. T3
 * abstention (missing answers, empty distributions) is now authoritative
 * via the engine ESCALATE exit. No threshold literal lives here: v1 never
 * cuts, firmness is signal presence.
 */
export async function handleClassify(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const items = Array.isArray(args.items) ? args.items : [];
  const result = await runTool(client, args, classifyTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const classifications = items.map((item: { id?: string }, i: number) => {
      const ans = a[`class_${i}_${item.id}`];
      // P1-T3 bugfix preserved: Math.max(...[]) is -Infinity for an empty
      // dict; the honest winner_probability is null instead.
      const winner = ans ? winnerOf(ans.probabilities ?? {}) : null;
      return {
        id: item.id,
        classification: ans?.choice ?? "other",
        winner_probability: ans ? winner : null,
      };
    });
    const { evidence, abstention } = classifyEvidence(raw, {
      items: items.map((item: { id?: string }, i: number) => {
        const ans = a[`class_${i}_${item.id}`];
        return {
          id: String(item.id),
          choice: ans?.choice ?? "other",
          distribution: (ans?.probabilities as Record<string, number> | undefined) ?? null,
          missing: ans == null,
        };
      }),
    });
    // P1-T6: decision owned by the engine.
    const { thresholds } = getPolicy("classify", "1.0.0");
    const { decision, shadow } = evaluateForTool(
      "laya_classify",
      {
        evidence,
        abstention,
        context: { item_count: items.length },
        risk: "normal",
        policy: { name: "classify", version: "1.0.0" },
      },
      { thresholds },
    );
    return JSON.stringify({ classifications, decision, ...(shadow ? { shadow } : {}), latency_ms: raw.latencyMs, evidence, abstention }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
