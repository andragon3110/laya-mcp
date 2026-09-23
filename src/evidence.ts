/**
 * P1-T3: Evidence + abstention vocabulary (ADDITIVE).
 *
 * Every numeric value coming out of Laya/GLiNER is an UNCALIBRATED signal,
 * never a calibrated probability and never an authorization. This module
 * gives those signals honest, FINAL names that W3/W4 (Policy Engine) will
 * reuse unchanged:
 *
 *   - Router `noul`            -> `signal_strength` (never `confidence`)
 *   - rerank `noul`            -> `relevance_score`
 *   - choice dict              -> `distribution`
 *   - Math.max over dict       -> `winner_probability` (null when empty)
 *   - GLiNER span score        -> `detector_score` (no threshold server-side)
 *   - review/gate 0-2 numbers  -> `score` (unchanged)
 *
 * The words `confidence` / `probability` MUST NOT appear in this file for
 * uncalibrated signals. Legacy handler fields keep their old names (renames
 * are T5/T6); only the new `evidence` / `abstention` objects use this
 * vocabulary.
 *
 * T3 is additive: handlers attach `evidence` (+ `abstention` where the
 * evidence is insufficient/ambiguous) WITHOUT altering any legacy field or
 * decision value. The Policy Engine owns decisions from T5/T6.
 */
import type { PredictResult } from "./client.js";

/** Where a raw signal came from. */
export type SignalSource = "laya" | "gliner" | "regex" | "none";

/** Which backend question shape produced the signal. */
export type SignalKind = "noul" | "choice" | "score" | "span";

/** Character offsets grounding a signal in the source text. */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * One raw, uncalibrated signal. Numeric payload fields are optional and
 * kind-specific; every field name is honest about what the number is.
 */
export interface Signal {
  source: SignalSource;
  kind: SignalKind;
  /** Raw Router noul output (uncalibrated). Null when the backend omitted it. */
  signal_strength?: number | null;
  /** Raw Router noul output in a rerank context (uncalibrated). */
  relevance_score?: number | null;
  /** Raw choice distribution as returned by the Router (uncalibrated). */
  distribution?: Record<string, number> | null;
  /** Max of `distribution`. Null when the dict came back empty. */
  winner_probability?: number | null;
  /** Raw GLiNER span score. No threshold is applied server-side. */
  detector_score?: number | null;
  /** Raw 0-2 review/gate rubric number, passed through unchanged. */
  score?: number | null;
  /** Winning candidate id / choice key / claim text, per kind. */
  candidate?: string | null;
  /** Grounding offsets, when the signal is span-based. */
  span?: TextSpan | null;
  /** Concrete detector, e.g. "router", "regex", "gliner:<entity-type>". */
  detector?: string | null;
  /** Backend model label (raw.model). */
  model?: string | null;
  /** Backend revision pin (raw.routing.revision). Null when unpinned. */
  revision?: string | null;
  /** Per-signal extras: question key, legacy verdict, weak-type flags, ... */
  metadata?: Record<string, unknown>;
}

/** Explicit evidence bundle attached to every handler output. */
export interface Evidence {
  signals: Signal[];
  model: string | null;
  revision: string | null;
  /** Primary detector for this bundle, e.g. "router", "regex", "gliner". */
  detector: string | null;
  metadata?: Record<string, unknown>;
}

/** First-class abstention flag. Informational in T3; engine-owned from T5/T6. */
export interface Abstention {
  abstained: boolean;
  reason: string | null;
}

/** P1-T3 bugfix note: Math.max(...[]) is -Infinity; the honest value is null. */
export function winnerOf(distribution: Record<string, number> | null | undefined): number | null {
  const values = Object.values(distribution ?? {});
  return values.length > 0 ? Math.max(...values) : null;
}

