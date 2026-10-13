# Spike G2: Horizon-guard-small + Galvanize-60M + mdeberta-en-es (+ laya-multilingual baseline)

Group venv: `py/.venv-r3g2` (Python 3.11.9, `python -m venv`). No system python, no other venv touched (G1 venv intact, laya served unmodified on :8765).
Status: all three sidecars READY + smoke 15/15 green; laya baseline READY (unmodified server). No training, no tuning, measurement only.

## S1 — weights + env (per model)

| Model | Repo | Revision resolved (HF API, 2026-10-12) | Server contract | Weight location (HF cache only, never git) | Disk |
|---|---|---|---|---|---|
| horizon-guard-small | `Horizon-Labs/prompt-injection-guard-small` | `e0e88c4e940ee7e1b52bdf943d501ec696b83b9b` | `revision: null` + `unpinned` | hub snapshot (model.safetensors + onnx/ + tokenizer) | 1.4G |
| Galvanize-60M | `usezn/Galvanize-60M` | `7bf8df0d3c9cd724c5773a1c73d7c81ebb0f2082` | `revision: null` + `unpinned` | hub snapshot (`onnx/model_quantized.onnx` INT8 + tokenizer.json) | 172M |
| mdeberta-en-es | `edithngalame/mdeberta-v3-prompt-injection-en-es` | `04afb3c60e2ce15b8a3717a654a252226ab3f2e4` | `revision: null` + `unpinned` | hub snapshot (`onnx/model.onnx` fp32 + `onnx/tokenizer.json` + `onnx/gateway.json`) | 1.1G |
| laya-multilingual (baseline) | `convaiinnovations/laya-multilingual` | pre-existing cache, sha not re-resolved here | `revision: null` + `unpinned` (server v0.4.0) | pre-existing cache (NOT a G2 cost) | 0 new |

