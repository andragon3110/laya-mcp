import type { LayaClient } from "../client.js";
import { reviewEvidence } from "../evidence.js";
import { LIMITS, assertLength } from "../limits.js";
import { evaluateForTool } from "../policy/mode.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, shadowSchema, envelopeMetadataProperties } from "../tool.js";

export const reviewTool: ToolDefinition = {
  name: "laya_review",
  description:
    "Score a proposed diff against the request before merging. Returns rubric EVIDENCE ONLY " +
    "(0-2 scores for correctness, spec_match, test_gap, blast_radius as {score} objects, plus a " +
    "safe_to_apply {signal} object carrying the raw, uncalibrated safety signal -- never a " +
    "probability and never an authorization). The ALLOW/REVIEW/ESCALATE decision comes from the " +
    "versioned review@1.0.0 policy (code-review@1.0.0 is the same cut points under a workflow " +
    "name) and is carried in `decision`. This tool never authorizes anything by itself. " +
    "Diff at most 20,000 chars (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      request: { type: "string", description: "What the diff is supposed to accomplish." },
      diff: { type: "string", maxLength: LIMITS.maxStateChars, description: "Unified diff or patch (max 20,000 chars)." },
      tests: { type: "string", description: "Optional test output or description." },
    },
    required: ["request", "diff"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      ...envelopeMetadataProperties(),
      rubric: {
        type: "object",
        description: "Rubric EVIDENCE ONLY: 0-2 scores plus the raw safe_to_apply signal (never an authorization).",
        properties: {
          correctness: {
            type: "object",
            properties: { score: { type: ["integer", "null"] } },
            required: ["score"],
          },
          spec_match: {
            type: "object",
            properties: { score: { type: ["integer", "null"] } },
            required: ["score"],
          },
          test_gap: {
            type: "object",
            properties: { score: { type: ["integer", "null"] } },
            required: ["score"],
          },
          blast_radius: {
            type: "object",
            properties: { score: { type: ["integer", "null"] } },
            required: ["score"],
          },
          safe_to_apply: {
            type: "object",
            properties: { signal: { type: ["number", "null"] } },
            required: ["signal"],
          },
        },
        required: ["correctness", "spec_match", "test_gap", "blast_radius", "safe_to_apply"],
      },
      decision: decisionSchema(["ALLOW", "REVIEW", "ESCALATE"]),
      shadow: shadowSchema(),
      latency_ms: { type: "number" },
      evidence: evidenceSchema("Review evidence bundle (rubric + safety signals)."),
      abstention: abstentionSchema(),
    },
    required: ["rubric", "decision", "latency_ms", "evidence", "abstention"],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  buildQuestions: (args) => {
    assertLength(
      String(args.diff ?? ""),
      LIMITS.maxStateChars,
      "diff",
      `diff exceeds ${LIMITS.maxStateChars} chars; review per file or per hunk instead of the whole patch at once`,
    );
    return {
    correctness: {
      type: "score",
      instructions: "Does the diff correctly implement the request?",
      criteria: ["breaks it", "partially correct", "fully correct"],
    },
    spec_match: {
      type: "score",
      instructions: "Does the diff match the original specification?",
      criteria: ["ignores spec", "partial match", "exact match"],
    },
    test_gap: {
      type: "score",
      instructions: "How much of the diff is uncovered by tests?",
      criteria: ["fully tested", "some gaps", "untested"],
    },
    blast_radius: {
      type: "score",
      instructions: "How broad is the impact of this change?",
      criteria: ["trivial blast radius", "moderate", "risky"],
    },
    safe_to_apply: {
      type: "noul",
      instructions: "Is this diff safe to apply without further human review?",
      criteria: {
        true: "Diff is safe to apply automatically.",
        false: "Diff needs human review before applying.",
      },
    },
  };
  },
};

/**
 * P1-T5 (breaking): `laya_review` produces EVIDENCE ONLY plus the engine
 * decision. The legacy `scores` flat numbers, the top-level `safe_to_apply`
 * number, and the inline `action` (auto/review/escalate) are gone; the
 * rubric now ships as objects ({score} / {signal}) and the decision as
 * `{decision, reason_codes, policy}` from review@1.0.0. No threshold
 * literal remains in this handler: cut points live in the shared policy
 * table and the policy owns the mapping.
 */
export async function handleReview(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const result = await runTool(client, args, reviewTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { score?: number; noul?: number }>;
    const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const correctness = numOrNull(a.correctness?.score);
    const spec_match = numOrNull(a.spec_match?.score);
    const test_gap = numOrNull(a.test_gap?.score);
    const blast_radius = numOrNull(a.blast_radius?.score);
    const safe_to_apply = numOrNull(a.safe_to_apply?.noul);
    const { evidence, abstention } = reviewEvidence(raw, {
      correctness,
      spec_match,
      test_gap,
      blast_radius,
      safe_to_apply,
    });
    // P1-T5: decision owned by the engine. Thresholds resolve here (shared
    // table + documented env overrides); the handler never branches on a
    // numeric cut point.
    const { thresholds } = getPolicy("review", "1.0.0");
    const { decision, shadow } = evaluateForTool(
      "laya_review",
      {
        evidence,
        abstention,
        context: { diff_chars: String(args.diff ?? "").length },
        risk: "normal",
        policy: { name: "review", version: "1.0.0" },
      },
      { thresholds },
    );
    return JSON.stringify(
      {
        rubric: {
          correctness: { score: correctness },
          spec_match: { score: spec_match },
          test_gap: { score: test_gap },
          blast_radius: { score: blast_radius },
          safe_to_apply: { signal: safe_to_apply },
        },
        decision,
        ...(shadow ? { shadow } : {}),
        latency_ms: raw.latencyMs,
        evidence,
        abstention,
      },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
