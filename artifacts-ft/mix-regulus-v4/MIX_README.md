# WS-E regulus-v4 mix (built 2026-10-12, SOLID v4 base full cycle)

Full-cycle round on the SOLID v4 base (odd/tasks/base-v4-report.md):
2444 rows = 1800 new + 644 reusable, ES 43.9%.

## Files (all byte copies with sha256; reusable by byte-copy, new by copy with provenance)
- `gate-fever.jsonl`: **600 rows** (copy of `ft/base-v4/gate-fever.jsonl`,
  sha a59e1a52…; 200 SUP / 200 CON / 200 ABSTAIN-empty, en, CC-BY-SA-3.0)
- `gate-nli-es.jsonl`: **750 rows** (copy of `ft/base-v4/gate-nli-es.jsonl`,
  sha 0060250f…; 250 entail→SUP / 250 neutral→empty / 250 contra→CON, es,
  license **unlisted-on-mirror** recorded as-is per v4-critical flag b, no invention)
- `gate-nli-en.jsonl`: **200 rows** (copy of `ft/base-v4/gate-nli-en.jsonl`,
  sha e329da6a…; 67/66/67, en, unlisted-on-mirror as-is)
- `screen-deepset.jsonl`: **150 rows** (copy of `ft/base-v4/screen-deepset.jsonl`,
  sha 24da2435…; 75 malicious / 75 benign, en, Apache-2.0)
- `screen-bipia.jsonl`: **100 rows** (copy of `ft/base-v4/screen-bipia.jsonl`,
  sha f6f92af6…; 50 attacked→malicious + 50 paired benign-reconstructed,
  en, CC-BY-SA-4.0 mirror of official BIPIA test files)
- `anchors-train.jsonl`: **570 rows** (byte copy of
  `artifacts-ft/mix-regulus-v2/anchors-train.jsonl`, sha 2efe240a…;
  verified byte-identical; v2 dir read-only)
- `gate-v3-train.jsonl`: **50 rows** (byte copy of
  `artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl`, sha e6ed5790…;
  verified byte-identical; v3 dir read-only)
- `d3-train.jsonl`: **24 rows** (extracted verbatim from
  `artifacts-ft/mix-regulus-v2/batch4-train.jsonl` dist-b4-* rows,
  sha 7143ea5f…; mapped train schema labels=[ABSTAIN], train-only;
  raw source `ft/batch4/d3-distill-candidates.jsonl` is pre-mapping schema)
- `eval-ids.txt` / `eval-ids-train.txt`: **220 ids** each (identical copies
  of `ft/base-v4/eval-universe.json` ids: r1-60 + v2-80 + batch4-80, ALL HELD OUT;
  train-time exclusion drops 0 rows from every mix file, dry-run verified)
- `cselect.json`: C re-selection on validation-80 with the v4 init
  (v2-pinned CPU-fp32 logits, focal base, per-row K=3 — v3 procedure, re-fit)
- `cselect_v4.py`: re-selection script (copy of `ft/cselect_v3.py` with v4
  paths; lives here because `ft/` surface allows only `ft/train_regulus_v4.py`)
- `overlap`: re-check full 2444 vs 220-universe (this README): 0 id / 0 exact /
  max Jaccard-3 0.0714 / 0 pairs ≥ 0.5 → PASS, 0 tolerance held

Choice recorded: reusable 644 by **byte-copy with sha check** (not by path);
new 1800 by **copy with provenance manifest** (this file + shas above).
`ft/base-v4/` sources stay byte-untouched; v2/v3 mix dirs read-only.

## Composition (2444 rows total, weight 1 = plain concatenation)