/** Revision pin passthrough: raw.routing.revision (null when unpinned). */
export function revisionFromRaw(raw: Pick<PredictResult, "routing">): string | null {
  const routing = (raw?.routing ?? {}) as Record<string, unknown>;
  const rev = routing.revision ?? routing.model_revision ?? null;
  return typeof rev === "string" || typeof rev === "number" ? String(rev) : null;
}

function baseSignal(
  raw: Pick<PredictResult, "model" | "routing">,
  init: Omit<Signal, "model" | "revision">,
): Signal {
  return { ...init, model: raw?.model ?? null, revision: revisionFromRaw(raw) };
}

/** Raw Router noul signal (uncalibrated). */
export function noulSignal(
  raw: Pick<PredictResult, "model" | "routing">,
  question: string,
  value: number | null | undefined,
  extra?: { candidate?: string | null; metadata?: Record<string, unknown> },
): Signal {
  return baseSignal(raw, {
    source: "laya",
    kind: "noul",
    signal_strength: value ?? null,
    candidate: extra?.candidate ?? null,
    span: null,
    detector: "router",
    ...(extra?.metadata ? { metadata: { question, ...extra.metadata } } : { metadata: { question } }),
  });
}

/** Raw Router choice distribution (uncalibrated). */
export function choiceSignal(
  raw: Pick<PredictResult, "model" | "routing">,
  question: string,
  choice: string | null | undefined,
  distribution: Record<string, number> | null | undefined,
  extra?: { detector?: string | null; source?: SignalSource; metadata?: Record<string, unknown> },
): Signal {
  return baseSignal(raw, {
    source: extra?.source ?? "laya",
    kind: "choice",
    candidate: choice ?? null,
    distribution: distribution ?? null,
    winner_probability: winnerOf(distribution),
    span: null,
    detector: extra?.detector ?? "router",
    ...(extra?.metadata ? { metadata: { question, ...extra.metadata } } : { metadata: { question } }),
  });
}

/** Raw 0-2 rubric number, passed through unchanged. */
export function scoreSignal(
  raw: Pick<PredictResult, "model" | "routing">,
  question: string,
  value: number | null | undefined,
): Signal {
  return baseSignal(raw, {
    source: "laya",
    kind: "score",
    score: value ?? null,
    candidate: null,
    span: null,
    detector: "router",
    metadata: { question },
  });
}

/** Raw rerank noul signal (uncalibrated). */
export function relevanceSignal(
  raw: Pick<PredictResult, "model" | "routing">,
  question: string,
  candidate: string,
  value: number | null | undefined,
  rank?: number,
): Signal {
  return baseSignal(raw, {
    source: "laya",
    kind: "noul",
    candidate,
    relevance_score: value ?? null,
    span: null,
    detector: "router",
    metadata: rank === undefined ? { question } : { question, rank },
  });
}

/** Raw GLiNER span signal. No threshold is applied server-side. */
export function spanSignal(
  entityType: string,
  text: string,
  start: number,
  end: number,
  detectorScore: number | null | undefined,
  extra?: { weak_type?: boolean; metadata?: Record<string, unknown> },
): Signal {
  return {
    source: "gliner",
    kind: "span",
    candidate: text,
    detector_score: detectorScore ?? null,
    span: { start, end },
    detector: `gliner:${entityType}`,
    model: null,
    revision: null,
    metadata: { entity_type: entityType, ...(extra?.weak_type !== undefined ? { weak_type: extra.weak_type } : {}), ...(extra?.metadata ?? {}) },
  };
}

export function abstained(reason: string): Abstention {
  return { abstained: true, reason };
}

export function notAbstained(): Abstention {
  return { abstained: false, reason: null };
}

export function makeEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  signals: Signal[],
  detector: string | null,
  metadata?: Record<string, unknown>,
): Evidence {
  return {
    signals,
    model: raw?.model ?? null,
    revision: revisionFromRaw(raw),
    detector,
    ...(metadata ? { metadata } : {}),
  };
}

