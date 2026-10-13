# base-v4 solidity report (R3+R4, NO training runs)

Base inventory (new + reusable, copies forbidden — paths only):

| file | rows | langs | license |
|---|---|---|---|
| `ft/base-v4/gate-fever.jsonl` | 600 (200 SUP / 200 CON / 200 ABSTAIN-empty; 14 contrastive SUP+CON pairs on shared evidence, 28 rows) | en | CC-BY-SA-3.0 |
| `ft/base-v4/gate-nli-es.jsonl` | 750 (250 entail / 250 neutral / 250 contra) | es | unlisted-on-mirror (verify) |
| `ft/base-v4/gate-nli-en.jsonl` | 200 (67 / 66 / 67; = MNLI-train, documented lineage) | en | unlisted-on-mirror (verify) |
| `ft/base-v4/screen-deepset.jsonl` | 150 (75 injection→malicious / 75 legit→benign) | en | Apache-2.0 |
| `ft/base-v4/screen-bipia.jsonl` | 100 (50 attacked→malicious + 50 paired benign-reconstructed, pair_id linked) | en | CC-BY-SA-4.0 (mirror of official BIPIA test files) |
| `artifacts-ft/mix-regulus-v2/anchors-train.jsonl` | 570 (by reference) | 285 en / 285 es (from ids) | synthetic-anchor |
| `artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl` | 50 (by reference) | 25 en / 25 es (from ids) | synthetic-gate-v3 |
| `ft/batch4/d3-distill-candidates.jsonl` | 24 train-only (by reference) | 12 en / 12 es | batch4-SIGNED |
| batch-4 80 (`evals/corpus-batch4/`) | HELD OUT validation, not in base | — | — |

Totals: new **1800** + reusable **644** = **2444** base rows. Gaps addressed: SUP/CON balance (was 134 SUP vs 90 CON pressure), quoted-payload (deepset roleplay/jailbreak + BIPIA indirect), ES depth (750 new ES + 322 reusable ES = 1072/2444 = 43.9%).

## 5-check solidity verdict: SOLID

1. **Provenance 100%** — PASS. Every new row carries `{source, license, lang, orig_id}`; per-source table above + `ft/base-v4/SOURCES.json` (URLs, pins `datasets==4.3.0` + `gliclass==0.1.20`, row counts). FEVER license verified via HF tags (CC-BY-SA-3.0, never assumed); XNLI license honestly unlisted; BIPIA mirror provenance pinned to upstream commit `a004b69e` with sha256 per part.
2. **Overlap 0** — PASS. `python ft/base-v4/check.py` (precedent: `ft/gen_gate_v3.py` ids+exact+Jaccard-3+denylist): 0 id / 0 exact / 0 denylist vs 220-id+text universe, **max Jaccard-3 = 0.0317**, 0 pairs ≥ 0.5; vs 724 prior-mix texts: 0 exact, max Jaccard-3 = 0.0909. Sampler drops (34: 7 denylist, 27 no-extract) recorded in `build-stats.json`, never forced in.
3. **Balance ±10%** — PASS. Gate SUP/CON/NEI = 517/517/516 (dev 0.00%/0.10%); screen MAL/BEN = 125/125 (dev 0.00%). No deviation to document.
4. **ES ≥ 40%** — PASS. New rows 750/1800 = **41.7%**; whole base 1072/2444 = 43.9%. Documented deviation: XNLI-ES sized to 750 (not ~300) because it is the only ES lever — the solidity check outranks the sample hint.
5. **Separation holds** — PASS. `python ft/base-v4/separate.py`: v2-pinned loaded READ-ONLY (CPU, `torch.no_grad`, pinned dir untouched, model released after) scored a fixed 140-row hard sample: **acc 0.565 vs chance 0.333 on 108 non-empty rows (wrong-rate 0.435 = hard but learnable)**; empty rows abstain-rate@0.5 = 0.344, mean maxprob 0.547 (uncertain, not collapsed). Per-source: b4x 0.800 / b4m 0.650 / b4f 0.517 / b4d+b4b 0.300 (screen hardness = novel signal for the weakest v2 lane, consistent with known v2-screen gaps).

Missing list: none. NOT-SOLID conditions: none. No training ran; no `corpus-*`, mixes, or manifests touched.

## Mix recipe proposed for v4 (parent launch gate decides; exact file list + expected counts)

1. `artifacts-ft/mix-regulus-v2/anchors-train.jsonl` (570) — intact anchors
2. `artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl` (50) — gate normals hold
3. `ft/batch4/d3-distill-candidates.jsonl` (24) — d3 train-only
4. `ft/base-v4/gate-fever.jsonl` (600) + `gate-nli-es.jsonl` (750) + `gate-nli-en.jsonl` (200) — balanced gate pairs
5. `ft/base-v4/screen-deepset.jsonl` (150) + `screen-bipia.jsonl` (100) — screen direct + indirect
Expected: **2444 rows**, gate SUP/CON/NEI ≈ 607/607/606 (incl. reusable), ES 43.9%.
Flags for the mix author: (a) new ABSTAIN rows use parent-spec `true_labels=[]` (legacy mixes used `labels=["ABSTAIN"]` — v4 train loop must handle empty positives); (b) bipia-benign rows are attack-stripped reconstructions (labeled as such); (c) bipia rows derive from BIPIA's test split; (d) XNLI license unlisted — verify before any commercial use; (e) FEVER pairs only 14 (28 rows) — pair mining is opportunistic, not structural.

## Files created (all inside allowed surfaces)

- `ft/base-v4/gate-fever.jsonl`, `gate-nli-es.jsonl`, `gate-nli-en.jsonl`, `screen-deepset.jsonl`, `screen-bipia.jsonl` (1800 rows)
- `ft/base-v4/build.py` (seed 424242), `check.py`, `separate.py`, `dump_eval_universe.mjs`
- `ft/base-v4/eval-universe.json` (220), `SOURCES.json`, `build-stats.json`, `check-report.json`, `separate-report.json`
- `ft/base-v4/raw/fever-train.jsonl` (33 MB official download) + `wiki-cache.json`
- `ft/base-v4/.pylibs/` (pip `--target` installs: datasets 4.3.0, gliclass 0.1.20 + deps; system python untouched — no venv-ft exists on this machine)
- `odd/tasks/base-v4-report.md` (this file)

## Verification (synchronous, foreground)

- row counts per file + langs: 600 en / 750 es / 200 en / 150 en / 100 en (1800; `check.log` pastes counts) ✓
- `python ft/base-v4/check.py`: exit 0, CHECK: PASS — schema PASS, balance devs 0.00%/0.10%/0.00%, ES 41.7%, overlap-eval maxJ3 **0.0317** (0/0/0/0), overlap-mix maxJ3 0.0909 ✓
- v2 separation: `python ft/base-v4/separate.py` — acc **0.565** vs chance 0.333 (n=108), wrong-rate 0.435, abstain-rate 0.344 → SEPARATION: PASS; pinned checkpoint dir byte-untouched ✓
- `node evals/run.mjs`: **122/122** ✓
- No RED/GREEN (measurement + data build, no handler behavior; proportionate checks above per feature-doc applicable-checks).
