import type { LayaClient } from "../client.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const gateTool: ToolDefinition = {
  name: "laya_gate",
  description:
    "Completion gate: same rubric as `laya_review` plus per-claim verification against evidence. " +
    "Use this RIGHT BEFORE claiming a task done -- it checks both the diff and the truthfulness of any " +
    "completion claims (e.g. 'tests pass'). Contradicted claims escalate. At most 61 claims per call " +
    "(3 fixed rubric questions + claims fit the 64-question server budget); diff and evidence at most " +
    "20,000 chars each (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      request: { type: "string", description: "Original task." },
      diff: { type: "string", maxLength: LIMITS.maxStateChars, description: "Proposed diff (max 20,000 chars)." },
      claims: {
        type: "array",
        maxItems: LIMITS.maxGateClaims,
        items: { type: "string" },
        description: "Completion claims to verify (max 61, e.g. 'all tests pass').",
      },
      evidence: {
        type: "string",
        maxLength: LIMITS.maxStateChars,
        description: "Evidence to verify the claims against (max 20,000 chars, e.g. test output).",
      },
    },
    required: ["request", "diff", "claims"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const claims = Array.isArray(args.claims) ? args.claims : [];
    assertCount(
      claims.length,
      LIMITS.maxGateClaims,
      "claims",
      `laya_gate accepts at most ${LIMITS.maxGateClaims} claims per call (3 fixed rubric questions + claims fit the ${LIMITS.maxQuestions}-question server budget)`,
    );
    assertLength(
      String(args.diff ?? ""),
      LIMITS.maxStateChars,
      "diff",
      `diff exceeds ${LIMITS.maxStateChars} chars; gate per file or per hunk instead`,
    );
    assertLength(
      String(args.evidence ?? ""),
      LIMITS.maxStateChars,
      "evidence",
      `evidence exceeds ${LIMITS.maxStateChars} chars; shorten it or gate per claim batch`,
    );
    const out: Record<string, unknown> = {
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
      safe_to_apply: {
        type: "noul",
        instructions: "Is this diff safe to apply without further human review?",
        criteria: {
          true: "Diff is safe to apply automatically.",
          false: "Diff needs human review before applying.",
        },
      },
    };
    claims.forEach((claim, i) => {
      out[`claim_${i}`] = {
        type: "noul",
        instructions: `Is this completion claim supported by the supplied evidence? Claim: '${claim}'`,
        criteria: {
          true: "Claim is directly supported by the evidence.",
          false: "Claim is contradicted or unsupported.",
        },
      };
    });
    return out;
  },
};

export async function handleGate(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const result = await runTool(client, args, gateTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { score: number; noul?: number }>;
    const claimResults = claims.map((claim, i) => {
      const prob = a[`claim_${i}`]?.noul ?? 0;
      const verdict = prob >= 0.8 ? "verified" : prob >= 0.4 ? "unsupported" : "contradicted";
      return { claim, probability: prob, verdict };
    });
    const contradicted = claimResults.filter((c) => c.verdict === "contradicted").length;
    const action = contradicted > 0 ? "escalate" : (a.safe_to_apply?.noul ?? 0) > 0.85 ? "auto" : "review";
    return JSON.stringify(
      {
        action,
        review: { safe_to_apply: a.safe_to_apply?.noul },
        claims: claimResults,
        latency_ms: raw.latencyMs,
      },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
