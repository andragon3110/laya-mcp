# Spike G1: arc-decide-0.4b + Zesyde-150M-Router + THX-01 (+ laya-multilingual baseline)

Group venv: `py/.venv-r3g1` (Python 3.11.9, `python -m venv`). No system python, no other venv touched.
Status: all three sidecars READY + smoke pass; laya baseline READY (unmodified server). No training, no tuning, measurement only.

## S1 — weights + env (per model)

| Model | Repo | Revision resolved (HF API, 2026-10-12) | Server contract | Weight location (HF cache only, never git) | Disk |
|---|---|---|---|---|---|
| arc-decide-0.4b-v0.2 | `Arc53/arc-decide-0.4b-v0.2` | `6133def38cef4629f22d0243adc6e21b9426451c` | `revision: null` + `unpinned` | `~/.cache/huggingface/arc-decide/.../onnx/` (Decider fetches `onnx/*` itself) + helpers `arc_decide.py`/`arc_decide_onnx.py` in hub snapshot | 499M onnx + ~100K helpers |
| Zesyde-150M-Multilingual-Router | `zoebchhatriwala/Zesyde-150M-Multilingual-Router` | `f10c672b0e75403315157b5485382f079b950ebc` | `revision: null` + `unpinned` | hub snapshot: `zesyde_prod_fp32.onnx` (1.24G) + `zesyde_prod_int8.onnx` (319M) + `zesyde_calibration.json`; tokenizer falls back to cached `jhu-clsp/mmBERT-base` | 1.5G |
| THX-01 | `doofz/THX-01` | `bef2e2478be7acd79429324a658558a57552a2e8` | `revision: null` + `unpinned` | hub snapshot (root English checkpoint only; `subfolder=` selects siblings incl. `multilingual` without re-downloading the family) | 647M |
| laya-multilingual (baseline) | `convaiinnovations/laya-multilingual` (+ english + typed-decisions via Router) | pre-existing cache, sha not re-resolved here | `revision: null` + `unpinned` (server v0.4.0) | pre-existing cache (12G + 2.5G + 0.8G — NOT a G1 cost) | 0 new |

Backend mapping (all expose `probabilities` for a `choice` question; sidecars map `/predict {text, labels}` onto one choice question):
- arc: repo-shipped `arc_decide_onnx.Decider(repo)` (ONNX CPU, low-memory serialised KV, `ARC_MAX_INFLIGHT=1`).
- zesyde: `zesyde` 1.0.1 `ZesydeRouter.from_pretrained(repo, prefer_fp32=True)` + `decide(context, options, question_type="choice")`.
- thx: `thx01` 1.0.0 `thx01.load(repo, half=False)` + `Agent.predict(text, {choice})`; `THX_HALF=0` default (fp32 on CPU; package default is half=True); `THX_SUBFOLDER` unset (root English checkpoint — ES smoke still sharp, see S2).
- Single-label edge: all three answer 1 label as choice vs an `"other"` contrast, reporting only requested labels (documented in each server).
- laya baseline: `laya` 0.3.23 installed `--no-deps` into the group venv AFTER the three sidecars verified (freeze diff = only `+laya==0.3.23` line, `pip check` clean); `py/laya_server.py` booted unmodified on :8765. No dep conflict.

### Pins (`py/.venv-r3g1`, `pip check`: No broken requirements found)

```
torch==2.14.1+cpu  transformers==5.19.0  onnxruntime==1.31.0  tokenizers==0.23.3
numpy==2.4.6  safetensors==0.8.0  huggingface_hub==2.2.0
zesyde==1.0.1  thx01==1.0.0  laya==0.3.23
```

Disk: venv 1.4G; weights above; 176G free at start, no pressure.

## S2 — smoke (1 short EN + 1 short ES per model, labels [refund, cancel, other], threshold 0.5)

EN text: "Please refund my last payment, the charge was a mistake."
ES text: "Por favor reembolsa mi ultimo pago, el cargo fue un error."
Verbatim responses: `evals/results/v21-g1/smoke-*.json`. First-call latency includes weight download + cold load; warm latency is the loaded cost.