// ---------------------------------------------------------------------------
// Per-tool constructors. Each takes the already-parsed legacy numbers (the
// handler decision logic is untouched) plus `raw` for model/revision, and
// returns the additive { evidence, abstention } pair. W3/W4 reuse these.
// ---------------------------------------------------------------------------

export function screenEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: { injection: number | null; substance: number | null; relevance: number | null; missing: string[] },
): { evidence: Evidence; abstention: Abstention } {
  const signals = [
    noulSignal(raw, "is_injection", input.injection),
    noulSignal(raw, "has_substance", input.substance),
    noulSignal(raw, "is_relevant", input.relevance),
  ];
  return {
    evidence: makeEvidence(raw, signals, "router"),
    abstention:
      input.missing.length > 0 ? abstained(`missing Router signal(s): ${input.missing.join(", ")}`) : notAbstained(),
  };
}

export function verifyEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: { claims: Array<{ claim: string; signal: number | null; verdict: string }> },
): { evidence: Evidence; abstention: Abstention } {
  const signals = input.claims.map((c, i) =>
    noulSignal(raw, `claim_${i}`, c.signal, { candidate: String(c.claim), metadata: { verdict: c.verdict } }),
  );
  let abstention = notAbstained();
  if (input.claims.length === 0) {
    abstention = abstained("no claims provided; nothing to verify");
  } else {
    const low = input.claims.filter((c) => (c.signal ?? 0) < 0.4);
    const mid = input.claims.filter((c) => (c.signal ?? 0) >= 0.4 && (c.signal ?? 0) < 0.8);
    if (low.length > 0) abstention = abstained(`${low.length} claim(s) in low-signal zone (<0.40): insufficient evidence`);
    else if (mid.length > 0)
      abstention = abstained(`${mid.length} claim(s) in mid-signal zone (0.40-0.80): ambiguous support`);
  }
  return { evidence: makeEvidence(raw, signals, "router"), abstention };
}

export function findEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: { choice: string | null; distribution: Record<string, number> | null; candidateCount: number },
): { evidence: Evidence; abstention: Abstention } {
  const top = winnerOf(input.distribution);
  const signals = [
    choiceSignal(raw, "exists", input.choice, input.distribution, { metadata: { exists: input.choice !== "none" } }),
  ];
  let abstention = notAbstained();
  if (input.choice === null || input.choice === "none") {
    abstention = abstained("no candidate selected (choice is 'none')");
  } else if (top === null) {
    abstention = abstained("empty distribution; winner is indeterminate");
  } else {
    const entries = Object.entries(input.distribution ?? {});
    const tied = entries.filter(([, v]) => Math.abs(v - top) < 1e-9).length > 1;
    if (tied) abstention = abstained("tie for the top distribution share; winner is ambiguous");
    else if (input.candidateCount > 0 && top <= 1 / input.candidateCount)
      abstention = abstained("weak winner: top share at or below the uniform baseline");
  }
  return { evidence: makeEvidence(raw, signals, "router"), abstention };
}

export function rerankEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: { items: Array<{ id: string; question: string; relevance: number | null; rank: number; missing: boolean }> },
): { evidence: Evidence; abstention: Abstention } {
  const signals = input.items.map((it) => relevanceSignal(raw, it.question, it.id, it.relevance, it.rank));
  const missing = input.items.filter((it) => it.missing).map((it) => it.id);
  return {
    evidence: makeEvidence(raw, signals, "router"),
    abstention:
      input.items.length === 0
        ? abstained("no candidates to rank")
        : missing.length > 0
          ? abstained(`missing Router signal(s) for candidate(s): ${missing.join(", ")}`)
          : notAbstained(),
  };
}

