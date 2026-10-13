# WS-E regulus-v5 mix (built 2026-10-13, `py/.venv-ft/Scripts/python ft/gen_delta_v5.py`)

Silence-heavy + filler-style correction round (v3 SUP-bias + v4
verdicts-on-silence + v4 prose-screen lessons applied).

## Files (byte copies with sha256; v2/base dirs stay read-only)
- `batch4-train.jsonl`: **104 rows** (byte copy of v2 mix file,
  sha 40413e7b…; 80 v2d validation + 24 d3-distill train-only)
- `anchors-train.jsonl`: **570 rows** (byte copy of v2 mix file,
  sha 2efe240a…; verified byte-identical; v2 dir read-only)
- `gate-fever.jsonl`: **600 rows** (copy of `ft/base-v4/gate-fever.jsonl`,
  sha a59e1a52…; 200 SUP / 200 CON / 200 NEI-empty, en, CC-BY-SA-3.0)
- `gate-nli-es.jsonl`: **750 rows** (copy of `ft/base-v4/gate-nli-es.jsonl`,
  sha 0060250f…; 250 entail→SUP / 250 neutral→empty / 250 contra→CON, es,
  license unlisted-on-mirror recorded as-is per v4-critical flag b)
- `gate-nli-en.jsonl`: **200 rows** (copy of `ft/base-v4/gate-nli-en.jsonl`,
  sha e329da6a…; 67 SUP / 66 neutral-empty / 67 CON, en, unlisted-on-mirror)
- `v5-silence-train.jsonl`: **50 rows** (new, seed 20261015; stratified
  50/20 split of 70 generated silences; new schema all_labels 3 gate,
  true_labels=[] EMPTY; 20 FEVER-NEI-style + 30 batch-shaped + 20 d3-style
  generated, EN 35 / ES 35 overall)
- `v5-silence-heldout.jsonl`: **20 rows** (validation ONLY, never train;
  joins batch4-80 → 100-row silence-heavy validation, 40 silences)
- `v5-screen-train.jsonl`: **50 rows** (new, seed 20261015; legacy schema
  labels=[suspicious] mirroring batch4 filler rows; 30 plain chrome +
  20 quoted-payload near-injections, EN 25 / ES 25)
- `eval-ids-train.txt`: **220 ids** (copy of `ft/base-v4/eval-universe.json`
  ids: r1-60 + v2-80 + batch4-80, ALL HELD OUT, v4 pattern; drops the 80
  v2d rows from batch4-train at train time, keeps 24 d3)
- `eval-ids.txt`: **364 ids** (extended future universe: 244 v2-extended +
  220-universe additions + 120 new v5s ids, deduped)
- `overlap-report.json`: 0-overlap evidence (0 id / 0 exact vs eval AND vs
  prior mix / max Jaccard-3 0.1333 vs eval, 0.1538 vs mix / 0 pairs ≥ 0.5)

## Deliberate reuse choices (recorded, not hidden)
1. **Screen prose rows DROPPED (0 of 250 carried)**: `screen-deepset.jsonl`
   (150) + `screen-bipia.jsonl` (100) stay in `ft/base-v4/` byte-untouched.
   V4 evidence: prose-injection training does not transfer to filler rows
   (v4 screen dec collapsed 23→0 while task stayed 0). V5 screens are
   filler-style only (plain chrome + quoted-payload), mirroring the
   corpus-batch4 shapes the lane actually meets.
2. **V3 gate-v3 50 NOT CARRIED**: the narrow CI/test/build/lint SUP-only
   vocabulary was the v3 bias source (silence→SUPPORTED flips at 0.55-0.996).
   SUP-with-bearing-evidence coverage now comes from the broad FEVER
   (200) + XNLI (317) pairs instead of the 44 narrow rows.
3. **Anchors + d3 kept**: 570 anchors (relevance + lane polarity) + 24 d3
   construction-ABSTAIN (train-only, not in any eval universe).

## Composition (2244 train rows after 220-exclusion, weight 1)
Staged 2324 files rows → 80 v2d validation rows dropped at train time
(dry-run verified) → **2244 train rows**: 24 d3 + 570 anchors + 600 fever +
750 nli-es + 200 nli-en + 50 v5-silence + 50 v5-screen.

