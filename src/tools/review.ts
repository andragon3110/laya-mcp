import type { LayaClient } from "../client.js";
import { reviewEvidence } from "../evidence.js";
import { LIMITS, assertLength } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const reviewTool: ToolDefinition = {
  name: "laya_review",
  description:
    "Score a proposed diff against the request before merging. Returns 0-2 scores for correctness, " +
    "spec_match, test_gap, blast_radius, plus a safe_to_apply probability. Use this BEFORE declaring " +
    "any coding task done -- it judges the diff against your stated request. " +
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

export async function handleReview(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const result = await runTool(client, args, reviewTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { score: number; confidence?: number; noul?: number }>;
    const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const { evidence, abstention } = reviewEvidence(raw, {
      correctness: numOrNull(a.correctness?.score),
      spec_match: numOrNull(a.spec_match?.score),
      test_gap: numOrNull(a.test_gap?.score),
      blast_radius: numOrNull(a.blast_radius?.score),
      safe_to_apply: numOrNull(a.safe_to_apply?.noul),
    });
    return JSON.stringify(
      {
        scores: {
          correctness: a.correctness?.score,
          spec_match: a.spec_match?.score,
          test_gap: a.test_gap?.score,
          blast_radius: a.blast_radius?.score,
        },
        safe_to_apply: a.safe_to_apply?.noul,
        // P1-T3: legacy decision, engine-owned from T5/T6
        action: (a.safe_to_apply?.noul ?? 0) > 0.85 ? "auto" : (a.safe_to_apply?.noul ?? 0) > 0.5 ? "review" : "escalate",
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
