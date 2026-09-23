import type { LayaClient } from "../client.js";
import { gateEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import type { RiskTier } from "../policy/types.js";
import { type ToolDefinition, runTool, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, envelopeMetadataProperties } from "../tool.js";

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
    "Completion gate: correctness + spec_match + safe_to_apply signals plus one per-claim support " +
    "signal, each claim verified against the supplied evidence. Returns EVIDENCE (rubric objects " +
    "and per-claim {signal} objects with honest SUPPORTED/INSUFFICIENT_EVIDENCE/ABSTAIN labels) " +
    "plus the deterministic ALLOW/REVIEW/ESCALATE `decision` from the versioned gate@1.0.0 policy " +
    "(context + risk are forwarded to the engine; v1 policies ignore risk). This tool never " +
    "executes actions and never applies diffs -- it only reports the policy decision. " +
    "Deliberate rubric difference vs laya_review (see gate@1.0.0): test_gap/blast_radius are not " +
    "asked here; coverage breadth lives in review, completion truthfulness lives here. " +
    "At most 61 claims per call (3 fixed rubric questions + claims fit the 64-question server " +
    "budget); diff and evidence at most 20,000 chars each (larger inputs are rejected with input_too_large).",
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
      context: {
        type: "object",
        description: "Optional caller context forwarded to the policy engine (e.g. {ci: true}).",
      },
      risk: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Optional risk tier forwarded to the policy engine (default normal; v1 policies ignore it).",
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
              description: "CONTRADICTED is reserved for positive refutation evidence; v1 never emits it.",
            },
          },
          required: ["claim", "signal", "verdict"],
        },
      },
      decision: decisionSchema(["ALLOW", "REVIEW", "ESCALATE"]),
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

/**
 * P1-T5 (breaking): `laya_gate` consumes review-evidence + policy + context
 * + risk and returns the deterministic engine decision. The legacy `action`
 * (auto/review/escalate), the `review: {safe_to_apply: <number>}` shorthand,
 * and the per-claim `{probability, verdict: verified|unsupported|contradicted}`
 * labels are gone: rubric entries are objects, per-claim output is
 * `{claim, signal, verdict}` with the honest SUPPORTED/INSUFFICIENT_EVIDENCE/
 * ABSTAIN vocabulary (a low support signal is absence of evidence, never a
 * refutation -- CONTRADICTED needs positive refutation evidence no v1
 * detector carries, so v1 never emits it; the engine reason codes keep
 * their T4 names), and the decision is `{decision, reason_codes, policy}`
 * from gate@1.0.0. No threshold literal remains in this handler.
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
    // handler never hardcodes 0.85/0.8/0.4. The display cut below uses the
    // SUPPORT threshold only: anything present-but-below is insufficient
    // evidence, never a contradiction (absence != refutation).
    const { thresholds } = getPolicy("gate", "1.0.0");
    const verdictFor = (signal: number | null): string =>
      signal === null ? "ABSTAIN" : signal >= thresholds.claimVerified ? "SUPPORTED" : "INSUFFICIENT_EVIDENCE";
    const claimEntries = claims.map((claim, i) => {
      const signal = numOrNull(a[`claim_${i}`]?.noul);
      return { claim: String(claim), signal, verdict: verdictFor(signal) };
    });
    const { evidence, abstention } = gateEvidence(raw, {
      correctness,
      spec_match,
      safe_to_apply,
      claims: claimEntries,
    });
    const risk = normalizeRisk(args.risk);
    const context = {
      ...normalizeContext(args.context),
      claim_count: claims.length,
      diff_chars: String(args.diff ?? "").length,
      evidence_chars: String(args.evidence ?? "").length,
    };
    const decision = evaluate(
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
