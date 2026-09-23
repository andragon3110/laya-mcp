import type { LayaClient } from "../client.js";
import { verifyEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const verifyTool: ToolDefinition = {
  name: "laya_verify",
  description:
    "Verify one or more claims against the supplied evidence. Each claim is judged independently " +
    "(verified / contradicted / unsupported) with a calibrated probability. Use to fact-check PR descriptions, " +
    "agent briefs, or any statement before relying on it. At most 64 claims per call (one question each) " +
    "and evidence at most 20,000 chars (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        maxItems: LIMITS.maxVerifyClaims,
        items: { type: "string" },
        description: "Claims to verify (max 64). One independent judgment per claim.",
      },
      evidence: {
        type: "string",
        maxLength: LIMITS.maxStateChars,
        description: "Evidence text (max 20,000 chars). The agent's instructions for what to judge are explicit; do not let other fields leak in.",
      },
    },
    required: ["claims", "evidence"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const claims = Array.isArray(args.claims) ? args.claims : [];
    assertCount(
      claims.length,
      LIMITS.maxVerifyClaims,
      "claims",
      `laya_verify accepts at most ${LIMITS.maxVerifyClaims} claims per call (one server question each); split into batches`,
    );
    assertLength(
      String(args.evidence ?? ""),
      LIMITS.maxStateChars,
      "evidence",
      `evidence exceeds ${LIMITS.maxStateChars} chars; shorten it or verify per section`,
    );
    const out: Record<string, unknown> = {};
    claims.forEach((claim, i) => {
      out[`claim_${i}`] = {
        type: "noul",
        instructions: `Decide if the following claim is directly supported by the evidence. Claim: "${claim}"`,
        criteria: {
          true: "Evidence directly states or implies the claim.",
          false: "Evidence contradicts the claim or does not address it.",
        },
      };
    });
    return out;
  },
};

export async function handleVerify(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const result = await runTool(client, args, verifyTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { noul: number }>;
    const verdicts = claims.map((claim, i) => {
      const prob = a[`claim_${i}`]?.noul ?? 0;
      // P1-T3: legacy decision, engine-owned from T5/T6
      const verdict = prob >= 0.8 ? "verified" : prob >= 0.4 ? "unsupported" : "contradicted";
      return { claim, probability: prob, verdict };
    });
    const summary = {
      verified: verdicts.filter((v) => v.verdict === "verified").length,
      unsupported: verdicts.filter((v) => v.verdict === "unsupported").length,
      contradicted: verdicts.filter((v) => v.verdict === "contradicted").length,
    };
    const { evidence, abstention } = verifyEvidence(
      raw,
      {
        claims: verdicts.map((v, i) => ({
          claim: String(v.claim),
          signal: typeof a[`claim_${i}`]?.noul === "number" ? (a[`claim_${i}`].noul as number) : null,
          verdict: v.verdict,
        })),
      },
    );
    return JSON.stringify({ summary, verdicts, latency_ms: raw.latencyMs, evidence, abstention }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