export function classifyEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: { items: Array<{ id: string; choice: string; distribution: Record<string, number> | null; missing: boolean }> },
): { evidence: Evidence; abstention: Abstention } {
  const signals = input.items.map((it, i) =>
    choiceSignal(raw, `class_${i}_${it.id}`, it.choice, it.distribution, {
      metadata: { item_id: it.id, ...(it.missing ? { missing_answer: true } : {}) },
    }),
  );
  const missing = input.items.filter((it) => it.missing).map((it) => it.id);
  const empty = input.items.filter((it) => !it.missing && winnerOf(it.distribution) === null).map((it) => it.id);
  return {
    evidence: makeEvidence(raw, signals, "router"),
    abstention:
      missing.length > 0
        ? abstained(`missing Router answer(s) for item(s): ${missing.join(", ")}`)
        : empty.length > 0
          ? abstained(`empty distribution(s) for item(s): ${empty.join(", ")}; winner is indeterminate`)
          : notAbstained(),
  };
}

export function decideEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: {
    selected: string | null;
    distribution: Record<string, number> | null;
    optionCount: number;
    requirements: Array<{ key: string; signal: number | null; missing: boolean }>;
  },
): { evidence: Evidence; abstention: Abstention } {
  const top = winnerOf(input.distribution);
  const signals = [
    choiceSignal(raw, "selected", input.selected, input.distribution),
    ...input.requirements.map((r) =>
      noulSignal(raw, r.key, r.signal, r.missing ? { metadata: { missing_answer: true } } : undefined),
    ),
  ];
  let abstention = notAbstained();
  const missingReqs = input.requirements.filter((r) => r.missing).map((r) => r.key);
  const unsupported = input.requirements.filter((r) => !r.missing && (r.signal ?? 0) < 0.8).map((r) => r.key);
  if (input.selected === null) abstention = abstained("no option selected");
  else if (top === null) abstention = abstained("empty distribution; winner is indeterminate");
  else if (input.optionCount > 0 && top <= 1 / input.optionCount)
    abstention = abstained("flat distribution: top share at or below the uniform baseline");
  else if (missingReqs.length > 0)
    abstention = abstained(`missing requirement signal(s): ${missingReqs.join(", ")}`);
  else if (unsupported.length > 0)
    abstention = abstained(`requirement(s) without support (<0.80): ${unsupported.join(", ")}`);
  return { evidence: makeEvidence(raw, signals, "router"), abstention };
}

export function compareEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: {
    overall: { choice: string | null; distribution: Record<string, number> | null; missing: boolean };
    aspects: Array<{ key: string; label: string; choice: string | null; distribution: Record<string, number> | null; missing: boolean }>;
  },
): { evidence: Evidence; abstention: Abstention } {
  const signals = [
    choiceSignal(raw, "overall", input.overall.choice, input.overall.distribution),
    ...input.aspects.map((x) => choiceSignal(raw, x.key, x.choice, x.distribution, { metadata: { aspect: x.label } })),
  ];
  const missing = [
    ...(input.overall.missing ? ["overall"] : []),
    ...input.aspects.filter((x) => x.missing).map((x) => x.label),
  ];
  return {
    evidence: makeEvidence(raw, signals, "router"),
    abstention:
      missing.length > 0 ? abstained(`missing Router answer(s): ${missing.join(", ")}`) : notAbstained(),
  };
}

export interface ExtractFieldEvidence {
  fieldId: string;
  question: string;
  choice: string | null;
  distribution: Record<string, number> | null;
  candidateCount: number;
  invalidPattern: boolean;
  source: SignalSource;
  /** Chosen entity span, when the entities path resolved one. */
  span?: TextSpan | null;
  detectorScore?: number | null;
  entityType?: string | null;
  value?: unknown;
  status?: string;
}

