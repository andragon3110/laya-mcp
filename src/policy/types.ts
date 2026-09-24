/**
 * P1-T4: Policy Engine vocabulary (ADDITIVE, no handlers touched).
 *
 * The Policy Engine is deterministic and LLM-free: it maps explicit
 * Evidence (+ first-class Abstention) to a single decision. No I/O, no
 * dates, no randomness in the decision path.
 *
 * Decision kinds:
 *   - ALLOW    : the consuming step may proceed.
 *   - REVIEW   : a human (or a larger model) must look before proceeding.
 *   - DENY     : confirmed harm / failed constraint; do not proceed.
 *   - ESCALATE : insufficient or ambiguous evidence; a higher authority
 *                must decide. This is the abstention exit.
 *
 * SINGLE GLOBAL ABSTAIN RULE (T4 decision, documented once here):
 *   When `input.abstention.abstained === true`, the engine short-circuits
 *   to `{ decision: "ESCALATE", reason_codes: ["abstained_evidence"] }`
 *   WITHOUT consulting any policy thresholds. The DENY alternative was
 *   rejected: abstention means "insufficient/ambiguous evidence", not
 *   "confirmed harm", so the fail-closed exit is human review (ESCALATE),
 *   not block (DENY). No policy may override this rule; fail-closed
 *   security postures are expressed as "never ALLOW" (see security@1.0.0),
 *   never as "DENY on abstain", so the rule stays single and auditable.
 */
import type { Abstention, Evidence } from "../evidence.js";
import type { PolicyThresholds } from "./thresholds.js";

/** Engine decision kinds. Never `auto`/`pass`: those legacy words stay in handlers until T5/T6. */
export type PolicyDecisionKind = "ALLOW" | "REVIEW" | "DENY" | "ESCALATE";

/** Policy identity carried in every input and echoed in every decision. */
export interface PolicyRef {
  name: string;
  version: string;
}

/** coarse risk tier. Read ONLY where a policy documents it (gate, screen,
 * pii since fut-b-semantica T2 -- see thresholds.RISK_CUT_DELTA); every
 * other v1 policy ignores it (forwarded, never branched). */
export type RiskTier = "low" | "normal" | "high";

/** Caller context (tool args summary, candidate counts, ...). v1 reads it only where documented. */
export type PolicyContext = Record<string, unknown>;

/** Full engine input. `policy` selects the policy; the rest is evaluated. */
export interface PolicyInput {
  evidence: Evidence;
  abstention?: Abstention;
  context?: PolicyContext;
  risk?: RiskTier;
  policy: PolicyRef;
}

/** Engine output: one decision, machine-readable reason codes, policy identity. */
export interface PolicyDecision {
  decision: PolicyDecisionKind;
  reason_codes: string[];
  policy: PolicyRef;
}

/** What a policy definition receives (everything except its own identity). */
export interface PolicyEvalContext {
  evidence: Evidence;
  abstention?: Abstention;
  context?: PolicyContext;
  risk?: RiskTier;
}

/** A declarative, versioned policy: metadata + a pure evaluate function. */
export interface PolicyDefinition {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  evaluate(ctx: PolicyEvalContext, thresholds: PolicyThresholds): PolicyDecision;
}

/** Global abstention reason code (see the single rule above). */
export const ABSTAIN_REASON_CODE = "abstained_evidence";
