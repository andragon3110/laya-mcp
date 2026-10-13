# ODD Feature: bench-ronda3-top10-venv

## Objective
Test the 10 best HF text-classification (es,en, sort=modified) candidates against the current champion (r3i 56/60 decision + 56/60 task, `evals/results/v20/`) to decide if any beats it zero-shot, and which is the best backbone for finetuning. Laya-multilingual is always measured as baseline and as finetune candidate. Every test runs in an isolated venv, never system python, never a shared venv that breaks others.

## Problem
Ronda 1 (v5-v10) + spikes + r3a-r3i exhausted same-dose SFT. New HF models (Oct 2026, modified sort) claim better calibration, CPU speed, and ES coverage, but none measured under our harness. `ronda2-models.md` lists older candidates; the 10 from the live HF page need a fair paired comparison plus a finetune-ability verdict.

## Why
Decide with evidence: keep r3i, promote a new judge, or pick a finetune backbone that can move gate/screen task from 0.

## Scope (frozen)
- Candidates (10 + baseline, none tested here yet except gliclass-mini lineage):
  1. `knowledgator/gliclass-multilang-mini` 288M (lineage r3i, reference)
  2. `Arc53/arc-decide-0.4b-v0.2` 410M (noul/choice/score, questions.json)
  3. `zoebchhatriwala/Zesyde-150M-Multilingual-Router` 150M core (calibrated, Act/Escalate, ONNX INT8)
  4. `doofz/THX-01` 322M (RLCD, choice/noul/score + number/excerpt/cite)
  5. `Horizon-Labs/prompt-injection-guard-small` 141M (screen specialist)
  6. `usezn/Galvanize-60M` 60M (ultra-light guard, ONNX INT8)
  7. `MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli` ~80M (tiny NLI zero-shot)
  8. `edithngalame/mdeberta-v3-prompt-injection-en-es` 278M (ES injection, fp32 ONNX only)
  9. `answerdotai/ModernBERT-base` 149M (EN backbone for finetune, not zero-shot multi)
  10. `musubilabs/policylm-1.7b` 1.7B (policy engine, sidecar-only, NOT base)
  11. Baseline mandatory: `convaiinnovations/laya-multilingual` (mmBERT, via `py/laya_server.py` :8765, plus english + typed-decisions for context)
- Primitives: classify / screen / gate / rerank / find (decision-first). PII/v2-finetune only after a winner.
- Harness: `evals/corpus-r1/` (60 independent, 6 EN+6 ES x5), `evals/corpus-v2/` (80 signed), lanes in `evals/lanes-r1.mjs` + `smoke-r3a-lanes.mjs` pattern. No threshold tuning on r1/v2. No overwriting `v1`-`v20`.
- Venv policy (user-mandated): one isolated venv per model family under `py/.venv-<name>` (e.g. `.venv-arc`, `.venv-zesyde`, `.venv-thx`, `.venv-horizon`, `.venv-galvanize`, `.venv-minilm`, `.venv-mdeberta`, `.venv-modernbert`, reuse `.venv-r1-policylm` for policylm, `.venv-r1-laya` for laya). Each venv pins `torch CPU + transformers + onnxruntime` per model card. `pip check` clean required. No system python. Model weights only in HF cache, never in git. `artifacts-ft/` stays git-excluded.
- Ports (reuse ronda1 scheme, no clash): laya :8765, arc :8774, zesyde :8775, thx :8776, horizon-screen :8777, galvanize :8778, minilm :8779, mdeberta-es :8780, modernbert :8781 (finetune probe only), policylm :8771 existing.
- Forbidden: push/PR/merge, touching `train/` quarantine, moving thresholds, signing golds, training in measurement tasks, reusing a venv that breaks another model.

## Constraints
- CPU for all (RTX 3050 6GB cannot hold 1.7B + others; policylm already 19-25s/msg CPU). Time-box setup >1h per model => record and stop that spike.
- Zero generated text as judgment: new backends enter via documented lanes only.
- Laya-multilingual measured in every matrix (same oracles, same scoring, same timeout budget 60s for CPU).

