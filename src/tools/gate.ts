import type { LayaClient } from "../client.js";
import { gateEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluateForTool } from "../policy/mode.js";
import { getPolicy } from "../policy/loader.js";
import type { RiskTier } from "../policy/types.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, shadowSchema, envelopeMetadataProperties } from "../tool.js";

const RISKS: readonly RiskTier[] = ["low", "normal", "high"];

function normalizeRisk(v: unknown): RiskTier {
  if (v === undefined) return "normal";
  if (typeof v === "string" && (RISKS as readonly string[]).includes(v)) return v as RiskTier;
  throw new Error(`laya_gate: risk must be one of ${RISKS.join("|")} (got ${JSON.stringify(v)})`);
}

function normalizeContext(v: unknown): Record<string, unknown> {
  if (v === undefined) return {};
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return { ...(v as Record<string, unknown>) };
  throw new Error(`laya_gate: context must be an object when provided (got ${typeof v})`);
}

export const gateTool: ToolDefinition = {
  name: "laya_gate",
  description:
    "Completion gate: correctness + spec_match + safe_to_apply signals plus per-claim support " +
    "AND refutation signals, each claim verified against the supplied evidence (support: does the " +
    "evidence state the claim? refutation: does the evidence DENY it? -- positive refutation only, " +
    "never absence). Returns EVIDENCE (rubric objects " +
    "and per-claim {signal} objects with honest SUPPORTED/CONTRADICTED/INSUFFICIENT_EVIDENCE/ABSTAIN labels; " +
    "CONTRADICTED needs firm denial plus weak support, never a low support signal alone) " +
    "plus the deterministic ALLOW/REVIEW/ESCALATE `decision` from the versioned gate@1.0.0 policy " +
    "(context + risk are forwarded to the engine; risk tightens/relaxes the auto band per gate@1.0.0). This tool never " +
    "executes actions and never applies diffs -- it only reports the policy decision. " +
    "Deliberate rubric difference vs laya_review (see gate@1.0.0): test_gap/blast_radius are not " +
    "asked here; coverage breadth lives in review, completion truthfulness lives here. " +
    "At most 30 claims per call (3 fixed rubric questions + two questions per claim -- support + " +
    "refutation -- fit the 64-question server budget); diff and evidence at most 20,000 chars each (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      request: { type: "string", description: "Original task." },
      diff: { type: "string", maxLength: LIMITS.maxStateChars, description: "Proposed diff (max 20,000 chars)." },
      claims: {
        type: "array",
        maxItems: LIMITS.maxGateClaims,
        items: { type: "string" },
        description: "Completion claims to verify (max 30, e.g. 'all tests pass'). Two judgments per claim: support + refutation.",
      },
      evidence: {
        type: "string",
        maxLength: LIMITS.maxStateChars,
        description: "Evidence to verify the claims against (max 20,000 chars, e.g. test output).",
      },
      context: {
        type: "object",
        description: "Optional caller context forwarded to the policy engine (e.g. {ci: true}).",
      },
      risk: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Optional risk tier forwarded to the policy engine (default normal; tightens/relaxes the gate auto band).",
      },
    },
    required: ["request", "diff", "claims"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      ...envelopeMetadataProperties(),
      review: {
        type: "object",
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
          safe_to_apply: {
            type: "object",
            properties: { signal: { type: ["number", "null"] } },
            required: ["signal"],
          },
        },
        required: ["correctness", "spec_match", "safe_to_apply"],
      },
      claims: {
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
      decision: decisionSchema(["ALLOW", "REVIEW", "ESCALATE"]),
      shadow: shadowSchema(),
      context: { type: "object" },
      risk: { type: "string", enum: ["low", "normal", "high"] },
      latency_ms: { type: "number" },
      evidence: evidenceSchema("Gate evidence bundle (rubric + per-claim signals)."),
      abstention: abstentionSchema(),
    },
    required: ["review", "claims", "decision", "context", "risk", "latency_ms", "evidence", "abstention"],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  buildQuestions: (args) => {
    const claims = Array.isArray(args.claims) ? args.claims : [];
    assertCount(
      claims.length,
      LIMITS.maxGateClaims,
      "claims",
      `laya_gate accepts at most ${LIMITS.maxGateClaims} claims per call (3 fixed rubric questions + two questions per claim -- support + refutation -- fit the ${LIMITS.maxQuestions}-question server budget)`,
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
      // fut-b-semantica T3: two independent probes per claim (support +
      // refutation), same contract as laya_verify. Low support is absence
      // of evidence, never refutation.
      out[`claim_${i}`] = {
        type: "noul",
        instructions: `Is this completion claim supported by the supplied evidence? Claim: '${claim}'`,
        criteria: {
          true: "Claim is directly supported by the evidence.",
          false: "Claim is not supported by the evidence (absence of support is not refutation).",
        },
      };
      out[`refute_${i}`] = {
        type: "noul",
        instructions: `Is this completion claim DENIED by the supplied evidence? Claim: '${claim}'`,
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
 * P1-T5 (breaking): `laya_gate` consumes review-evidence + policy + context
 * + risk and returns the deterministic engine decision. The legacy `action`
 * (auto/review/escalate), the `review: {safe_to_apply: <number>}` shorthand,
 * and the per-claim `{probability, verdict: verified|unsupported|contradicted}`
 * labels are gone: rubric entries are objects, per-claim output is
 * `{claim, signal, verdict}` with the honest SUPPORTED/INSUFFICIENT_EVIDENCE/
 * ABSTAIN vocabulary (a low support signal is absence of evidence, never a
 * refutation -- CONTRADICTED needs positive refutation evidence, emitted
 * since fut-b-semantica T3 via the dedicated refutation probe; the engine
 * reason codes keep their T4 names), and the decision is
 * `{decision, reason_codes, policy}` from gate@1.0.0. No threshold literal
 * remains in this handler.
 *
 * fut-b-semantica T3 (breaking, extends the above):
 *   - Per-claim CONTRADICTED is now EMITTED via the dedicated `refute_<i>`
 *     probe: firm denial (>= shared claimVerified cut) + weak support (<
 *     cut). Verdict rule mirrors laya_verify (either probe missing ->
 *     ABSTAIN; firm denial + weak support -> CONTRADICTED; both firm ->
 *     INSUFFICIENT_EVIDENCE as conflicting evidence; firm support without
 *     firm denial -> SUPPORTED; else INSUFFICIENT_EVIDENCE).
 *   - Two server questions per claim, so the cap drops 61 -> 30 claims
 *     (3 rubric + 2x30 = 63 <= 64-question server budget).
 *   - Band abstention is gone from gateEvidence: a present mid-band
 *     safe_to_apply flows to gate_review (REVIEW reachable via the
 *     handler) instead of short-circuiting to abstained_evidence ESCALATE.
 *     Missing safe_to_apply still abstains; null claim/refutation answers
 *     stay policy-owned (gate_missing_signal -> ESCALATE).
 */
export async function handleGate(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const result = await runTool(client, args, gateTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { score?: number; noul?: number }>;
    const numOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);
    const correctness = numOrNull(a.correctness?.score);
    const spec_match = numOrNull(a.spec_match?.score);
    const safe_to_apply = numOrNull(a.safe_to_apply?.noul);
    // P1-T5: decision and display cuts resolve from the shared table; the
    // handler never hardcodes 0.85/0.8/0.4. Display pairs support with the
    // T3 refutation probe (absence != refutation -- see verdictFor).
    const { thresholds } = getPolicy("gate", "1.0.0");
    // fut-b-semantica T3: display verdict pairs the support probe with the
    // dedicated refutation probe (same rule as laya_verify) -- CONTRADICTED
    // needs firm denial + weak support, never a low support signal alone.
    const verdictFor = (support: number | null, refute: number | null): string => {
      if (support === null || refute === null) return "ABSTAIN";
      if (refute >= thresholds.claimVerified && support < thresholds.claimVerified) return "CONTRADICTED";
      if (support >= thresholds.claimVerified && refute < thresholds.claimVerified) return "SUPPORTED";
      return "INSUFFICIENT_EVIDENCE";
    };
    const claimEntries = claims.map((claim, i) => {
      const support = numOrNull(a[`claim_${i}`]?.noul);
      const refute = numOrNull(a[`refute_${i}`]?.noul);
      return { claim: String(claim), signal: support, verdict: verdictFor(support, refute) };
    });
    const { evidence, abstention } = gateEvidence(raw, {
      correctness,
      spec_match,
      safe_to_apply,
      claims: claimEntries.map((c, i) => ({
        claim: c.claim,
        signal: c.signal,
        verdict: c.verdict,
        refute: numOrNull(a[`refute_${i}`]?.noul),
      })),
    });
    const risk = normalizeRisk(args.risk);
    const context = {
      ...normalizeContext(args.context),
      claim_count: claims.length,
      diff_chars: String(args.diff ?? "").length,
      evidence_chars: String(args.evidence ?? "").length,
    };
    const { decision, shadow } = evaluateForTool(
      "laya_gate",
      { evidence, abstention, context, risk, policy: { name: "gate", version: "1.0.0" } },
      { thresholds },
    );
    return JSON.stringify(
      {
        review: {
          correctness: { score: correctness },
          spec_match: { score: spec_match },
          safe_to_apply: { signal: safe_to_apply },
        },
        claims: claimEntries,
        decision,
        ...(shadow ? { shadow } : {}),
        context,
        risk,
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
