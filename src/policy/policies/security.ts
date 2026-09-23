/**
 * security@1.0.0 — fail-closed posture for untrusted content.
 *
 * Evidence consumed: ANY evidence bundle, reading two signal shapes:
 *   - Router `noul` signals (`signal_strength`, any `metadata.question`,
 *     e.g. screen's "is_injection"): injection indicators.
 *   - GLiNER `span` signals (`detector === "gliner:<type>"`,
 *     `metadata.entity_type`): secret/PII indicators.
 * `score`/`choice`/`relevance` signals are ignored deterministically.
 *
 * Thresholds (origin: screen.ts 0.75 block cut + pii.ts SECRET_TYPES,
 * behavior preserved, NOT calibrated; both from the shared table):
 * `screenInjectionBlock` (v1 0.75, strict `>`), `screenInjectionReview`
 * (v1 0.25, strict `>`, downgraded to REVIEW here), `secretTypes`
 * (v1 ["api_key", "token_secreto", "password"]).
 *
 * Posture: fail-closed and NEVER ALLOW in v1 — clean evidence still
 * returns REVIEW (`security_default_review`) because this policy gates
 * untrusted content, it does not bless it. This is how v1 stays
 * fail-closed WITHOUT overriding the single global abstain rule
 * (abstention -> ESCALATE in engine.ts; this policy never DENYs on
 * abstain, it never even runs then).
 *
 * Reason codes (exhaustive):
 *   - "security_injection_deny" (DENY)     any noul signal > block cut
 *   - "security_secret_deny"    (DENY)     any span of a secret type
 *   - "security_pii_review"     (REVIEW)   any non-secret span finding
 *   - "security_injection_review"(REVIEW)  any noul signal > review cut
 *   - "security_default_review" (REVIEW)   nothing flagged (never ALLOW)
 *   - "abstained_evidence"      (ESCALATE) global rule in engine.ts.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

function spanEntity(detector: string | null | undefined, meta: Record<string, unknown>): string | null {
  if (typeof meta.entity_type === "string" && meta.entity_type.length > 0) return meta.entity_type;
  if (typeof detector === "string" && detector.startsWith("gliner:")) {
    const suffix = detector.slice("gliner:".length);
    if (suffix.length > 0) return suffix;
  }
  return null;
}

export const securityPolicy: PolicyDefinition = {
  name: "security",
  version: "1.0.0",
  description: "Fail-closed posture for untrusted content: deny on injection/secrets, review otherwise, never allow.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "security", version: "1.0.0" };
    const signals = ctx.evidence?.signals ?? [];
    const secrets = new Set(t.secretTypes);
    let injectionReview = false;
    let piiReview = false;
    for (const s of signals) {
      if (typeof s.signal_strength === "number") {
        if (s.signal_strength > t.screenInjectionBlock) {
          return { decision: "DENY", reason_codes: ["security_injection_deny"], policy };
        }
        if (s.signal_strength > t.screenInjectionReview) injectionReview = true;
      }
      if (s.kind === "span") {
        const etype = spanEntity(s.detector, (s.metadata ?? {}) as Record<string, unknown>);
        if (etype !== null && secrets.has(etype)) {
          return { decision: "DENY", reason_codes: ["security_secret_deny"], policy };
        }
        piiReview = true;
      }
    }
    if (piiReview) return { decision: "REVIEW", reason_codes: ["security_pii_review"], policy };
    if (injectionReview) return { decision: "REVIEW", reason_codes: ["security_injection_review"], policy };
    return { decision: "REVIEW", reason_codes: ["security_default_review"], policy };
  },
};
