/**
 * verify@1.0.0 — per-claim support (+ refutation) aggregated to one decision.
 *
 * Evidence consumed: Router `noul` signals built by `verifyEvidence`
 * (evidence.ts):
 *   - one SUPPORT signal per claim (`metadata.question === "claim_<i>"`,
 *     `signal_strength` = raw claim support, uncalibrated, `candidate` =
 *     claim text, `metadata.verdict` = handler display label, informational
 *     only -- this policy recomputes from signals + the shared table, it
 *     never trusts the label);
 *   - one REFUTATION signal per claim (`metadata.question === "refute_<i>"`,
 *     `metadata.refutation === true`, `signal_strength` = raw denial
 *     strength from the dedicated "does the evidence DENY this claim?"
 *     probe, uncalibrated). Absence of support is NEVER refutation: a low
 *     support signal with no (or weak) refutation is unsupported, not
 *     contradicted.
 *
 * Thresholds (origin: verify.ts legacy verdicts, behavior preserved, NOT
 * calibrated; SHARED with gate@1.0.0 via thresholds.ts):
 * `claimVerified` (v1 0.8, `>=`) is the firm band for BOTH probes: support
 * >= verified is firm support, refute >= verified is POSITIVE refutation.
 * No new cut was introduced (no calibration harness exists to justify one).
 * `claimContradicted` (v1 0.4) is RETAINED in the shared table (defaults,
 * env override, compat) but verify@1.0.0 no longer consults it: the v1
 * inference "support < 0.4  =>  contradicted" labelled absence of evidence
 * a refutation, which fut-b-semantica T3 removes (BREAKING vs P1-T4/T5:
 * low support without firm refutation now REVIEWs as unsupported instead
 * of DENYing; update golds accordingly).
 *
 * Aggregation:
 *   any claim with firm refutation + weak support -> DENY (a positively
 *     refuted claim must not be relied on -- the only CONTRADICTED path);
 *   both probes firm -> unsupported (conflicting firm judgments: the
 *     evidence both supports and denies, so it cannot confirm -- REVIEW,
 *     never a silent ALLOW, never a contradiction);
 *   otherwise support < verified (no/weak refutation) -> unsupported;
 *   all verified -> ALLOW; any unsupported (no contradicted) -> REVIEW.
 * Differs from gate@1.0.0 on purpose: gate ESCALATEs on contradicted
 * (completion authority), verify DENYs (fact-check refusal).
 *
 * Legacy evidence without `refute_<i>` signals (pre-T3 bundles) degrades
 * to the support-only mapping: verified/unsupported bands as above, DENY
 * unreachable (absence != refutation -- there is no probe to affirm it).
 * An explicit null on either probe is a MISSING signal (-> ESCALATE),
 * never a weak one.
 *
 * Reason codes (exhaustive, T4 names kept):
 *   - "verify_all_verified"      (ALLOW)    every claim >= verified
 *   - "verify_unsupported_review"(REVIEW)   some unsupported, none contradicted
 *   - "verify_contradicted_deny" (DENY)     any claim with firm refutation
 *                                            + weak support
 *   - "verify_no_claims"         (ESCALATE) zero claim signals
 *   - "verify_missing_signal"    (ESCALATE) any claim support OR asked
 *                                            refutation signal null/absent
 *   - "abstained_evidence"       (ESCALATE) global rule in engine.ts
 *     (evidence.ts abstains on empty claims / missing signals only since
 *     T3 -- never on band position).
 */
import type { Signal } from "../../evidence.js";
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

function questionOf(s: Signal): string {
  return String((s.metadata as Record<string, unknown> | undefined)?.question ?? "");
}

function claimSignals(signals: Signal[]): Signal[] {
  return signals.filter((s) => /^claim_\d+$/.test(questionOf(s)));
}

function refuteFor(signals: Signal[], claimQuestion: string): Signal | undefined {
  const m = /^claim_(\d+)$/.exec(claimQuestion);
  if (!m) return undefined;
  const want = `refute_${m[1]}`;
  return signals.find((s) => questionOf(s) === want);
}

export const verifyPolicy: PolicyDefinition = {
  name: "verify",
  version: "1.0.0",
  description: "Claim-support (+ refutation) aggregation on the shared verify/gate 0.8 firm cut.",
  evaluate(ctx: PolicyEvalContext, t: PolicyThresholds): PolicyDecision {
    const policy = { name: "verify", version: "1.0.0" };
    const signals = ctx.evidence?.signals ?? [];
    const claims = claimSignals(signals);
    if (claims.length === 0) {
      return { decision: "ESCALATE", reason_codes: ["verify_no_claims"], policy };
    }
    let unsupported = 0;
    for (const c of claims) {
      const v = c.signal_strength;
      if (typeof v !== "number") {
        return { decision: "ESCALATE", reason_codes: ["verify_missing_signal"], policy };
      }
      const r = refuteFor(signals, questionOf(c));
      if (r !== undefined) {
        const rv = r.signal_strength;
        if (typeof rv !== "number") {
          return { decision: "ESCALATE", reason_codes: ["verify_missing_signal"], policy };
        }
        // fut-b-semantica T3: CONTRADICTED needs POSITIVE refutation (firm
        // denial) PLUS weak support. Firm denial alone against firm support
        // is conflicting evidence -- unsupported, never a silent confirm.
        if (rv >= t.claimVerified && v < t.claimVerified) {
          return { decision: "DENY", reason_codes: ["verify_contradicted_deny"], policy };
        }
        if (rv >= t.claimVerified) {
          unsupported++;
          continue;
        }
      }
      if (v < t.claimVerified) unsupported++;
    }
    if (unsupported > 0) {
      return { decision: "REVIEW", reason_codes: ["verify_unsupported_review"], policy };
    }
    return { decision: "ALLOW", reason_codes: ["verify_all_verified"], policy };
  },
};