Backend mapping (all expose a binary p(injection) mapped onto a synonym axis):
- horizon: transformers `ModernBertForSequenceClassification` (fp32 CPU, inj_id resolved from config label2id, fallback 1); 8k ctx via max-pool windowing (512-token chunks, max 16, chunk MAXIMUM = score, a priori).
- galvanize: ONNX Runtime `onnx/model_quantized.onnx` (INT8, the card's served artifact), output `probabilities` = p(MALICIOUS) direct; tokenizer truncated 512 (card max_length). Card operating point (block p>=0.95) REPORTED, never applied.
- mdeberta: ONNX Runtime `onnx/model.onnx` (fp32 ONLY -- repo INT8 `model_int8.onnx` is broken upstream and never loaded), output `margin` -> p=sigmoid(margin); tokenizer from the onnx dir, truncated 512 (gateway max_len). Card operating point (`onnx/gateway.json` threshold_margin -3.335) REPORTED, never applied.
- Synonym axis (all three, documented per server): injection synonyms -> p, safe synonyms -> 1-p, everything else -> 0.0. Screen's `suspicious` always scores 0.0, so lane argmax reduces to a benign/malicious binary. Single-label needs no contrast (binary head always yields p).
- laya baseline: unmodified `py/laya_server.py` :8765 (served from its own venv; G2 venv carries no laya package).

### Pins (`py/.venv-r3g2`, `pip check`: No broken requirements found)

```
torch==2.14.1+cpu  transformers==5.19.0  onnxruntime==1.31.0  tokenizers==0.23.3
numpy==2.4.6  safetensors==0.8.0  huggingface_hub==2.2.0
```

Disk: venv 957M; weights above; 166G free at end, no pressure. Setup < 1h per model (no BLOCKED).

## S2 — smoke (5 r1 screen cases x 3 guards = 15 live; normal EN/ES + adversarial EN/ES + ambiguous EN)

First-call latency includes cold load (weights pre-downloaded to HF cache); warm latency is the loaded cost.

| Model | Cold (EN normal) | Warm range | Adversarial EN/ES | Ambiguous EN | Verdict |
|---|---|---|---|---|---|
| horizon :8777 | 7.3s | ~27-34ms | DENY/0.9 both | ALLOW/valid (gold REVIEW) | READY -- sharp both langs |
| galvanize :8778 | 5.1s | ~5-6ms | DENY/0.9 both | DENY/0.9 (gold REVIEW, over-fire) | READY -- fastest, over-fires |
| mdeberta :8780 | 7.9s | ~25-35ms | DENY/0.9 both | ALLOW/valid (gold REVIEW) | READY -- sharp, ES parity |
| laya :8765 (baseline) | n/a (preloaded) | ~700ms | (matrix) | (matrix) | READY |

Warm-latency ranking (single short call, CPU): galvanize ~5ms < horizon/mdeberta ~30ms << laya ~700ms. No ECE / reliability claim for any model (needs matrix + diagrams).
Verbatim smoke lines: shell history of `node evals/smoke-r3g2-lanes.mjs` (15/15 green, exit 0).

## S3 — matrix (R3T4 done 2026-10-12: r1 screen 12 + v2 screen 32 per backend, laya baseline in every table)

Runner: `evals/smoke-r3g2-lanes.mjs` (smoke default/`--live`; matrix via `--matrix [--out <dir>] [--model <m>]`).
Lanes: `G2GuardClient` (extends `GliclassClient`, same POST /predict contract, screen-shaped questions ONLY -- classify/gate/rerank/find THROW an explicit gap error instead of a fake mapping): screen = text vs [benign, suspicious, malicious] -> injection noul (0.92/0.5/0.1, substance/relevance constant 0.9/0.9); taus OFF (pure argmax; no validated tau exists for these binary heads); magnitudes at public band centers, a priori, never tuned. Abstention = lane-side key omission, never null signals.
Manifests: `evals/results/v22-g2-matrix/{horizon,galvanize,mdeberta,laya-baseline}/{manifest,metrics,composed}.json` (same oracles + `scoreIndependentDecision` + 60s CPU budget for all four; rows carry raw scores + margins + reliability INPUTS; no ECE/Brier claimed -- sharpness is not calibration).

| backend | r1 screen dec/task | v2 screen dec/task | EN/ES (r1 task) | p50/p95 wall | abst | wc@0.70 |
|---|---|---|---|---|---|---|
| horizon | 8/12 + 8/12 | 0/32 + 0/32 | 4/6 + 4/6 | 30/33ms | 0 | 0.182 |
| galvanize | 7/12 + 7/12 | 0/32 + 0/32 | 3/6 + 4/6 | 5/7ms | 0 | 0.614 |
| mdeberta | 6/12 + 6/12 | 0/32 + 0/32 | 3/6 + 3/6 | 29/32ms | 0 | 0.295 |
| laya-baseline | 0/12 + 2/12 | 0/32 + 0/32 | (matrix) | 697/809ms | 0 | 0.364 |

Composed screen r1_12 (dec + task): horizon 8 + 8, galvanize 7 + 7, mdeberta 6 + 6, laya-baseline 0 + 2, champion r3i 10 + 10 (v20 verified).
Combined screen_44: horizon 8 + 8, galvanize 7 + 7, mdeberta 6 + 6, laya 0 + 2. No ES penalty on any guard.
Signal notes: horizon perfect on the decisive slice (normal/difficult/adversarial EN+ES 8/8) -- all 4 misses are REVIEW golds (2 ambiguous + 2 negative), structural: a binary head cannot emit the middle verdict. Galvanize over-fires (difficult-EN ALLOW->DENY 0.94, ambiguous->DENY ~1.0, wc@0.7 0.614 confidently wrong). mdeberta misses real attacks with high confidence (EN+ES adversarial-02 -> benign ~0.999), which kills the ES-specialist story. v2 screen is 0/32 dec for ALL guards AND laya: every v2 screen gold is REVIEW/irrelevant (filler texts), unwinnable without a middle verdict (arc managed 11/32 dec in G1 only via its suspicious argmax) and task `irrelevant` is unwinnable under the 0.9/0.9 lane prior (G1 choice lanes also 0/32 task) -- structural corpus fact, not a guard failure.
Coverage gaps (recorded, never run): classify/gate/rerank/find. Empirical probe (curl, all three sidecars): classify [refund, cancel, other] and gate [SUPPORTED, CONTRADICTED, ABSTAIN] both return all-0.0 scores -- lane-side argmax would first-max-fake a verdict (SUPPORTED always wins ties), so `G2GuardClient.predict` refuses non-screen shapes with an explicit gap error.

## S4 — verdict (G2 only, strictly-no-worse vs r3i screen 10/12 + composed 56/60+56/60)

Promotion criterion (G2): ADOPT requires r1 screen dec >= 10/12 AND task >= 10/12 (both, no trade) + fits local/$0/CPU; TIE requires a within-noise gap plus a finetune-ceiling argument (R3T5); else DISCARD.

- Horizon-guard-small: DISCARD as judge (r1 screen 8/12 + 8/12 -- 2-pt gap, not within the strict bar). Keeps: best G2 screen, perfect decisive slice EN+ES, ~30ms CPU, 141M ModernBERT lineage (finetune-candidate note for R3T5). Kills: no middle verdict (all REVIEW golds missed by construction).
- Galvanize-60M: DISCARD as judge (r1 screen 7/12 + 7/12). Keeps: fastest lane measured (~5ms CPU), lightest (60M). Kills: over-fire + wc@0.7 0.614 (confidently wrong on benigns).
- mdeberta-en-es: DISCARD as judge (r1 screen 6/12 + 6/12). Keeps: ES parity on normals, ~30ms CPU. Kills: high-confidence misses on real attacks (adversarial-02 EN+ES -> benign ~0.999); no ES-specialist edge over horizon.
- All three BEAT the measured laya-multilingual screen baseline (r1 0/12 + 2/12) but that does not promote them: the bar is r3i, and stock-laya weakness is an evidence point for R3T5 (finetune pick), not a promotion argument. No thresholds moved, no training, no gold signed, no manifests overwritten (new `v22-g2-matrix/` only). Next: G3 readiness -- `G2GuardClient` screen-only transport + matrix script (`--model` subset) reusable for G3 screen coverage; classify/gate/rerank/find gaps stand for any pure binary guard.
