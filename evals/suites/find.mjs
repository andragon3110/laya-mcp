/**
 * Fase-7 T3 eval suite: find (laya_find).
 *
 * STUB MODEL: the stub exists-choice dict emulates the backend pick a real
 * judge would plausibly return: the clearly answering candidate firmly, a
 * just-above-baseline share for a weak-but-best candidate, an exact tie for
 * indistinguishable candidates, a rogue id for a misbehaving judge, "none"
 * when nothing answers, `{}` (missing) for backend silence. Legacy path
 * (no top_k) so the judge always sees the full pool.
 *
 * STUB LIMITS (honesty): the stub is NOT the model. Pick plausibility and
 * share magnitudes are oracle-assigned: no retrieval-quality claim transfers.
 * v1 pins: the 1/N weak-winner baseline always uses the pre-pruning count (a
 * lone candidate can never clear it); ties abstain but keep the winner value;
 * unknown ids echo verbatim; "none" and empty dicts abstain to ESCALATE.
 */
import assert from "node:assert";
import { handleFind } from "../../dist/tools/find.js";

export const name = "find";
export const primitive = "laya_find";
export const stubModel =
  "Single exists choice dict: firm pick, just-above-baseline share, exact tie, " +
  "rogue id, none, or {} silence; legacy path (full pool reaches the judge).";
export const stubLimits =
  "Pick plausibility and share magnitudes are oracle-assigned: no " +
  "retrieval-quality claim transfers to the real backend.";

/** T5 gold provenance: every case gold in this file defaults to
 * "oracle-stub" (gold written together with its oracle stub answers).
 * Cases with human-fixed truth carry gold_source: "independent" per
 * case; the manifest gold_corpus block counts both. */
export const goldSource = "oracle-stub";

const PAIR = [
  { id: "a", text: "Postgres supports daily backups natively" },
  { id: "b", text: "SQLite is a single local file" },
];

export const cases = [
  {
    id: "find-normal-01",
    kind: "normal",
    input: { query: "which database has backups", candidates: PAIR },
    oracle: "candidate a answers directly; backend plausibly picks it firmly above baseline.",
    stub: { answers: { exists: { choice: "a", probabilities: { a: 0.7, b: 0.2, none: 0.1 } } } },
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "firm unique winner clears the 1/2 baseline." },
  },
  {
    id: "find-difficult-01",
    kind: "difficult",
    input: {
      query: "backup story",
      candidates: [...PAIR, { id: "c", text: "Backups run nightly here" }],
    },
    oracle: "two partial answers; backend plausibly splits just above the 1/3 baseline.",
    stub: { answers: { exists: { choice: "a", probabilities: { a: 0.4, c: 0.35, b: 0.15, none: 0.1 } } } },
    gold: { winner: "a", decision: "ALLOW", abstained: false, why: "0.40 clears the 1/3 uniform baseline, barely but firmly." },
  },
  {
    id: "find-ambiguous-01",
    kind: "ambiguous",
    input: { query: "database", candidates: PAIR },
    oracle: "both candidates answer equally; backend plausibly ties exactly.",
    stub: { answers: { exists: { choice: "a", probabilities: { a: 0.5, b: 0.5 } } } },
    gold: { winner: "a", decision: "ESCALATE", abstained: true, why: "exact tie abstains; the kept winner stays unusable." },
  },
  {
    id: "find-adversarial-01",
    kind: "adversarial",
    input: { query: "database", candidates: PAIR },
    oracle: "rogue judge returns an id outside the pool; handler echoes without validation.",
    stub: { answers: { exists: { choice: "zzz", probabilities: { zzz: 0.9, none: 0.1 } } } },
    gold: { winner: "zzz", decision: "ALLOW", abstained: false, why: "no id allow-list: the judge token is echoed verbatim." },
  },
  {
    id: "find-negative-01",
    kind: "negative",
    input: { query: "quantum recipe", candidates: PAIR },
    oracle: "nothing answers; a coherent backend plausibly picks none.",
    stub: { answers: { exists: { choice: "none", probabilities: { none: 0.8, a: 0.1, b: 0.1 } } } },
    gold: { winner: "none", exists: false, decision: "ESCALATE", abstained: true, why: "an honest none abstains instead of forcing a winner." },
  },
  {
    id: "find-abstention-01",
    kind: "abstention",
    input: { query: "database", candidates: [{ id: "a", text: "A database" }] },
    oracle: "lone candidate at 0.9; the 1/1 baseline still binds by design.",
    stub: { answers: { exists: { choice: "a", probabilities: { a: 0.9, none: 0.1 } } } },
    gold: { winner: "a", decision: "ESCALATE", abstained: true, why: "0.9 never clears 1/1: a lone candidate always abstains." },
  },
  {
    id: "find-abstention-02",
    kind: "abstention",
    input: { query: "database", candidates: PAIR },
    oracle: "backend silence; no choice means no winner.",
    stub: { answers: {} },
    gold: { winner: "none", decision: "ESCALATE", abstained: true, why: "missing judge answer resolves through the none path." },
  },
  {
    id: "find-negative-limit-01",
    kind: "negative",
    input: {
      query: "q",
      candidates: Array.from({ length: 251 }, (_, i) => ({ id: `p${i}`, text: `candidate ${i}` })),
    },
    oracle: "251 candidates exceed the 250 ceiling; builder must refuse.",
    stub: { answers: {} },
    expectError: "input_too_large",
    gold: { why: "over-ceiling pools fail fast, never silently truncated." },
  },
  {
    id: "find-independent-01",
    kind: "normal",
    gold_source: "independent",
    input: {
      query: "how do I reset my password",
      candidates: [
        { id: "a", text: "Open Settings and click Reset password to receive an email link." },
        { id: "b", text: "Zebra migration notes for the spring season." },
      ],
    },
    oracle: "INDEPENDENT GOLD (human-fixed truth): candidate a answers the query directly while b is topically unrelated; any competent judge picks a firmly above the 1/2 baseline. The stub choice below only feeds the handler the signal a working backend would return.",
    stub: { answers: { exists: { choice: "a", probabilities: { a: 0.82, b: 0.1, none: 0.08 } } } },
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "human-fixed answer wins firmly; 0.82 clears the 1/2 uniform baseline." },
  },
  {
    id: "find-independent-02",
    kind: "normal",
    gold_source: "independent",
    input: {
      query: "¿cómo restablezco mi contraseña?",
      candidates: [
        { id: "a", text: "Abre los Ajustes y pulsa Restablecer contraseña para recibir un enlace por correo." },
        { id: "b", text: "Notas sobre la migración de las cebras en primavera." },
      ],
    },
    oracle: "INDEPENDENT GOLD (human-fixed truth, español): el candidato a responde la consulta directamente mientras b es ajeno al tema; cualquier juez competente elige a con holgura sobre la base 1/2. La elección stub solo alimenta al handler con lo que devolvería un backend funcional.",
    stub: { answers: { exists: { choice: "a", probabilities: { a: 0.8, b: 0.12, none: 0.08 } } } },
    gold: { winner: "a", exists: true, decision: "ALLOW", abstained: false, why: "human-fixed answer (ES) wins firmly; 0.80 clears the 1/2 uniform baseline." },
  },
];

