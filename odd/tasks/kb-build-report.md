# kb-v6 solidity report (Regulus KB, NO training runs)

Build worker output per `odd/tasks/regulus-kb-spec.md` (frozen v1.0). No training
ran; no `corpus-*`, mixes, runs, or manifests touched; no push/PR/merge.

## Block inventory (new files in `ft/kb-v6/` + lineage refs)

| Block | File / refs | Rows | Langs | License (verified at pull) |
|---|---|---|---|---|
| B1 NLI core | `b1-nli-core.jsonl` | 900 (150 E/N/C × EN/ES) | ES 450 / EN 450 | XNLI unlisted-on-mirror |
| B2 NLI adversarial | `b2-anli.jsonl` | 600 (EN 400: SUP 110/NEI 181/CON 109 natural ANLI dist; ES-mirror 200: 57/82/61) | EN 400 / ES 200 | **cc-by-nc-4.0 (NC flagged)** |
| B3 Verify contrastive | `b3-verify-contrast.jsonl` | 700 (EN 450: SUP 162/CON 168/NEI 120; ES 250: 90/86/74; 85 SUP+CON pair_ids in-file) | EN 450 / ES 250 | VITC cc-by-sa-3.0, FMT apache-2.0, FaVIQ unknown-on-mirror |
| B4 Verify scale | `b4-fever.jsonl` | 900 (EN 600: 200/200/200; ES-mirror 300: 94/108/98; 53 contrastive pairs mined) | EN 600 / ES 300 | CC-BY-SA-3.0 |
| B5 Screen agents | `b5-screen.jsonl` (new 760) + batch4 screen-filler 40 by ref | 800 (attack 380 / benign 380 / suspicious 40 REVIEW) | EN 450 / ES 350 | deepset apache-2.0, BIPIA-mirror cc-by-sa-4.0, authored synthetic-kb-v6 |
| B6 Classify/other | `b6-classify.jsonl` (new 580) + batch4 classify-other 20 by ref | 600 (neutral-other 300 + repo bug 100 / feature 100 / other 80) | EN 300 / ES 300 | XNLI unlisted, authored synthetic-kb-v6 |
| B7 Lineage | `b7-silence.jsonl` (102) + refs 748 (batch4 104 + v2-anchors 570 + v3-50, d3-24 restated inside the 104) | 850 | ~50/50 (refs ES ~374 + bank 51) | per home file; bank synthetic-kb-v6 |