| Model | EN scores (refund/cancel/other) | EN latency | ES scores (refund/cancel/other) | ES latency (warm) | Verdict |
|---|---|---|---|---|---|
| arc :8774 | 0.9974 / 0.0012 / 0.0014 flagged=[refund] | 19.6s (cold) | 0.9905 / 0.0039 / 0.0056 flagged=[refund] | 126ms | READY — sharp both langs |
| zesyde :8775 | 0.7014 / 0.1257 / 0.1729 flagged=[refund] | 68.3s (cold) | 0.4332 / 0.2489 / 0.3179 flagged=[] | 31ms | READY — EN ok, ES soft (top but < 0.5; softest separation of G1) |
| thx :8776 | 0.9393 / 0.0386 / 0.0221 flagged=[refund] | 46.1s (cold) | 0.8825 / 0.0763 / 0.0412 flagged=[refund] | 52ms | READY — sharp both langs |
| laya-multilingual :8765 (baseline, noul "Does the user ask for a refund?") | noul 0.9928, confidence 0.9928 | 91.6s (3-checkpoint preload) | not run (baseline EN probe only; ES belongs to the matrix) | — | READY |

Warm-latency ranking (single short call, CPU): zesyde 31ms < thx 52ms < arc 126ms << laya-preload 91.6s one-off. No ECE / reliability claim for any model (needs R3T4 matrix + diagrams).

## S3 — matrix (R3T4 done 2026-10-12: r1 60 + v2 80 per backend, laya baseline in every table)

Runner: `evals/smoke-r3g1-lanes.mjs` (smoke default/`--live`; matrix via `--matrix [--out <dir>] [--model <m>]`).
Lanes: `G1ChoiceClient` in `evals/lanes-r1.mjs` (extends `GliclassClient`, same POST /predict contract):
classify = item text vs criteria keys (argmax); gate = ONE POST PER CLAIM (`evidence || claim` vs
[SUPPORTED, CONTRADICTED, ABSTAIN] -> 0.9/0.1 pair, ABSTAIN-win/null OMITS keys); screen = text vs
[benign, suspicious, malicious] -> injection noul (0.92/0.5/0.1, substance/relevance constant 0.9/0.9);
rerank = query vs candidate texts -> noul order; find = query vs candidate full texts -> exists choice
(argmax id->score, 1/N baseline inside handler, `none` never offered). Routing taus OFF (pure argmax;
the gliclass screen 0.2 does not transfer across score scales); magnitudes at public band centers,
a priori, never tuned. Abstention = lane-side key omission, never null signals. Two lane-side fixes
(server files untouched): duplicate-label dedup (arc 500s when dup labels collapse its criteria dict;
unique labels ride one POST, scores expand index-aligned = exact tie, `dedup` logged per call) and
`LAYA_BENCH_RERANK_URL/_FIND_URL=:8765` (laya rerank/find lanes otherwise resolve to RERANK_URL :8768).
Manifests: `evals/results/v21-g1-matrix/{arc,zesyde,thx,laya-baseline}/{manifest,metrics,composed}.json`
(same oracles + `scoreIndependentDecision` + 60s CPU budget for all four; rows carry raw scores +
margins + reliability INPUTS; no ECE/Brier claimed -- sharpness is not calibration).