## Checklist
- [ ] R3T1: venv matrix + pins (11 isolated venvs, versions + `pip check`, disk cost table). Route: delegated (multi-env setup inflates context).
- [ ] R3T2: sidecar adapters (one `py/<name>_server.py` per new model from `gliclass_server.py` template, /live+/ready+/models+/predict, 413 guards). Route: delegated writer (multi-file).
- [ ] R3T3: lanes + smoke 1 case/lane per model (classify/screen/gate/rerank/find mapping doc, stub 98/98 + r1 158/158 intact). Route: delegated writer.
- [ ] R3T4: full live matrix r1 (60) + v2 (80) per model, manifests `evals/results/v21+/` (never overwrite), EN/ES slices, latency + ECE where calibrated. Route: delegated (expensive runs).
- [ ] R3T5: finetune-ability verdict (backbone? transformers Trainer? LoRA? ONNX export? VRAM CPU/GPU cost? license? ES data? Laya-multilingual vs ModernBERT vs mDeBERTa vs MiniLM vs GLiClass). Reuses 699-row mix recipe (LR 2e-5 x2 epochs) as probe cost only, no training yet. Route: delegated research (read-only).
- [ ] R3T6: verdict adopt/tie/discard per model + promotion criterion (wins clear AND fits local/$0/CPU) + finetune pick. Route: parent.
- [ ] R3T7: report + next step (finetune run needs separate approval). Route: parent.

## Acceptance criteria
- Every live number comes from its isolated venv (venv path in manifest).
- Laya-multilingual present in every comparison table.
- Each spike has S1-weights + S2-smoke + S3-matrix + S4-verdict in `odd/tasks/spike-*.md`.
- No threshold moved, no probability claimed without reliability diagram + ECE.
- `node evals/run.mjs` 98/98 intact after R3T3.

## Applicable checks
- `py_compile` + `/live` smoke per sidecar (R3T2); versioned lane smoke (R3T3); full `--live` matrix as gate (R3T4). No test-first (measurement, not behavior); proportionate check = row-level matrix + stub/r1 regression.
- Forecast: ~7 sidecars + ~5 lane files + ~11 manifests ≈ 600-900 authored lines => delivery via chained manifests (one `vN` per model), no single giant commit.

## Final benchmark (all 3 groups, live CPU, same oracles+scoring, 60s budget)

r1_60 composed dec+task | combined r1+v2 _140 dec+task | home-lane note. Champion r3i: 56/60 + 56/60 (v20). Stub 122/122 intact throughout.

- G1 judges: arc 44+39 / 97+68; thx 44+39 / 80+65; zesyde 43+34 / 89+53; laya-zero-shot 15+25 / 37+30. ALL DISCARD (12-22pt gaps).
- G2 guards (screen r1_12): horizon 8+8; galvanize 7+7 (~5ms warm, over-fires); mdeberta 6+6 (fp32 only); laya screen 0+2; r3i screen 10+10. ALL DISCARD as judges; horizon keeps ModernBERT-finetune note.
- G3 backbones: minilm 41+28 / 87+31 (fastest ~22-35ms, classify dec 38/38 but task 6/38, gate confidently wrong); gliclass-STOCK 41+40 / 85+55 (best zero-shot TASK measured); policylm screen 0+2 (44/44 abstain, honest subset); modernbert probe-only (200 Paris + 409 no_zero_shot); laya 15+25 byte-identical to G1. ALL DISCARD as judges.
- No model beats r3i zero-shot. Closest on decisions: arc/thx 44; closest on tasks: gliclass-stock 40.

## R3T5/R3T6 verdict (parent, 2026-10-12)
- R3T6: DISCARD all 10 as zero-shot judges (strict bar: r1 dec>=56 AND task>=56, no ties — gaps 12-22pts, not noise). r3i stays champion. No thresholds moved, no training done, no manifests overwritten (v21-g1-matrix/, v22-g2-matrix/, v23-g3-matrix/).
- R3T5 finetune pick: 1) GLiClass-multilang-mini — ONLY backbone with measured delta stock 41+40 -> r3i 56+56 (+15/+16 same-dose SFT), training module in gliclass 0.1.20, Apache-2.0, ES prior, ~0.5s CPU. 2) MiniLM-NLI — cheapest NLI-shaped probe (~80M MIT, CPU-finetunable, XNLI-ES). 3) ModernBERT-base — best arch/8k ctx but zero ES prior (needs real ES data). mDeBERTa = shortest fp32-ONNX gate/screen path. Laya-multilingual = exhausted incumbent (plateaued 4 rounds + distill; keep as baseline, not horse).
- R3T7: finetune run needs separate approval (new data axes — abstention-aware objective or d3-style hard rows — not more same-dose epochs).

