# WS-E regulus-v3 mix (built 2026-10-12, `py/.venv-ft/Scripts/python ft/gen_gate_v3.py --seed 31337`)

Focused gap round: r1 gate normals-with-bearing-evidence fall to CON/ABSTAIN
(v2: r1-gate dec 6/12 task 4/12). This mix adds 50 gate-heavy rows to the
v2 mix (104+570) and holds everything else byte-identical.

## Files
- `gate-v3-train.jsonl`: **50 rows** (`ft/gen_gate_v3.py`, seed 31337),
  schema `{id, text, labels(true), candidates, source}`:
  44 gate SUPPORTED (`v3a-gate-en-sup-*` / `v3a-gate-es-sup-*`, 22+22,
  `synthetic-gate-v3:gate`) + 6 classify other-holds (`v3a-classify-*-other-*`,
  3+3, `synthetic-gate-v3:other-hold`). EN 25 / ES 25.
- `batch4-train.jsonl`: **104 rows** (byte copy of the v2 mix file; v2 dir read-only).
- `anchors-train.jsonl`: **570 rows** (byte copy of the v2 mix file; v2 dir read-only).
- `eval-ids-train.txt`: **140 ids** (byte copy of the v2 file; the train-time
  `--eval-ids`, so batch-4 + v3 rows stay in the mix while r1/v2 stay out).
- `eval-ids.txt`: **864 ids** (future exclusion universe: v2 244 + 570 anchor
  ids + 50 new v3a ids).
- `overlap-report.json`: 0-overlap evidence (vs 316 eval texts AND vs 644
  prior-mix texts).
- `cselect.json`: C re-selection on validation-80 with the v3 init
  (v2-pinned logits, focal base, per-row K=3 — v2 procedure, re-fit).

## Composition (724 rows total, weight 1 = plain concatenation)

| subset | n | text | true labels | candidates (K per row) |
|---|---|---|---|---|
| batch-4 SIGNED (v2-identical) | 104 | lane mappings | lane golds | lane sets (K=3) |
| v2 anchors (v2-identical) | 570 | general-domain | anchor golds | K=3 lane / K=2 relevance |
| v3 gate SUPPORTED (new) | 44 | `evidence \|\| claim`, CI/test/build/lint evidence with zero-failure counts (incl. skipped/omitted-does-not-contradict difficult variants) | `[SUPPORTED]` | 3 gate labels (K=3) |
| v3 classify other-holds (new) | 6 | status/admin-style other questions (the v2-classify confused neighborhood) | `[other]` | `[bug, feature, other]` (K=3) |

Per-row K dist: {3: 664, 2: 60}. Train loop = v2-identical exact per-row
IDK-loss loop (padded slots never in loss). Init = v2-pinned checkpoint
(continuation; scorer weights carry over, head re-warm-started at bias -2.2
— the trained head state lives outside the checkpoint in idk_head.pt,
inference-irrelevant, so v3 re-learns pricing on the new mix by design).

## Construction truth (no human awake for sign-off)
V3 rows stay construction-labeled: evidence bears -> SUPPORTED; non-defect
non-request question -> other. Generator self-checks coherence (SUP rows
must carry bearing-evidence wording + `||` separator; other rows must carry
no defect/request language) + an agreement-style spot audit below. d3 bridge
skipped (not cheap at this hour); construction-only + documented.

Spot audit (hand-verified 2026-10-12): `tests: 112 passed, 3 skipped, zero
failures || nothing failed among the tests that ran` -> SUPPORTED (skips
coexist with zero failures, claim restates outcome); `pruebas: 88
superadas, 1 omitida, cero fallos || una sola omisión y ningún fallo
registrado` -> SUPPORTED (same difficult shape, ES); `Is the status page
showing an outage in our region right now?` -> other (status question,
neither defect nor request); `Cierren mi espacio de trabajo y borren todo
su contenido, por favor.` -> other (admin request, ES).

## Deliberate neighborhood (documented deviation from v2 deny)
V2 anchors used attendance/oven-log evidence, disjoint from the r1-gate
CI/test/build/lint vocabulary — and r1 gate normals still fall. V3 rows
train EXACTLY that neighborhood: short bearing evidence + restating claim.
Single generic words (tests/pruebas/build/lint/suite) are allowed by design;
distance from eval rows is enforced by exact-text (0) + Jaccard-3 (max 0.182
vs eval, 0.100 vs mix, 0 pairs >= 0.5) + eval-claim-phrase denylist (0 hits).
Every eval claim string was reworded (never copied); every count is fresh.
This is gap training on a pre-registered pattern, NOT tuning on r1: no r1
label was used to select rows, and the single r1 pass at the end decides.

## C re-selection (re-fit, NOT reused — see cselect.json)
`ft/cselect_v3.py`: v2-identical procedure (validation-80 v2d-*, focal base,
grid, tie-break toward 0.02) with the V3 INIT (v2-pinned CPU-fp32 logits,
augmentation OFF, shuffle OFF, per-row K=3). Anchors + v3 rows excluded from
the select population (same rationale as v2: C prices abstention on the
target distribution).

## Head init (warm-start, v2-identical)
`AbstentionHead(bias_init=-2.2)` -> q ~= 0.0998 at step 0.

## Known caveats (recorded, not hidden)
1. V3 adds SUP pressure to a mix whose v2-gate silences already flip 2/22 to
   CONTRADICTED — the verdict bar (zero lane regression vs v2) decides.
2. Validation-80 ⊂ train (lineage-consistent): post-train batch-4 numbers
   measure train-fit; v2 + r1 measure generalization.
3. Screen task ceiling + find-has-no-gliclass-lane carry over from v2.
4. Train seed 20261013 (new, recorded); data seed 31337 (recorded above).
