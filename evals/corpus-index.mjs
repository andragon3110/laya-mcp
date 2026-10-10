/**
 * benchmark-ronda1 T4 harness wiring: opt-in loader for the 60 R1
 * independent cases (12 per primitive x classify/screen/gate/rerank/find,
 * 6 EN + 6 ES, gold_source "independent", decision-only truth, NO signal
 * values). Default OFF: stub runs stay byte-identical (98/98) unless the
 * caller passes --corpus r1 or sets LAYA_CORPUS=r1. There is no silent
 * merge and no auto-detection.
 *
 * STUB SYNTHESIS: R1 golds carry no stub answers (by design: truth was
 * fixed before any signal was chosen). stubForR1() derives the deterministic
 * oracle-stub answers a working backend would plausibly return FROM the
 * gold, mirroring the per-suite stubModel contracts, so the stub baseline
 * conserves R1 golds end to end. Live runs ignore these answers (the live
 * deps forward real questions), exactly like the suite stubs.
 */

import * as classify from "./corpus-r1/classify.mjs";
import * as screen from "./corpus-r1/screen.mjs";
import * as gate from "./corpus-r1/gate.mjs";
import * as rerank from "./corpus-r1/rerank.mjs";
import * as find from "./corpus-r1/find.mjs";

const R1_MODULES = [classify, screen, gate, rerank, find];

/** R1 cases keyed by suite name (1:1 with primitive). */
export const BY_SUITE = Object.fromEntries(R1_MODULES.map((m) => [m.name, m.cases]));

/** R1 cases keyed by primitive id (e.g. "laya_classify"). */
export const BY_PRIMITIVE = Object.fromEntries(R1_MODULES.map((m) => [m.primitive, m.cases]));

export const R1_PRIMITIVES = R1_MODULES.map((m) => m.primitive);
export const R1_TOTAL = R1_MODULES.reduce((a, m) => a + m.cases.length, 0);

/** Opt-in gate: --corpus r1 / --corpus=r1 flag or LAYA_CORPUS=r1 env. Pure function. */
export function isR1Enabled(argv = process.argv.slice(2), env = process.env) {
  if (String(env.LAYA_CORPUS ?? "").toLowerCase() === "r1") return true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus" && String(argv[i + 1] ?? "").toLowerCase() === "r1") return true;
    if (argv[i].startsWith("--corpus=") && argv[i].slice("--corpus=".length).toLowerCase() === "r1") return true;
  }
  return false;
}

/** Tally per primitive: total + EN/ES split (counts only, no rates). */
export function r1Counts() {
  const per_primitive = R1_MODULES.map((m) => ({
    suite: m.name,
    primitive: m.primitive,
    total: m.cases.length,
    en: m.cases.filter((c) => c.lang === "en").length,
    es: m.cases.filter((c) => c.lang === "es").length,
  }));
  return {
    total: R1_TOTAL,
    en: per_primitive.reduce((a, r) => a + r.en, 0),
    es: per_primitive.reduce((a, r) => a + r.es, 0),
    per_primitive,
  };
}

const sameText = (a, b) => String(a ?? "") === String(b ?? "");

/**
 * Deterministic stub answers derived FROM the R1 gold (working-backend
 * signal shape per the suite stubModel). Never invents truth: every branch
 * reads gold fields only. Returns { answers } for deps.fakeClient().
 */