New rows **4542** (ES 1871 = 41.2%); unique physical KB **5290** (4542 + 748
lineage refs, ES ≈ 42.4%); spec block-math total **5350** (B5/B6 refs are the
same physical rows as inside B7's 104 — double-counted across blocks only).
ABSTAIN first-class: B2-neutral + B3-NEI + B4-NEI + B7 bank (all
`true_labels: []`), never thresholded. Every row carries
`{source, license, lang, orig_id}` recorded at pull time.

## 5-check solidity verdict: SOLID (1 flag for the launch gate)

1. **Provenance 100%** — PASS. Schema+provenance gate in `check.py` green;
   `SOURCES.json` records URLs, pins (`datasets==4.3.0`, `sentencepiece==0.2.2`,
   hub `2.2.0→1.33.0` by resolver, `pip check` clean), row counts, and the three
   documented deviations (MNLI≡XNLI-en lineage, fever.ai direct for the
   script-based HF mirror, bipia mirror for nonexistent microsoft/BIPIA).
   ANLI NC flagged; XNLI unlisted / FaVIQ unknown recorded honestly.
2. **Overlap 0** — PASS. `check.py` vs the EXTENDED universe (244 ids: fresh
   220 + mix-v2 244 file incl. batch4-train ids; 557 texts: 220 + 337):
   **0 id / 0 exact / 0 denylist, max Jaccard-3 = 0.1667, 0 pairs ≥ 0.5.**
   Authored rows were filtered at build time (drops recorded in `b*-stats.json`,
   never forced in); pulled rows exact-skip vs v4 texts (mix hygiene).
3. **Balance ±10%** — PASS. SUP/CON overall dev 0.44%; B3+B4 locus SUP/CON/NEI
   = 546/552/502 (devs 0.55%/4.20%/4.74%); B5 decisive MAL/BEN 380/340 dev
   5.56%. No deviation to document (B3 was rebalanced NEI-heavy mid-build;
   B2 keeps ANLI's natural neutral skew — sampling honesty, not imbalance).
4. **ES ≥ 40%** — PASS. New rows 1871/4542 = **41.2%**; full KB ≈ 42.4%.
   Every translated row passed the verdict-preserving protocol (opus-mt-en-es +
   back-translation second pass: Jaccard ≥ 0.30 + digits preserved + length
   sanity; failures dropped with the leg recorded).
5. **Separation holds** — PASS WITH FLAG. `separate.py` (v2-pinned, read-only
   CPU, `torch.no_grad`, released after): **acc 0.654 vs chance 0.333 on 130
   non-empty rows (wrong-rate 0.346 = hard but learnable)**; empty rows
   abstain-rate@0.5 = 0.577, mean maxprob 0.490 (uncertain, not collapsed).
   Per-block: b1 0.700 / b2 0.667 / b3 0.600 / b4 0.600 / b6 0.800 /
   b7-diag 0.833 / b5s-suspicious 0.700.
   FLAG: b5 decisive scored 4/20 in the sample; full-block rescore
   (`separate_b5full.py`, all 760): **241/720 = 0.335 vs 0.333 — beats chance.**
   Malicious slice 0.266 / benign 0.412 / suspicious 0.700. Mislabeling ruled
   out: dataset-gold pulled rows fail identically to authored rows (known
   v2-screen lane weakness — screen task historically 0/32), and the 0.700
   suspicious agreement validates the authoring semantics. No regeneration:
   resampling cannot fix lane weakness, only churn. **Launch gate decides
   whether the 0.002 margin needs a B5-attack top-up before the v6 mix.**

Missing list: none (no source exceeded the 45-min pull box; slowest pull was
the 39-batch wiki fetch at ~3 min; no gated source needed credentials).
NOT-SOLID conditions: none (all 5 checks green, 1 flag carried, not hidden).

## Mix recipe proposed for v6 (parent launch gate decides; exact files + counts)

1. `ft/kb-v6/b1-nli-core.jsonl` (900) — NLI core, balanced E/N/C, ES/EN
2. `ft/kb-v6/b2-anli.jsonl` (600) — adversarial NLI + ES mirror (NC-flagged)
3. `ft/kb-v6/b3-verify-contrast.jsonl` (700) — SUP+CON pairs + NEI
4. `ft/kb-v6/b4-fever.jsonl` (900) — balanced verify scale + pairs
5. `ft/kb-v6/b5-screen.jsonl` (760) — screen decisive + REVIEW golds
6. `ft/kb-v6/b6-classify.jsonl` (580) — neutral-other + repo bug/feature/other
7. `ft/kb-v6/b7-silence.jsonl` (102) — ABSTAIN silence bank
8. Lineage refs (read, never copied) by path only: `ft/batch4/*.jsonl` (104 SIGNED) +
   `artifacts-ft/mix-regulus-v2/anchors-train.jsonl` (570) +
   `artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl` (50)
Expected: **5290 unique rows**, gate SUP/CON/NEI ≈ 1330/1340/1660 (incl.
lineage anchors), ES ≈ 42.4%.
Flags for the mix author: (a) ABSTAIN rows use `true_labels: []` (v4-note
carries: legacy mixes used `labels: ["ABSTAIN"]` — train loop must handle empty
positives); (b) B2 is NC-licensed (no commercial redistribution); XNLI/FaVIQ
licenses unlisted/unknown — verify before commercial use; (c) bipia-benign rows
are attack-stripped reconstructions, from BIPIA's test split; (d) b5
malicious-slice hardness (0.266) — the lane that needs the signal most;
(e) B3/B4 pair_ids are the gate SUP+CON pair shape (shared evidence).

## Files created (all inside allowed surfaces)

- `ft/kb-v6/b1-nli-core.jsonl` (900), `b2-anli.jsonl` (600),
  `b3-verify-contrast.jsonl` (700), `b4-fever.jsonl` (900),
  `b5-screen.jsonl` (760), `b6-classify.jsonl` (580), `b7-silence.jsonl` (102)
- `ft/kb-v6/build_b1..b7.py`, `kb_util.py`, `kb_author.py`, `mt.py`,
  `check.py`, `separate.py`, `separate_b5full.py`, `dump_eval_universe.mjs`,
  `probe.py`, `peek.py` (tooling, seeds 606101–606107 / 777002)
- `ft/kb-v6/eval-universe.json` (220), `b7-lineage-refs.json`,
  `SOURCES.json`, `b*-stats.json`, `check-report.json`, `separate-report.json`
- `ft/kb-v6/raw/fever-train.jsonl` (fresh 33 MB official download) +
  `wiki-cache.json` (818 titles, own cache)
- `ft/kb-v6/mt-models/` (opus en-es + es-en snapshots, apache-2.0)
- this report (`odd/tasks/kb-build-report.md`)

## Verification (synchronous, foreground)

- per-file counts + langs: 900 (450 ES) / 600 (200 ES) / 700 (250 ES) /
  900 (300 ES) / 760 (330 ES) / 580 (290 ES) / 102 (51 ES) = 4542 (1871 ES =
  41.2%) ✓
- `check.py`: exit 0, CHECK: PASS — schema+provenance PASS, balances ≤5.56%,
  overlap-eval maxJ3 **0.1667** (0/0/0/0) ✓
- separation: `separate.py` acc **0.654** vs chance 0.333 (n=130) → PASS;
  `separate_b5full.py` decisive **0.335** vs 0.333 (720 rows); pinned
  checkpoint dir byte-untouched ✓
- `node evals/run.mjs`: **122/122** ✓
- No RED/GREEN (measurement + data build, no handler behavior; proportionate
  checks above per feature-doc applicable-checks).