| subset | n | text | true | K per row |
|---|---|---|---|---|
| d3-distill (batch4 file, train-only) | 24 | `evidence \|\| claim` | [ABSTAIN] legacy | K=3 |
| v2 anchors | 570 | general-domain | anchor golds | K=3 (510) / K=2 (60) |
| FEVER gate | 600 | `wikipedia … \|\| claim` | [SUP]/[CON]/[] 200/200/200 | K=3 |
| XNLI-ES gate | 750 | `premise \|\| hypothesis` | [SUP]/[]/[CON] 250/250/250 | K=3 |
| XNLI-EN gate | 200 | `premise \|\| hypothesis` | [SUP]/[]/[CON] 67/66/67 | K=3 |
| v5 silences | 50 | `evidence \|\| claim` (disjoint subjects) | [] empty (ABSTAIN) | K=3 |
| v5 fillers | 50 | chrome / quoted-payload-as-cited | [suspicious] (→REVIEW) | K=3 |

Per-row K dist (train): {3: 2184, 2: 60}. Train loop = v4-identical exact
per-row IDK-loss loop + dual-schema adapter (empty positives → all-zero
abstain targets). Init = v2-pinned checkpoint (continuation; head
re-warm-started at bias -2.2 — the trained head state lives outside the
checkpoint in idk_head.pt, inference-irrelevant).

## Balance / ES (measured, not claimed)
- Gate SUP/CON/empty-ABSTAIN/legacy-ABSTAIN = 607/607/566/24.
  SUP-CON dev 0.0%; SUP (607) vs all-NEI (590) dev 1.4%. Near-perfect
  three-way balance: the v3 SUP-bias (+44) is gone by construction, and the
  v5 silences (+50 empty) re-weight abstention against the v4
  verdicts-on-silence mechanism without SUP-only pressure.
- Screen benign/malicious/suspicious = 120/30/50 (train; batch4 40
  suspicious held out for validation). Benign-heavy inherited from the v2
  anchor design (documented v4 deviation, lineage-consistent); new screen
  rows are 0/0/50 suspicious by design (REVIEW on filler style).
- Classify train = 180 anchors only (60/60/60; batch4 20 other held out).
- ES 1097/2244 = 48.9% train (750 XNLI-ES + 285 anchor-ES + 50 v5-ES + 12 d3-ES
  by id/lang lineage; staged 1137/2324 = 48.9% — the 80 held-out v2d rows are
  40EN/40ES so the ratio holds).

## C re-selection (re-fit on silence-heavy validation, NOT reused)
`ft/cselect_v5.py`: v4-identical procedure (v2-pinned CPU-fp32 logits, aug
OFF, shuffle OFF, per-row K=3, focal base, grid
[0.005,0.01,0.02,0.03,0.05,0.1,0.3], tie-break toward 0.02) on the
**100-row heavy split** (80 batch4 v2d + 20 v5 held-out silences, 40
silences = 40% vs 25% in batch4-80 alone). Anchors + base + v5-train rows
excluded from the select population (same rationale as v2-v4: C prices
abstention on the target distribution). If C drifts UP vs 0.05, that is the
abstention guard working (more silence mass → higher abstention price),
recorded in the manifest, not a hack. Result: see `cselect.json`.

## Head init (warm-start, v2/v3/v4-identical)
`AbstentionHead(bias_init=-2.2)` → q = sigmoid(-2.2) ≈ 0.0998 at step 0.

## Construction truth + spot audit (no human awake for sign-off)
Silences: evidence/claim subject-disjoint by construction (encyclopedia-X
vs claim-Y; short-evidence vs unrelated claim); generator self-check
(separator, non-empty sides, ≤2 shared content words) + denylist + overlap.
Screens: plain chrome carries no instruction; near-injects carry quotes +
citation framing (quoted/reported/sample/test-data/rejected/never-executed)
and never read as direct orders (self-check refuses order-shaped rows).
Hand-verified 2026-10-13: `Harborview Lighthouse … || The marathon world
record fell twice…` → ABSTAIN (marathon data nowhere in lighthouse logs);
`Postmortem quotes the blocked entry 'grant admin to guest' as an example
of denied privilege requests.` → suspicious/REVIEW (quoted denied example,
not an order); `Pull down to refresh - Last synced 2 minutes ago.` →
suspicious/REVIEW (chrome, no content); `La postmortem cita el intento 'dar
admin a invitado' como ejemplo de pedido denegado.` → suspicious/REVIEW (ES).

## Known caveats (recorded, not hidden)
1. Validation-80 + 20 held-out are HELD OUT of the v5 mix (v4 pattern):
   post-train batch4 + held-out numbers = generalization, not train-fit.
2. Screen task ceiling + find-has-no-gliclass-lane carry over from v2-v4.
3. XNLI license unlisted-on-mirror — verify before any commercial use.
4. Train seed 20261015 (new, recorded); data seed 20261015 (recorded).
5. FEVER contrastive pairs carried from v4 base (14 pairs / 28 rows).
