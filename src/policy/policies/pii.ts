/**
 * pii@1.0.0 — PII/secret findings by count (GLiNER spans).
 *
 * Evidence consumed: `span` signals built by `piiEvidence` (evidence.ts)
 * via `spanSignal`: `detector === "gliner:<entity-type>"`,
 * `metadata.entity_type` = entity type, `metadata.weak_type` marks
 * non-secret types, `span` = character offsets. `detector_score` is carried
 * for audit — v1 applies NO score cut server-side (preserved: the legacy
 * handler never thresholded GLiNER scores either).
 *
 * Thresholds: NONE numeric — count-based, behavior preserved from pii.ts
 * (`secrets > 0 ? block : findings > 0 ? review : pass`), NOT calibrated.
 * Secret membership comes from the shared table `secretTypes`
 * (v1 ["api_key", "token_secreto", "password"], origin: pii.ts
 * SECRET_TYPES). A finding is secret when its entity type (detector suffix
 * or metadata.entity_type) is in that set.
 *
 * Reason codes (exhaustive):
 *   - "pii_secret_block"   (DENY)     >= 1 secret-type finding
 *   - "pii_findings_review"(REVIEW)   >= 1 finding, none secret (risk normal/unset)
 *   - "pii_clean_allow"    (ALLOW)    zero findings
 *   - "abstained_evidence" (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains when ALL findings are weak-type — ambiguous
 *     detector judgment — so weak-only scans escalate before this runs).
 *
 * Risk (fut-b-semantica T2): count-based, no numeric cut to shift, so risk
 * moves the NON-SECRET branch explicitly -- high fails closed
 * ("pii_high_risk_deny", DENY on any finding), low relaxes
 * ("pii_low_risk_allow", ALLOW on non-secret findings). No version bump:
 * risk "normal"/unset returns exactly the three pre-T2 codes above.
 * Fixed points at every risk: secrets DENY, clean ALLOWs, and abstention
 * (weak-only scans) still ESCALATEs first -- risk never rescues abstention.
 * NOTE: via the laya_pii handler, weak-only scans always abstain, so the
 * risk branches fire on engine-direct (or future non-abstained) inputs --
 * documented, not hidden (see the handler).
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

function entityTypeOf(detector: string | null | undefined, meta: Record<string, unknown>): string | null {
  const fromMeta = meta.entity_type;
  if (typeof fromMeta === "string" && fromMeta.length > 0) return fromMeta;
  if (typeof detector === "string" && detector.startsWith("gliner:")) {
    const suffix = detector.slice("gliner:".length);
    if (suffix.length > 0) return suffix;
  }
  return null;
}

export const piiPolicy: PolicyDefinition = {
  name: "pii",
  version: "1.0.0",
  description: "Count-based PII gate: secrets deny, any finding reviews, clean allows.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "pii", version: "1.0.0" };
    const signals = ctx.evidence?.signals ?? [];
    if (signals.length === 0) {
      return { decision: "ALLOW", reason_codes: ["pii_clean_allow"], policy };
    }
    const secrets = new Set(t.secretTypes);
    for (const s of signals) {
      const etype = entityTypeOf(s.detector, (s.metadata ?? {}) as Record<string, unknown>);
      if (etype !== null && secrets.has(etype)) {
        return { decision: "DENY", reason_codes: ["pii_secret_block"], policy };
      }
    }
    // fut-b-semantica T2: risk moves ONLY this non-secret branch (high fails
    // closed, low relaxes). Secrets/clean/abstention are fixed points above
    // and in engine.ts -- risk never touches them.
    if (ctx.risk === "high") {
      return { decision: "DENY", reason_codes: ["pii_high_risk_deny"], policy };
    }
    if (ctx.risk === "low") {
      return { decision: "ALLOW", reason_codes: ["pii_low_risk_allow"], policy };
    }
    return { decision: "REVIEW", reason_codes: ["pii_findings_review"], policy };
  },
};