export async function invoke(deps, input, stub, capture) {
  // S4 spike lane: the Qwen cross-encoder scores (query, candidate)
  // pairs; it cannot answer the exists-choice question, so under a
  // connected sidecar (makeRerankCtx present AND rerankReady) the winner
  // is the argmax over live rerank scores mapped back to the choice
  // shape. Uniqueness/baseline adjudication stays inside the handler
  // (ties/weak resolve to ESCALATE there, never here). Stub default and
  // Laya-live both fall back to fakeClient, so non-Qwen behavior is
  // byte-identical to S3.
  const rctx = deps.makeRerankCtx?.();
  if (rctx && rctx.rerankReady()) {
    const pool = Array.isArray(input.candidates) ? input.candidates : [];
    const res = await rctx.rerank.rerank(input.query, pool);
    const ranked = Array.isArray(res?.ranked) ? [...res.ranked].sort((a, b) => a.rank - b.rank) : [];
    const top = ranked[0];
    const probabilities = {};
    for (const row of ranked) {
      if (row && typeof row.id === "string" && typeof row.score === "number") probabilities[row.id] = row.score;
    }
    const answers = { exists: { choice: top && typeof top.id === "string" ? top.id : "none", probabilities } };
    const liveClient = (_answers, cap) => ({
      predict: async (_args, questions) => {
        if (cap) cap.questions = questions;
        return { answers, confidence: {}, routing: {}, model: "qwen-rerank-via-find", latencyMs: res?.latencyMs ?? 0, usage: {} };
      },
    });
    const client = liveClient(answers, capture);
    return JSON.parse(await handleFind(client, input));
  }
  const client = deps.fakeClient(stub.answers ?? {}, capture);
  return JSON.parse(await handleFind(client, input));
}

export function check(body, gold) {
  assert.equal(body.decision.decision, gold.decision, "decision");
  if (gold.winner !== undefined) {
    assert.equal(body.winner, gold.winner, "winner");
  }
  if (gold.exists !== undefined) {
    assert.equal(body.exists, gold.exists, "exists");
  }
  if (gold.abstained !== undefined) {
    assert.equal(body.abstention.abstained, gold.abstained, "abstained");
  }
  return { decision: body.decision.decision, winner: body.winner };
}
