/**
 * find@1.0.0 — single-winner routing choice (informational).
 *
 * Evidence consumed: the single `choice` signal built by `findEvidence`
 * (evidence.ts, `metadata.question === "exists"`): `candidate` = winning id
 * (or "none"), `distribution` = raw choice shares (uncalibrated),
 * `winner_probability` = max share (null when empty).
 *
 * Thresholds: NONE numeric in v1 (legacy find had no cut point; the winner
 * is reported verbatim). Two DERIVED checks preserve the ambiguity bands
 * from evidence.ts without inventing calibration:
 *   - tie: >1 distribution entries within 1e-9 of the top share -> ambiguous.
 *   - weak winner: top share <= 1/N (uniform baseline) with N read from
 *     `context.candidateCount` when the caller supplies it; skipped when
 *     absent (firm winner -> ALLOW). The 1/N baseline is arithmetic, not a
 *     tuned threshold.
 *
 * Reason codes (exhaustive):
 *   - "find_winner_allow"  (ALLOW)    firm, unique, above-baseline winner
 *   - "find_no_winner"     (ESCALATE) candidate null/"none", empty dist, or
 *                                     no choice signal at all
 *   - "find_ambiguous_tie" (ESCALATE) tie for the top share
 *   - "find_weak_winner"   (ESCALATE) top share at/below uniform baseline
 *   - "abstained_evidence" (ESCALATE) global rule in engine.ts (evidence.ts
 *                           abstains on none/empty/tie/weak).
 * v1 never returns REVIEW or DENY: routing is informational, ALLOW-or-ESCALATE.
 */
import type { PolicyThresholds } from "../thresholds.js";
import type { PolicyDecision, PolicyDefinition, PolicyEvalContext } from "../types.js";

export const findPolicy: PolicyDefinition = {
  name: "find",
  version: "1.0.0",
  description: "Single-winner routing choice; firm winner allows, ambiguity escalates.",
  evaluate(ctx: PolicyEvalContext, _t: PolicyThresholds): PolicyDecision {
    const policy = { name: "find", version: "1.0.0" };
    void _t;
    const sig = (ctx.evidence?.signals ?? []).find(
      (s) => (s.metadata as Record<string, unknown> | undefined)?.question === "exists",
    );
    if (!sig) return { decision: "ESCALATE", reason_codes: ["find_no_winner"], policy };
    if (sig.candidate === null || sig.candidate === undefined || sig.candidate === "none") {
      return { decision: "ESCALATE", reason_codes: ["find_no_winner"], policy };
    }
    const dist = sig.distribution ?? null;
    const top = sig.winner_probability ?? null;
    if (dist === null || top === null) {
      return { decision: "ESCALATE", reason_codes: ["find_no_winner"], policy };
    }
    const tied = Object.values(dist).filter((v) => Math.abs(v - top) < 1e-9).length > 1;
    if (tied) return { decision: "ESCALATE", reason_codes: ["find_ambiguous_tie"], policy };
    const n = ctx.context?.candidateCount;
    if (typeof n === "number" && Number.isFinite(n) && n > 0 && top <= 1 / n) {
      return { decision: "ESCALATE", reason_codes: ["find_weak_winner"], policy };
    }
    return { decision: "ALLOW", reason_codes: ["find_winner_allow"], policy };
  },
};