## Progress
- 2026-10-12 feature created; groups 3+3+4 confirmed; one venv per group.
- 2026-10-12 user confirmed groups 3+3+4. G1 = arc-decide-0.4b + Zesyde-150M + THX-01 (+ laya-multilingual baseline every matrix). G2 = Horizon-small + Galvanize-60M + mdeberta-en-es. G3 = MiniLM-NLI + ModernBERT-base + PolicyLM-1.7b + gliclass-mini ref. Final deliverable: live benchmark table + finetune-ceiling pick.
- Adjustment: one isolated venv per GROUP (py/.venv-r3g1, r3g2, r3g3) + existing laya venv pattern, instead of 11 venvs (disk sanity, same isolation guarantee: never system python, never shared breaking venv). Pins recorded per-group.

## Next step
- R3T1 G1: create py/.venv-r3g1 + laya baseline venv check, install torch CPU + transformers + onnxruntime + model pkgs, `pip check` clean.
- 2026-10-12 R3T3 done: G1 lanes in evals/lanes-r1.mjs (G1ChoiceClient: classify/screen/gate-1-per-claim/rerank/find over POST /predict, taus OFF, lane-side omission) + evals/smoke-r3g1-lanes.mjs smoke 15/15 green; stub suite 122/122 intact. Lane-side fixes only: duplicate-label dedup (arc dict-collapse 500), LAYA_BENCH_RERANK/FIND_URL=:8765 for the baseline.
- 2026-10-12 R3T4 done: evals/results/v21-g1-matrix/{arc,zesyde,thx,laya-baseline}/ r1(60)+v2(80), same scoring + 60s budget. r1_60 dec+task: arc 44+39, zesyde 43+34, thx 44+39, laya 15+25 vs champion r3i 56+56. S4: DISCARD all three as judges (12-22pt gaps, no tie); all beat stock-laya zero-shot (R3T5 evidence). No tuning/training/golds touched.
- Next: G2 (R3T1 venv py/.venv-r3g2 + R3T2 sidecars :8777-:8780/:8781) reusing G1ChoiceClient transport + --model subset matrix; then R3T5 finetune-ability + parent R3T6 verdict.
- 2026-10-12 R3T1-R3T4 G2 done: py/.venv-r3g2 (G1-identical pins, pip check clean) + 3 sidecars (:8777 horizon 141M windowing / :8778 galvanize INT8 `probabilities` / :8780 mdeberta fp32 `margin`, all revision-null+unpinned, lazy single-flight) + evals/smoke-r3g2-lanes.mjs (screen-only G2GuardClient, 15/15 smoke green; classify/gate/rerank/find recorded as gaps with all-0.0 curl evidence, never faked); stub suite 122/122 intact.
- 2026-10-12 G2 matrix evals/results/v22-g2-matrix/ screen r1(12)+v2(32): horizon 8+8, galvanize 7+7, mdeberta 6+6, laya-baseline 0+2 vs champion r3i screen 10+10 (v20); v2 0/32 everywhere is structural (all golds REVIEW/irrelevant, no middle verdict). S4: DISCARD all three as judges (strict bar); horizon closest (decisive slice 8/8, ~30ms) with a ModernBERT-finetune note for R3T5; galvanize fastest (~5ms) but wc@0.7 0.614; mdeberta misses real attacks at ~0.999. No tuning/training/golds touched.
- Next: G3 (MiniLM-NLI + ModernBERT-base + PolicyLM-1.7b + gliclass-mini ref) reusing the G2 screen harness where shapes match; then R3T5 finetune-ability + parent R3T6 verdict.
- 2026-10-12 R3T1-R3T4 G3 done: py/.venv-r3g3 (torch 2.14.1+cpu, transformers 5.19.0, gliclass 0.1.20, pip check clean) + isolated py/.venv-r3g3-policylm (transformers 4.57.6 card pin) + 4 sidecars (:8779 minilm-NLI full lanes / :8781 modernbert probe-only with honest 409 / :8771 policylm-r3g3 v1.2 screen-only / :8782 gliclass-stock full lanes) + evals/smoke-r3g3-lanes.mjs (G3ChoiceClient + PolicylmClient + probe checks, 19/19 smoke green; stub suite 122/122 intact).
- 2026-10-12 G3 matrix evals/results/v23-g3-matrix/ r1(60)+v2(80): minilm 41+28, gliclass-stock 41+40 (best zero-shot task measured), policylm screen 0+2 (44/44 abstention = the honest-subset finding), modernbert probe-only (Paris + 409), laya-baseline 15+25 in every table vs champion r3i 56+56. S4: DISCARD all three as judges (15-16pt gaps); stock-vs-r3i (+15/+16) is the measured finetune-delta reference for R3T5. No tuning/training/golds touched.
- Next: parent R3T6 verdict (adopt/tie/discard + finetune pick from the R3T5 input rows in spike-g3 S4/R3T5) + R3T7 report; a finetune run needs separate approval.
