# T2a MANIFEST — screen + verify SFT batch (200 train + 40 exam)

Batch: `odd/ft-pilot-data` from `4ce1a40` (branch `odd/laya-calibration`, tracked tree clean).
Scope: NEW files under `ft-sft-laya/` only. No `src/`, `py/`, suites, or harness touched.

## Files

| file | rows | ES | EN |
|---|---|---|---|
| `train-screen.jsonl` | 100 | 50 | 50 |
| `train-verify.jsonl` | 100 | 50 | 50 |
| `exam-screen.jsonl` | 20 | 10 | 10 |
| `exam-verify.jsonl` | 20 | 10 | 10 |

Kind mix per train tool file (difficult-edge filed as v1 `difficult`):
normal 20 (10/10) / difficult-edge 20 (10/10) / ambiguous 15 (8 ES+7 EN) /
adversarial 15 (8 ES+7 EN) / negative 15 (7 ES+8 EN) / abstention-null 15 (7 ES+8 EN).
Exam per tool file: 4 normal + 4 difficult + 3 ambiguous + 3 adversarial + 3 negative + 3 abstention (10 ES / 10 EN).

## Row schema (ft-v1 reused + one documented extension)

Fields: `id lang primitive kind state questions labels decision source seed notes`.
`primitive` in {screen, verify}; `kind` in v1 set; `decision` in
{ALLOW, REVIEW, DENY, ESCALATE}; `source` in v1 SOURCES; `seed` 11.
Questions are verbatim builders: screen 3x noul
(is_injection/has_substance/is_relevant, purpose-interpolated);
verify 2x noul per claim (`claim_<i>` support + `refute_<i>` denial probes).
EXTENSION vs v1 pycache: `refute_<i>` qids/labels (current builder asks two
probes per claim; v1 QIDS only knew `claim_`). Labels hard `{noul}` or `null`;
`null` = backend silence (never 0; reviewer enforces `noul != 0`).
Decisions recomputed from labels under policy@1.0.0, risk normal:
screen 0.75/0.25 strict `>`, substance `<` 0.4; verify firm cut `>=` 0.80,
CONTRADICTED only on firm refutation + weak support, missing probe -> ESCALATE.

## Signal design (labels |- decision)

- screen normal: inj 0.05-0.12, sub 0.86-0.93 -> ALLOW.
- screen difficult-edge: inj exactly 0.75 -> REVIEW (strict-`>` edge pin).
- screen ambiguous: inj 0.42-0.62 -> REVIEW. adversarial: inj 0.87-0.93 -> DENY,
  incl. 3 pinned-FP kinship+urgency+transfer rows (benign text, over-trigger
  DENY, `pinned-FP` note = documents limitation, not correctness).
- screen negative: boilerplate, sub 0.20 -> REVIEW (skip). abstention: inj or
  sub `null` -> ESCALATE.
- verify normal: sup 0.87-0.93 / ref 0.08-0.15 -> ALLOW. difficult-edge: sup
  exactly 0.80 -> SUPPORTED -> ALLOW (`>=` pin). ambiguous: sup 0.25-0.60,
  weak ref -> REVIEW. adversarial: contradictory 2-claim pairs, each firm
  alone -> ALLOW (no cross-claim check pin). negative: weak sup + firm ref
  0.86-0.94 -> CONTRADICTED -> DENY. abstention: any probe `null` (or empty
  claims) -> ESCALATE.
- ES rows are hand-written natural Spanish (no MTese; reviewer blocklists
  calques); BASELINE patterns included with fresh wording (abuela/madre
  transferencia FP, bank/WhatsApp/OTP/parcel/prize smish, exagerado-vs-refutable,
  contradictory pairs). EN mirrors are native, not translations.

## Two-model honesty declaration

GEN and REVIEW share ONE model base (this session): GEN = constructive pass
(template synthesis per cell spec, seed 11, asserts label|-decision at build);
REVIEW = separate hostile-auditor pass with a different checklist
(schema presence, noul range, null-never-zero, edge exactness 0.75/0.80,
abstention honesty, MTese blocklist, FP-note presence, independent decision
recomputation, v1 Gates A/B/B-intra/C, id uniqueness).
Correlation is compensated by deterministic machine gates, not by a second
model: schema shape, exact+containment(>=40ch) dedup intra-lot and vs
`evals/suites/*.mjs` literals, id uniqueness, and label|-decision
recomputation under policy@1.0.0.

## QC results

- REVIEW round 1: 225/240 ACCEPT (93.8%) -> below 95% threshold, protocol fired.
  Triage: 15 REJECTs = REVIEW checklist bug (None-valued labels treated as
  missing keys; ft-v1 allows None = silence) + 1 genuine GATE-C exact overlap
  (train-verify x exam-verify modular slot alignment) + 1 GEN realism defect
  (stride-inflated magnitudes, e.g. 261388 rooms).
- Fixes: reviewer null-presence semantics; GEN per-row unique serials with
  natural bounded ranges (rooms 60-179, pools 10-17m, prices/menus realistic);
  collided exam cell regenerated with fresh slots.
- REVIEW round 2 (final): 240/240 ACCEPT (100%), every cell 100%.
- Binding gates: schema 0 errors; v1 GATE-A (exact vs held-out) 0; v1 GATE-B
  (containment, both >=40ch, vs held-out) 0; GATE-B-intra 0; GATE-C
  (cross-split exact overlap) 0; duplicate ids 0; label|-decision mismatches 0.
- Diagnostic only: strict 40-char shingle overlap intra-lot = 2530 shared spans
  (expected template-span sharing from slot-filled evidences, same as v1 banks;
  NOT a v1 gate), vs-held-out = 0 (exam machine-disjoint from suites).
- CONTRADICTED fraction of verify train = 15/100 (in v1 15-25% band).

## Gaps / non-goals

- Oversize `input_too_large` limit rows omitted (builder guards, already pinned
  by suites; SFT teaches decisions, not guards). Limits #377/#394 stay suite-covered.
- Relevance labels carried for audit only (v1 never branches on relevance).
- Single-base GEN+REVIEW correlation declared above; independent verifier lands
  at T2d close per plan.
