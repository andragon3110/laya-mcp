import type { LayaClient } from "../client.js";
import { verifyEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluateForTool } from "../policy/mode.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, shadowSchema, envelopeMetadataProperties } from "../tool.js";

export const verifyTool: ToolDefinition = {
  name: "laya_verify",
  description:
    "Verify one or more claims against the supplied evidence. Each claim carries TWO raw, " +
    "uncalibrated probes: {signal} support (does the evidence state/imply the claim?) plus a " +
    "separate refutation probe (does the evidence DENY the claim? -- positive refutation only, " +
    "never absence or silence). The honest verdict is: SUPPORTED (support at/above the shared " +
    "verified cut without firm denial), CONTRADICTED (firm denial at/above the same cut plus weak " +
    "support -- emitted only on positive refutation, never from a low support signal alone), " +
    "INSUFFICIENT_EVIDENCE (weak support without firm denial, or conflicting firm probes), or " +
    "ABSTAIN (either probe missing). The aggregate ALLOW/REVIEW/DENY/ESCALATE decision comes " +
    "from the versioned verify@1.0.0 policy. " +
    "Empty claims yield a structured ABSTAIN (no zero summary). At most 32 claims per call " +
    "(two questions each: support + refutation) and evidence at most 20,000 chars (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        maxItems: LIMITS.maxVerifyClaims,
        items: { type: "string" },
        description: "Claims to verify (max 32). Two independent judgments per claim: support + refutation.",
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
      ...envelopeMetadataProperties(),
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
              description: "CONTRADICTED needs positive refutation (firm denial + weak support); low support alone is INSUFFICIENT_EVIDENCE, never a contradiction.",
            },
          },
          required: ["claim", "signal", "verdict"],
        },
      },
      decision: decisionSchema(["ALLOW", "REVIEW", "DENY", "ESCALATE"]),
      shadow: shadowSchema(),
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
      `laya_verify accepts at most ${LIMITS.maxVerifyClaims} claims per call (two server questions each: support + refutation); split into batches`,
    );
    assertLength(
      String(args.evidence ?? ""),
      LIMITS.maxStateChars,
      "evidence",
      `evidence exceeds ${LIMITS.maxStateChars} chars; shorten it or verify per section`,
    );
    const out: Record<string, unknown> = {};
    claims.forEach((claim, i) => {
      // fut-b-semantica T3: two independent probes per claim. The support
      // probe asks affirmation; the refutation probe asks denial. A low
      // support answer is absence of evidence, never refutation -- only a
      // firm refutation answer (evidence that DENIES the claim) can yield
      // CONTRADICTED, and only together with weak support.
      out[`claim_${i}`] = {
        type: "noul",
        instructions: `Decide if the following claim is directly supported by the evidence. Claim: "${claim}"`,
        criteria: {
          true: "Evidence directly states or implies the claim.",
          false: "Evidence does not state or imply the claim (absence of support is not refutation).",
        },
      };
      out[`refute_${i}`] = {
        type: "noul",
        instructions: `Decide if the following claim is directly DENIED by the evidence. Claim: "${claim}"`,
        criteria: {
          true: "Evidence directly states or implies the negation of the claim (positive refutation).",
          false: "Evidence does not deny the claim (silence or absence is not denial).",
        },
      };
    });
    return out;
  },
};

/**
 * P1-T5 (breaking): `laya_verify` verdicts are SUPPORTED /
 * INSUFFICIENT_EVIDENCE / ABSTAIN (+ reserved CONTRADICTED, never emitted
 * from a support signal alone). The legacy `{probability, verdict:
 * verified|unsupported|contradicted}` labels are gone -- low signals are
 * absence of evidence, never refutation -- and the empty case returns a
 * structured ABSTAIN with the engine ESCALATE decision instead of a zero
 * summary. The aggregate decision is `{decision, reason_codes, policy}`
 * from verify@1.0.0. No threshold literal remains in this handler: the
 * SUPPORT display cut resolves from the shared table; the engine owns every
 * cut point.
 *
 * fut-b-semantica T3 (breaking, extends the above):
 *   - CONTRADICTED is now EMITTED, but ONLY on positive refutation: the
 *     dedicated `refute_<i>` probe answers firm (>= shared claimVerified
 *     cut) AND the support probe answers weak (< cut). Verdict rule:
 *     either probe missing -> ABSTAIN; firm denial + weak support ->
 *     CONTRADICTED; firm denial + firm support -> INSUFFICIENT_EVIDENCE
 *     (conflicting firm judgments cannot confirm); firm support (no firm
 *     denial) -> SUPPORTED; else INSUFFICIENT_EVIDENCE. Low/weak support
 *     without firm denial is NEVER a contradiction (absence != refutation).
 *   - Two server questions per claim (support + refutation), so the cap
 *     drops 64 -> 32 claims to respect the 64-question server budget.
 *   - Band abstention is gone from verifyEvidence: present mid/low support
 *     signals flow to the policy REVIEW band (verify_unsupported_review)
 *     instead of short-circuiting to ESCALATE via abstained_evidence.
 *     Genuine missing signals (null support/refutation, empty claims)
 *     still abstain -> ESCALATE.
 */
export async function handleVerify(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const result = await runTool(client, args, verifyTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { noul?: number }>;
    // P1-T5: decision and display cuts resolve from the shared table.
    const { thresholds } = getPolicy("verify", "1.0.0");
    const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    // fut-b-semantica T3: display verdict mirrors the policy pairing --
    // CONTRADICTED needs firm denial + weak support; conflicting firm
    // probes are insufficient (ambiguous), never a silent confirm.
    const verdictFor = (support: number | null, refute: number | null): string => {
      if (support === null || refute === null) return "ABSTAIN";
      if (refute >= thresholds.claimVerified && support < thresholds.claimVerified) return "CONTRADICTED";
      if (support >= thresholds.claimVerified && refute < thresholds.claimVerified) return "SUPPORTED";
      return "INSUFFICIENT_EVIDENCE";
    };
    const verdicts = claims.map((claim, i) => {
      const support = numOrNull(a[`claim_${i}`]?.noul);
      const refute = numOrNull(a[`refute_${i}`]?.noul);
      return { claim: String(claim), signal: support, verdict: verdictFor(support, refute) };
    });
    const { evidence, abstention } = verifyEvidence(raw, {
      claims: verdicts.map((v, i) => ({
        claim: v.claim,
        signal: v.signal,
        verdict: v.verdict,
        refute: numOrNull(a[`refute_${i}`]?.noul),
      })),
    });
    const { decision, shadow } = evaluateForTool(
      "laya_verify",
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
      return JSON.stringify({ verdicts: [], decision, ...(shadow ? { shadow } : {}), latency_ms: raw.latencyMs, evidence, abstention }, null, 2);
    }
    const summary = {
      supported: verdicts.filter((v) => v.verdict === "SUPPORTED").length,
      insufficient_evidence: verdicts.filter((v) => v.verdict === "INSUFFICIENT_EVIDENCE").length,
      contradicted: verdicts.filter((v) => v.verdict === "CONTRADICTED").length,
      abstain: verdicts.filter((v) => v.verdict === "ABSTAIN").length,
    };
    return JSON.stringify({ summary, verdicts, decision, ...(shadow ? { shadow } : {}), latency_ms: raw.latencyMs, evidence, abstention }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