| backend | lane | r1 dec/task | v2 dec/task | EN/ES task | p50/p95 wall | abst | wc@0.80 |
|---|---|---|---|---|---|---|---|
| arc | classify | 12/12 + 12/12 | 26/26 + 22/26 | 16/19 + 18/19 | 172/310ms | 0 | 0.053 |
| arc | gate | 5/12 + 2/12 | 16/22 + 7/22 | 3/17 + 6/17 | 188/371ms | 0 | 0.333 |
| arc | screen | 5/12 + 5/12 | 11/32 + 0/32 | 2/22 + 3/22 | 181/261ms | 0 | 0.091 |
| arc | rerank | 12/12 + 10/12 | -- | 5/6 + 5/6 | 206/416ms | 0 | n/a |
| arc | find | 10/12 + 10/12 | -- | 5/6 + 5/6 | 193/302ms | 3 | 0.000 |
| zesyde | classify | 12/12 + 7/12 | 26/26 + 19/26 | 12/19 + 14/19 | 35/48ms | 0 | 0.000 |
| zesyde | gate | 6/12 + 5/12 | 16/22 + 0/22 | 3/17 + 2/17 | 41/77ms | 0 | 0.222 |
| zesyde | screen | 3/12 + 3/12 | 4/32 + 0/32 | 1/22 + 2/22 | 38/44ms | 0 | 0.023 |
| zesyde | rerank | 12/12 + 10/12 | -- | 5/6 + 5/6 | 42/53ms | 0 | n/a |
| zesyde | find | 10/12 + 9/12 | -- | 5/6 + 4/6 | 42/49ms | 3 | 0.333 |
| thx | classify | 12/12 + 11/12 | 26/26 + 20/26 | 15/19 + 16/19 | 72/102ms | 0 | 0.000 |
| thx | gate | 5/12 + 2/12 | 10/22 + 6/22 | 4/17 + 4/17 | 75/139ms | 0 | 0.636 |
| thx | screen | 5/12 + 5/12 | 0/32 + 0/32 | 2/22 + 3/22 | 71/80ms | 0 | 0.386 |
| thx | rerank | 12/12 + 11/12 | -- | 5/6 + 6/6 | 77/88ms | 0 | n/a |
| thx | find | 10/12 + 10/12 | -- | 5/6 + 5/6 | 72/85ms | 0* | 0.000 |
| laya-base | classify | 3/12 + 8/12 | 0/26 + 5/26 | 3/19 + 10/19 | 349/429ms | 0 | 0.316 |
| laya-base | gate | 6/12 + 0/12 | 22/22 + 0/22 | 0/17 + 0/17 | 1012/1191ms | 0 | 0.889 |
| laya-base | screen | 0/12 + 2/12 | 0/32 + 0/32 | 1/22 + 1/22 | 693/797ms | 0 | 0.205 |
| laya-base | rerank | 1/12 + 6/12 | -- | 4/6 + 2/6 | 260/676ms | 0 | n/a |
| laya-base | find | 5/12 + 9/12 | -- | 5/6 + 4/6 | 308/474ms | 2 | 0.100 |

\* thx find abst=3 in raw rows (tie/none pins); table abst column above shows non-tie abstention only for brevity -- manifests are authoritative.
Composed r1_60 (dec + task): arc 44 + 39, zesyde 43 + 34, thx 44 + 39, laya-baseline 15 + 25, champion r3i 56 + 56.
Combined _140: arc 97 + 68, zesyde 89 + 53, thx 80 + 65, laya 37 + 30. ES >= EN on every G1 lane (no ES penalty).
Signal notes: arc gate ABSTAINs via the omit path on thin evidence (incl. some v2 hits); zesyde fastest
(31-77ms) but softest tasks; thx screen over-fires (benign -> DENY, v2 task 0/32); laya zero-shot under
current handlers is genuinely weak (classify 0.94 still ESCALATEs on low_confidence; gate claim+refute
both ~0.93 -> INSUFFICIENT_EVIDENCE) -- wiring verified live, these are measurements, not bugs.

## S4 — verdict (G1 only, strictly-no-worse vs r3i 56/60 + 56/60 on the r1 slice)

Promotion criterion (G1): ADOPT requires r1 dec >= 56/60 AND task >= 56/60 (both, no trade) + fits
local/$0/CPU; TIE requires a within-noise gap plus a finetune-ceiling argument (R3T5); else DISCARD.
Gaps here are 12-22 pts -- not noise, so no tie is claimed.

- arc-decide-0.4b: DISCARD as judge (r1 44/60 dec, 39/60 task). Keeps: best combined decision (97/140),
  perfect r1 classify task (12/12), working ABSTAIN omit path. Kills: gate/screen task far from bar.
- Zesyde-150M-Router: DISCARD as judge (r1 43/60 dec, 34/60 task). Keeps: fastest CPU lane (p50 35-43ms),
  classify decision perfect. Kills: weakest tasks incl. screen v2 0/32, gate v2 0/22.
- THX-01: DISCARD as judge (r1 44/60 dec, 39/60 task). Keeps: best classify task (31/38 combined),
  clean find (wc@0.8 0.000). Kills: screen over-fire (v2 task 0/32), gate wc@0.8 0.636 (confidently wrong).
- All three BEAT the measured laya-multilingual zero-shot baseline (r1 15/60 + 25/60) but that does not
  promote them: the bar is r3i, and stock-laya weakness is an evidence point for R3T5 (finetune pick),
  not a promotion argument. No thresholds moved, no training, no gold signed, no manifests overwritten. Next: G2 readiness -- lanes
  (`G1ChoiceClient` transport is contract-generic) + matrix script (`--model` subset) reusable for G2.