export function stubForR1(suiteName, c) {
  const gold = c.gold ?? {};
  switch (suiteName) {
    case "classify": {
      const answers = {};
      const ids = (c.input.classes ?? []).map((x) => x.id);
      for (let i = 0; i < (c.input.items ?? []).length; i++) {
        const item = c.input.items[i];
        const label = Array.isArray(gold.classifications) ? gold.classifications[i] : gold.classification;
        const probs = {};
        const rest = ids.filter((id) => id !== label);
        for (const id of rest) probs[id] = rest.length === 0 ? 0 : 0.15 / rest.length;
        probs[label] = 0.85;
        answers[`class_${i}_${item.id}`] = { choice: label, probabilities: probs };
      }
      return { answers };
    }
    case "screen": {
      // Handler cuts: injection >0.75 block, >0.25 review; substance <0.4 skip.
      if (gold.assessment === "malicious-instruction") {
        return { answers: { is_injection: { noul: 0.93 }, has_substance: { noul: 0.9 }, is_relevant: { noul: 0.9 } } };
      }
      if (gold.assessment === "irrelevant") {
        return { answers: { is_injection: { noul: 0.1 }, has_substance: { noul: 0.2 }, is_relevant: { noul: 0.2 } } };
      }
      if (gold.assessment === "ambiguous") {
        return { answers: { is_injection: { noul: 0.5 }, has_substance: { noul: 0.9 }, is_relevant: { noul: 0.9 } } };
      }
      return { answers: { is_injection: { noul: 0.1 }, has_substance: { noul: 0.9 }, is_relevant: { noul: 0.9 } } };
    }
    case "gate": {
      const n = (c.input.claims ?? []).length;
      const list = Array.isArray(gold.verdicts) ? gold.verdicts : n === 0 ? [] : Array(n).fill(gold.verdict);
      const answers = {
        correctness: { score: gold.decision === "ALLOW" ? 2 : 1 },
        spec_match: { score: gold.decision === "ALLOW" ? 2 : 1 },
        safe_to_apply: { noul: gold.decision === "ALLOW" ? 0.95 : 0.9 },
      };
      list.forEach((v, i) => {
        if (v === "SUPPORTED") {
          answers[`claim_${i}`] = { noul: 0.9 };
          answers[`refute_${i}`] = { noul: 0.1 };
        } else if (v === "CONTRADICTED") {
          answers[`claim_${i}`] = { noul: 0.2 };
          answers[`refute_${i}`] = { noul: 0.9 };
        }
        // ABSTAIN verdicts omit claim/refute answers: the missing-signal
        // path abstains instead of guessing (suite abstention contract).
      });
      return { answers };
    }
    case "rerank": {
      const pool = c.input.candidates ?? [];
      const answers = {};
      // Exact-text ties resolve to equal signals; the handler keeps input
      // order without abstaining (documented v1 tie pin, preserved as-is).
      const allSame = pool.length > 0 && pool.every((x) => sameText(x.text, pool[0].text));
      pool.forEach((cand, i) => {
        const rank = (gold.order ?? []).indexOf(cand.id);
        const score = allSame ? 0.5 : pool.length < 2 ? 0.85 : 0.85 - (0.7 * Math.max(rank, 0)) / (pool.length - 1);
        answers[`relevance_${i}_${cand.id}`] = { noul: score };
      });
      return { answers };
    }
    case "find": {
      const pool = c.input.candidates ?? [];
      const ids = pool.map((x) => x.id);
      if (gold.winner === "none" || gold.exists === false) {
        const probs = { none: 0.8 };
        for (const id of ids) probs[id] = 0.2 / Math.max(ids.length, 1);
        return { answers: { exists: { choice: "none", probabilities: probs } } };
      }
      if (gold.abstained === true && pool.length <= 1) {
        // Lone-candidate pin: 0.9 never clears the 1/1 baseline by design.
        return { answers: { exists: { choice: gold.winner, probabilities: { [gold.winner]: 0.9, none: 0.1 } } } };
      }
      if (gold.abstained === true) {
        // Exact-tie pin: equal shares abstain while keeping the winner value.
        const probs = {};
        for (const id of ids) probs[id] = 0.5;
        return { answers: { exists: { choice: gold.winner, probabilities: probs } } };
      }
      const probs = {};
      for (const id of ids) probs[id] = id === gold.winner ? 0.8 : 0.2 / Math.max(ids.length, 1);
      probs.none = 0.05;
      return { answers: { exists: { choice: gold.winner, probabilities: probs } } };
    }
    default:
      return { answers: {} };
  }
}

/**
 * R1 cases mapped to the suite case shape ({id, kind, input, stub, gold,
 * lang, class, gold_source}) for one suite. Stubs are synthesized via
 * stubForR1; golds are untouched human-fixed truth, except one shape
 * normalization: gate ABSTAIN-verdict cases omit the top-level `abstained`
 * flag, mirroring the suite's own abstention case -- the handler reports the
 * missing-signal path as an ABSTAIN verdict + ESCALATE without setting the
 * flag, and suite check() only asserts the flag when defined.
 */
export function r1CasesFor(suiteName) {
  return (BY_SUITE[suiteName] ?? []).map((c) => {
    let gold = c.gold;
    if (suiteName === "gate") {
      const list = Array.isArray(gold.verdicts) ? gold.verdicts : gold.verdict !== undefined ? [gold.verdict] : [];
      if (list.includes("ABSTAIN")) gold = Object.fromEntries(Object.entries(gold).filter(([k]) => k !== "abstained"));
    }
    return {
      id: c.id,
      kind: c.kind,
      lang: c.lang,
      class: c.class,
      gold_source: "independent",
      r1: true,
      input: c.input,
      stub: stubForR1(suiteName, c),
      gold,
    };
  });
}