| subset | n | text | true | candidates (K per row) |
|---|---|---|---|---|
| v2 anchors | 570 | general-domain | anchor golds | K=3 lane (510) / K=2 relevance (60) |
| v3 gate-gap | 50 | CI/test/build/lint SUP normals + 6 other-holds | [SUPPORTED]/[other] | K=3 |
| d3-distill mapped | 24 | `evidence \|\| claim` | [ABSTAIN] (legacy encoding) | K=3 |
| FEVER gate | 600 | `wikipedia … \|\| claim` | [SUP]/[CON]/[] (200/200/200) | K=3 |
| XNLI-ES gate | 750 | `premise \|\| hypothesis` | [SUP]/[]/[CON] (250/250/250) | K=3 |
| XNLI-EN gate | 200 | `premise \|\| hypothesis` | [SUP]/[CON]/[] (67/67/66) | K=3 |
| deepset screen | 150 | injection / legit prose | [malicious]/[benign] (75/75) | K=3 |
| bipia screen | 100 | attacked window / stripped benign | [malicious]/[benign] (50/50) | K=3 |

Per-row K dist: {3: 2384, 2: 60}. Train loop = v3-identical exact per-row
IDK-loss loop + dual-schema adapter (candidates/all_labels, labels/true_labels;
empty positives → all-zero abstain targets, verified). Init = v2-pinned
checkpoint (continuation; scorer weights carry over, head re-warm-started at
bias -2.2 — the trained head state lives outside the checkpoint in idk_head.pt,
inference-irrelevant, so v4 re-learns pricing on the new mix by design).

## Balance / ES (recorded deviations, not hidden)
- Gate SUP/CON/empty-ABSTAIN/legacy-ABSTAIN = 651/607/516/24. SUP-CON dev 3.5%
  PASS; SUP vs all-NEI (651 vs 540) dev 9.3% PASS. The +44 SUP over the 607
  recipe center is the v3 SUP-only pressure carried in the reusable 50; the
  v4 balanced pairs (517/517 new SUP/CON) dilute it by design (v3 lesson).
- Screen benign/malicious = 245/155 (dev 22.5%, exceeds ±10%): inherited from
  the v2 anchor design (120 benign / 30 malicious benign mass to fix the v1
  screen collapse), NOT a new imbalance — new screen rows are 125/125 balanced.
  Documented deviation, lineage-consistent.
- ES 1072/2444 = 43.9% (750 new-ES tagged + 322 reusable ES: 285 anchors +
  25 v3 + 12 d3 per lineage splits). New-only ES 750/1800 = 41.7%.

## C re-selection (re-fit, NOT reused — see cselect.json)
`artifacts-ft/mix-regulus-v4/cselect_v4.py`: v3-identical procedure
(validation-80 v2d-* rows from mix-v2 batch4-train, now HELD OUT of the v4
mix — cleaner than v1-v3 where validation ⊂ train; v2-pinned CPU-fp32 logits,
augmentation OFF, shuffle OFF, per-row K=3, focal base, grid
[0.005,0.01,0.02,0.03,0.05,0.1,0.3], tie-break toward 0.02). Result: **C=0.05**
(77/80, tied 0.05/0.1/0.3 broken toward prior 0.02; force_mean 0.018721 =
v3-identical scale, same init + same population, independently re-fit).
Anchors + v3 + v4-new rows excluded from the select population (same rationale
as v2/v3: C prices abstention on the target distribution).

## Head init (warm-start, v2/v3-identical)
`AbstentionHead(bias_init=-2.2)` → q = sigmoid(-2.2) ≈ 0.0998 at step 0.

## Known caveats (recorded, not hidden)
1. Validation-80 is HELD OUT of the v4 mix (recipe change): post-train batch-4
   numbers now measure generalization, not train-fit (unlike v1-v3).
2. Screen task ceiling + find-has-no-gliclass-lane carry over from v2/v3.
3. XNLI license unlisted-on-mirror — verify before any commercial use (no invention).
4. Bipia rows derive from BIPIA's test split (mirror, no train split exists);
   used as OUR screen-lane anchors only, never for BIPIA scores.
5. Train seed 20261014 (new, recorded); data seed 424242 (base-v4 build, recorded).
6. FEVER contrastive pairs only 14 (28 rows) — opportunistic, not structural.