export function extractEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: { fields: ExtractFieldEvidence[]; source: string },
): { evidence: Evidence; abstention: Abstention } {
  const signals = input.fields.map((f) => {
    const sig = choiceSignal(raw, f.question, f.choice, f.distribution, {
      source: f.source,
      detector: f.source === "gliner" ? `gliner:${f.entityType ?? f.fieldId}` : "regex",
      metadata: {
        field_id: f.fieldId,
        candidate_count: f.candidateCount,
        ...(f.invalidPattern ? { invalid_pattern: true } : {}),
        ...(f.status ? { status: f.status } : {}),
      },
    });
    if (f.span) {
      sig.span = f.span;
      sig.detector_score = f.detectorScore ?? null;
    }
    return sig;
  });
  const empty = input.fields.filter((f) => f.candidateCount === 0).map((f) =>
    f.invalidPattern ? `${f.fieldId} (invalid pattern)` : `${f.fieldId} (no candidates)`,
  );
  return {
    evidence: makeEvidence(raw, signals, input.source === "entities" ? "gliner" : "regex", {
      candidate_source: input.source,
    }),
    abstention:
      empty.length > 0
        ? abstained(`field(s) with zero candidates: ${empty.join(", ")}`)
        : notAbstained(),
  };
}

export function reviewEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: {
    correctness: number | null;
    spec_match: number | null;
    test_gap: number | null;
    blast_radius: number | null;
    safe_to_apply: number | null;
  },
): { evidence: Evidence; abstention: Abstention } {
  const signals = [
    scoreSignal(raw, "correctness", input.correctness),
    scoreSignal(raw, "spec_match", input.spec_match),
    scoreSignal(raw, "test_gap", input.test_gap),
    scoreSignal(raw, "blast_radius", input.blast_radius),
    noulSignal(raw, "safe_to_apply", input.safe_to_apply),
  ];
  const s = input.safe_to_apply;
  return {
    evidence: makeEvidence(raw, signals, "router"),
    abstention:
      s === null || s === undefined
        ? abstained("missing safe_to_apply signal")
        : s > 0.5 && s <= 0.85
          ? abstained(`safe_to_apply in mid band (${s.toFixed(2)}): neither firm auto nor firm escalate`)
          : notAbstained(),
  };
}

export function gateEvidence(
  raw: Pick<PredictResult, "model" | "routing">,
  input: {
    correctness: number | null;
    spec_match: number | null;
    safe_to_apply: number | null;
    claims: Array<{ claim: string; signal: number | null; verdict: string }>;
  },
): { evidence: Evidence; abstention: Abstention } {
  const signals = [
    scoreSignal(raw, "correctness", input.correctness),
    scoreSignal(raw, "spec_match", input.spec_match),
    noulSignal(raw, "safe_to_apply", input.safe_to_apply),
    ...input.claims.map((c, i) =>
      noulSignal(raw, `claim_${i}`, c.signal, { candidate: String(c.claim), metadata: { verdict: c.verdict } }),
    ),
  ];
  const s = input.safe_to_apply;
  return {
    evidence: makeEvidence(raw, signals, "router"),
    abstention:
      s === null || s === undefined
        ? abstained("missing safe_to_apply signal")
        : s > 0.5 && s <= 0.85
          ? abstained(`safe_to_apply in mid band (${s.toFixed(2)}): neither firm auto nor firm escalate`)
          : notAbstained(),
  };
}

export interface PiiFindingEvidence {
  text: string;
  start: number;
  end: number;
  type: string;
  detectorScore: number | null;
  weak_type: boolean;
}

export function piiEvidence(input: {
  findings: PiiFindingEvidence[];
  weakTypes: string[];
}): { evidence: Evidence; abstention: Abstention } {
  const signals = input.findings.map((f) =>
    spanSignal(f.type, f.text, f.start, f.end, f.detectorScore, { weak_type: f.weak_type }),
  );
  // P1-T3: weak-type findings are only marked in evidence; the legacy action
  // (block on secrets / review on any finding / pass) is unchanged.
  const weakOnly = input.findings.length > 0 && input.weakTypes.length === input.findings.length;
  return {
    evidence: {
      signals,
      model: null,
      revision: null,
      detector: "gliner",
      metadata: { weak_types: input.weakTypes },
    },
    abstention: weakOnly
      ? abstained(`only weak-type findings (${[...new Set(input.weakTypes)].join(", ")}); detector judgment is ambiguous`)
      : notAbstained(),
  };
}
