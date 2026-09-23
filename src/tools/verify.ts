import type { LayaClient } from "../client.js";
import { verifyEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema } from "../tool.js";

export const verifyTool: ToolDefinition = {
  name: "laya_verify",
  description:
    "Verify one or more claims against the supplied evidence. Each claim carries its raw, " +
    "uncalibrated support {signal} plus an honest verdict: SUPPORTED (signal at/above the shared " +
    "verified cut), INSUFFICIENT_EVIDENCE (present signal below the cut -- absence of evidence is " +
    "never labelled a contradiction), or ABSTAIN (signal missing). CONTRADICTED is reserved for " +
    "positive refutation evidence no v1 detector carries, so v1 never emits it. The aggregate " +
    "ALLOW/REVIEW/DENY/ESCALATE decision comes from the versioned verify@1.0.0 policy. " +
    "Empty claims yield a structured ABSTAIN (no zero summary). At most 64 claims per call " +
    "(one question each) and evidence at most 20,000 chars (larger inputs are rejected with input_too_large).",
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
  outputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "object",
        description: "Aggregate counts. Absent when claims is empty (structured ABSTAIN).",
        properties: {
          supported: { type: "integer" },
          insufficient_evidence: { type: "integer" },
          contradicted: { type: "integer" },
          abstain: { type: "integer" },
        },
        required: ["supported", "insufficient_evidence", "contradicted", "abstain"],
      },
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            signal: { type: ["number", "null"] },
            verdict: {
              type: "string",
              enum: ["SUPPORTED", "INSUFFICIENT_EVIDENCE", "ABSTAIN", "CONTRADICTED"],
              description: "CONTRADICTED is reserved for positive refutation evidence; v1 never emits it.",
            },
          },
          required: ["claim", "signal", "verdict"],
        },
      },
      decision: decisionSchema(["ALLOW", "REVIEW", "DENY", "ESCALATE"]),
      latency_ms: { type: "number" },
      evidence: evidenceSchema("Verify evidence bundle (per-claim signals + metadata)."),
      abstention: abstentionSchema(),
    },
    required: ["verdicts", "decision", "latency_ms", "evidence", "abstention"],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
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

/**
 * P1-T5 (breaking): `laya_verify` verdicts are SUPPORTED / INSUFFICIENT_EVIDENCE /
 * ABSTAIN (+ reserved CONTRADICTED, never emitted from a support signal alone).
 * The legacy `{probability, verdict: verified|unsupported|contradicted}` labels are
 * gone -- low signals are absence of evidence, never refutation -- and the empty
 * case returns a structured ABSTAIN with the engine ESCALATE decision instead of
 * a zero summary. The aggregate decision is `{decision, reason_codes, policy}`
 * from verify@1.0.0. No threshold literal remains in this handler: the SUPPORT
 * display cut resolves from the shared table; the engine owns every cut point.
 */
export async function handleVerify(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const result = await runTool(client, args, verifyTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { noul?: number }>;
    // P1-T5: decision and display cuts resolve from the shared table.
    const { thresholds } = getPolicy("verify", "1.0.0");
    const verdictFor = (signal: number | null): string =>
      signal === null ? "ABSTAIN" : signal >= thresholds.claimVerified ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE";
    const verdicts = claims.map((claim, i) => {
      const answer = a[`claim_${i}`]?.noul;
      const signal = typeof answer === "number" ? answer : null;
      return { claim: String(claim), signal, verdict: verdictFor(signal) };
    });
    const { evidence, abstention } = verifyEvidence(raw, {
      claims: verdicts.map((v) => ({ claim: v.claim, signal: v.signal, verdict: v.verdict })),
    });
    const decision = evaluate(
      {
        evidence,
        abstention,
        context: { claim_count: claims.length, evidence_chars: String(args.evidence ?? "").length },
        risk: "normal",
        policy: { name: "verify", version: "1.0.0" },
      },
      { thresholds },
    );
    // P1-T5: empty claims abstain structurally -- no zero summary. The
    // engine maps the abstained evidence to ESCALATE + abstained_evidence.
    if (verdicts.length === 0) {
      return JSON.stringify({ verdicts: [], decision, latency_ms: raw.latencyMs, evidence, abstention }, null, 2);
    }
    const summary = {
      supported: verdicts.filter((v) => v.verdict === "SUPPORTED").length,
      insufficient_evidence: verdicts.filter((v) => v.verdict === "INSUFFICIENT_EVIDENCE").length,
      contradicted: verdicts.filter((v) => v.verdict === "CONTRADICTED").length,
      abstain: verdicts.filter((v) => v.verdict === "ABSTAIN").length,
    };
    return JSON.stringify({ summary, verdicts, decision, latency_ms: raw.latencyMs, evidence, abstention }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
