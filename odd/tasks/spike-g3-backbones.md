# Spike G3: MiniLM-NLI + ModernBERT-base + PolicyLM-1.7b + gliclass-stock (+ laya-multilingual baseline)

Group venv: `py/.venv-r3g3` (Python 3.11.9, `python -m venv`) for minilm +
modernbert-probe + gliclass-stock. PolicyLM isolated in
`py/.venv-r3g3-policylm` (transformers 4.57.6 per its card; the group venv
carries transformers 5.19.0, so sharing would break one of them -- same
pattern as ronda1 `.venv-r1-policylm`). No system python, no other venv
touched (G1/G2 venvs intact, laya served unmodified on :8765 from its own
pre-existing process/venv).
Status: all four sidecars READY + smoke 19/19 green; laya baseline READY
(unmodified server). No training, no tuning, measurement only.

## S1 — weights + env (per model)

| Model | Repo | Revision resolved (HF API, 2026-10-12) | Server contract | Weight location (HF cache only, never git) | Disk |
|---|---|---|---|---|---|
| minilm-NLI | `MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli` | `0a71e92a985b6e1ad1828cf67ce9c459639c1dca` | `revision: null` + `unpinned` | hub snapshot (model.safetensors + tokenizer) | 430M |
| ModernBERT-base | `answerdotai/ModernBERT-base` | `8949b909ec900327062f0ebf497f51aef5e6f0c8` | `revision: null` + `unpinned` | hub snapshot | 573M |
| policylm-1.7b | `musubilabs/policylm-1.7b` (served at pinned `v1.2`, ronda1 pattern) | main `b3b2cd408a08a68ab6a30c1fc1e440204e44d57e` | `revision: v1.2` + `pinned` | hub snapshot (safetensors + inference/ helper + tokenizer/) | 3.3G |
| gliclass-stock | `knowledgator/gliclass-multilang-mini` (STOCK, not the r3i finetune) | `0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b` | `revision: null` + `unpinned` | hub snapshot | 561M |
| laya-multilingual (baseline) | `convaiinnovations/laya-multilingual` | pre-existing cache, sha not re-resolved here | `revision: null` + `unpinned` (server v0.4.0) | pre-existing cache (NOT a G3 cost) | 0 new |

Backend mapping:
- minilm: transformers `AutoModelForSequenceClassification` (fp32 CPU) + one
  premise+hypothesis forward pass PER label, score = softmax entailment
  probability (zero-shot-classification pipeline semantics, no pipeline
  object). Hypothesis template `"This example is {}."` (English template
  over XNLI-finetuned multilingual weights -- cross-lingual by training,
  incl. ES; a priori, never tuned). Entailment id resolved LIVE from the
  checkpoint config (label2id/id2label scan, never an assumed order); no
  ENTAILMENT label would 503 instead of a fake score. Single label rides
  vs an `"other"` contrast server-side (G1 parity); only requested labels
  returned. Pair truncated to 512 tokens (no 8k windowing on this
  backbone). `MINILM_MAX_INFLIGHT=1`.
- modernbert: transformers `AutoModelForMaskedLM` (fp32 CPU). PROBE ONLY:
  GET /probe runs one fixed mask-fill forward pass; POST /predict validates
  guards then refuses 409 `no_zero_shot` (no classification head exists, so
  any score would be invented). No lanes, never judgments.
- policylm: `policylm_infer` helper imported from the cached v1.2 snapshot's
  `inference/` dir (vendored `bidirlm/` encoder, sha-verified by the helper
  itself) + `PolicyLM.from_pretrained(repo, revision=v1.2, device=cpu)`.
  Screen lane via explicit-mode single category (prompt injection, rules
  verbatim from the screen handler); substance/relevance legs OMITTED (a
  moderation classifier has no such notion) so the handler's missing-signal
  path abstains. Classify/gate/rerank/find are recorded gaps: topic
  membership is not a policy violation, so scoring topics as violations
  would fake verdicts. NOTE: `exception_override` must be explicit `null`
  (omitting the key defaults to `""`, which the helper 400s: "Exception
  override is empty; pass None to leave the line out" -- observed live).
  Xet fallback: `hf_xet` not installed, downloads fell back to regular HTTP
  (slower, worked).
- gliclass-stock: `gliclass` 0.1.20 `GLiClassModel.from_pretrained` +
  `AutoTokenizer` + `ZeroShotClassificationPipeline(multi-label, cpu)` --
  the identical backend as ronda1 `gliclass_server.py`, STOCK weights.
  Works under transformers 5.19.0 (the `GLiClass` model_type warning is
  handled inside the package).
- laya baseline: unmodified `py/laya_server.py` :8765 (pre-existing
  process; G3 setup never touched it).

### Pins (`py/.venv-r3g3`, `pip check`: No broken requirements found)

```
torch==2.14.1+cpu  transformers==5.19.0  onnxruntime==1.31.0  tokenizers==0.23.3
numpy==2.4.6  safetensors==0.8.0  huggingface_hub==2.2.0  gliclass==0.1.20
```

### Pins (`py/.venv-r3g3-policylm`, `pip check`: No broken requirements found)

```
torch==2.14.1+cpu  transformers==4.57.6 (card pin)  huggingface_hub==0.36.2
safetensors  tokenizers==0.22.2  numpy==2.4.6
```

Disk: venvs 1.2G + 884M; weights above; 143G free at end, no pressure.
Setup < 1h per model (no BLOCKED).

## S2 — smoke (harness 19/19 green + verbatim curl probes)

Harness: `node evals/smoke-r3g3-lanes.mjs` 19/19 (exit 0): 5 lanes x 2
choice backends (1 r1 EN-normal case each) + policylm screen x 5 (EN/ES
normal, EN/ES adversarial, EN ambiguous) + modernbert probe x 4
(live+ready+/probe shape+/predict 409).

| Model | EN scores (refund/cancel/other) | EN latency | ES scores (refund/cancel/other) | Warm latency | Verdict |
|---|---|---|---|---|---|
| minilm :8779 | 0.796 / 0.353 / 0.126 flagged=[refund] | 37.5s (cold: download+load+3 NLI passes) | 0.471 / 0.368 / 0.166 flagged=[] (top but < 0.5) | ~21ms | READY -- EN sharp, ES soft (same soft-ES pattern as zesyde) |
| gliclass-stock :8782 | 0.980 / 0.018 / 0.017 flagged=[refund] | 32.1s (cold) | 0.727 / 0.147 / 0.028 flagged=[refund] | ~520ms | READY -- sharp both langs |
| policylm :8771 (explicit injection category) | benign 0.007 not flagged | ~2.5min (cold: 9-file HTTP download, xet missing) | attack EN 0.985 flagged / benign ES -- (matrix) | ~0.7-1.1s | READY -- discriminates; FAR faster than ronda1's 19-25s/msg (short texts, newer torch; recorded frankly) |
| modernbert :8781 | GET /probe: `Paris` top, logits [1,9,50368], 83ms forward (cold 27.8s download+load) | -- | n/a (no text axis) | /predict 409 `no_zero_shot` | READY as probe -- load+run proven, zero-shot honestly refused |
| laya :8765 (baseline) | (matrix) | n/a (preloaded) | (matrix) | ~700ms | READY |

No ECE / reliability claim for any model (needs matrix + diagrams).

## S3 — matrix (R3T4 done 2026-10-12: choice r1 60 + v2 80, policylm screen r1 12 + v2 32, modernbert probe evidence, laya baseline in every table)

Runner: `evals/smoke-r3g3-lanes.mjs` (smoke default/`--live`; matrix via
`--matrix [--out <dir>] [--model <m>]`; laya rerank/find need
`LAYA_BENCH_RERANK_URL/_FIND_URL=:8765`, the G1 pin).
Lanes: `G3ChoiceClient` (in-file subclass of `GliclassClient`, G1 L1/L2
methodology verbatim: classify item-text vs keys; gate one POST per claim;
screen vs [benign, suspicious, malicious]; rerank/find query-as-text;
taus OFF; dedup guard; omission routing) for minilm + gliclass-stock;
`PolicylmClient` (lanes-r1, screen-shaped only) for policylm; laya via
`LayaClient`. ModernBERT has no lanes (probe.json only).
Manifests: `evals/results/v23-g3-matrix/{minilm,gliclass-stock,policylm,modernbert-probe,laya-baseline}/`
(same oracles + `scoreIndependentDecision` + 60s CPU budget; rows carry
raw scores + margins + reliability INPUTS; no ECE/Brier claimed).

| backend | lane | r1 dec/task | v2 dec/task | EN/ES task | p50/p95 wall | abst | wc@0.70 |
|---|---|---|---|---|---|---|---|
| minilm | classify | 12/12 + 4/12 | 26/26 + 2/26 | 4/19 + 2/19 | 28/35ms | 0 | 0.000 |
| minilm | gate | 7/12 + 4/12 | 6/22 + 1/22 | 3/17 + 2/17 | 30/55ms | 0 | 0.656 |
| minilm | screen | 4/12 + 4/12 | 14/32 + 0/32 | 2/22 + 2/22 | 30/33ms | 0 | 0.000 |
| minilm | rerank | 12/12 + 6/12 | -- | 3/6 + 3/6 | 22/23ms | 0 | n/a |
| minilm | find | 6/12 + 10/12 | -- | 5/6 + 5/6 | 22/24ms | 11 | 1.000 |
| gliclass-stock | classify | 12/12 + 10/12 | 26/26 + 15/26 | 12/19 + 13/19 | 466/528ms | 0 | 0.079 |
| gliclass-stock | gate | 5/12 + 5/12 | 13/22 + 0/22 | 3/17 + 2/17 | 524/953ms | 0 | 0.306 |
| gliclass-stock | screen | 7/12 + 6/12 | 5/32 + 0/32 | 3/22 + 3/22 | 539/619ms | 0 | 0.045 |
| gliclass-stock | rerank | 12/12 + 9/12 | -- | 4/6 + 5/6 | 571/677ms | 0 | n/a |
| gliclass-stock | find | 5/12 + 10/12 | -- | 5/6 + 5/6 | 562/658ms | 12 | n/a |
| policylm | screen | 0/12 + 2/12 | 0/32 + 0/32 | (matrix) | 770/873ms | 44 | n/a |
| laya-base | classify | 3/12 + 8/12 | 0/26 + 5/26 | 3/19 + 10/19 | 348/399ms | 0 | 0.526 |
| laya-base | gate | 6/12 + 0/12 | 22/22 + 0/22 | 0/17 + 0/17 | 1033/1151ms | 0 | 0.917 |
| laya-base | screen | 0/12 + 2/12 | 0/32 + 0/32 | 1/22 + 1/22 | 687/796ms | 0 | 0.364 |
| laya-base | rerank | 1/12 + 6/12 | -- | 4/6 + 2/6 | 216/646ms | 0 | n/a |
| laya-base | find | 5/12 + 9/12 | -- | 5/6 + 4/6 | 320/431ms | 2 | 0.400 |

Composed r1_60 (dec + task): minilm 41 + 28, gliclass-stock 41 + 40,
laya-baseline 15 + 25 (byte-identical to the G1 laya run -- harness
reproducibility), champion r3i 56 + 56.
Combined _140: minilm 87 + 31, gliclass-stock 85 + 55, laya 37 + 30.
Composed screen_44: policylm 0 + 2, laya 0 + 2, champion r3i screen 10 + 10.
Signal notes: minilm classify decisions perfect (38/38) but tasks weak
(6/38) -- argmax lands the right ALLOW/ESCALATE while picking the wrong
label; gate wc@0.7-0.9 0.656 (confidently wrong, thx-class problem);
find abstains 11/12 (weak-winner omit path). Gliclass-stock has the best
zero-shot TASK of any backend measured so far (r1 40/60, combined 55/140)
but gate v2 task 0/22 and screen v2 task 0/32 (filler-task structural wall
shared with every choice backend). Policylm abstains 44/44: the injection
leg alone cannot carry decisions without substance/relevance legs, so the
honest subset measures 0 + 2 -- the gap is the finding, not a bug.
ModernBERT: probe.json (200 `Paris` + 409 `no_zero_shot`), no lanes.
Coverage gaps (recorded, never run): policylm classify/gate/rerank/find
(topic-is-not-violation); modernbert all 5 lanes (no head).

## S4 — verdict (G3 only, strictly-no-worse vs r3i 56/60 + 56/60 on the r1 slice; screen 10/12 for the policylm subset)

Promotion criterion (G3): ADOPT requires r1 dec >= 56/60 AND task >= 56/60
(both, no trade) + fits local/$0/CPU; TIE requires a within-noise gap plus
a finetune-ceiling argument (R3T5); else DISCARD. Gaps here are 15-16 pts
-- not noise, so no tie is claimed.

- MiniLM-NLI: DISCARD as judge (r1 41/60 dec, 28/60 task). Keeps: fastest
  lane measured (~22-35ms warm, 4-25x faster than G1), perfect classify
  decisions, full 5-primitive coverage at 80M. Kills: weakest tasks of G3
  (classify task 6/38, screen v2 task 0/32), confident gate errors.
- ModernBERT-base: NOT A JUDGE (probe only, by construction). Keeps: loads
  + runs (83ms MLM forward, correct mask-fill), Apache-2.0, 8k ctx.
  Recorded gap, never scored -- the finetune-backbone question belongs to
  R3T5, not to this matrix.
- PolicyLM-1.7b: DISCARD as judge (screen r1 0/12 + 2/12 -- the honest
  subset cannot decide without the missing legs). Keeps: sharp injection
  discrimination when asked directly (0.985 attack / 0.007 benign),
  ~0.8s/msg CPU (far below ronda1's 19-25s). Kills: 44/44 abstention under
  our screen handler; 1.7B weight cost (3.3G) for a screen-only subset.
- GLiClass-stock (288M): DISCARD as judge (r1 41/60 dec, 40/60 task -- 15
  pts short on decisions). Keeps: best zero-shot TASK of all backends
  measured (r1 40/60, combined 55/140; classify task 25/38), ES parity,
  clean wc (0.000 @0.9+ on classify/screen). Kills: decisions still 15 pts
  from r3i; gate/screen v2 tasks 0. THIS is the reference point that makes
  the r3i finetune's value visible: stock 41+40 -> r3i 56+56 (+15/+16 from
  the same-dose SFT lineage). No thresholds moved, no training, no gold
  signed, no manifests overwritten (new `v23-g3-matrix/` only).

## R3T5 INPUT — finetune-ability per backbone (research, read-only; no training)

Probe-cost reference: 699-row mix recipe, LR 2e-5 x 2 epochs (r3a-r3i
lineage dose). Costs below are estimates for THAT dose unless noted.

| Backbone | Params / arch | Transformers Trainer? | LoRA (peft)? | ONNX export? | VRAM (dose) | License | ES data path | Note |
|---|---|---|---|---|---|---|---|---|
| MiniLM-NLI (MoritzLaurer multilingual-MiniLMv2-L6) | ~80M, XLM-R-based NLI head | Yes (AutoModelForSequenceClassification) | Yes (q/k/v targets) | Yes (optimum, XLM-R supported) | CPU-finetunable; GPU trivial (< 4GB LoRA) | MIT | XNLI ES split (valid/test) + own ES pairs for train; MNLI train is EN-only | Cheapest full-finetune; NLI head already judges -- best probe if the judge stays NLI-shaped |
| ModernBERT-base | 149M, ModernBERT MLM, EN+code, 8k | Yes (ModernBertForSequenceClassification) | Yes | Yes (optimum; G2 horizon lineage is ModernBERT-family) | CPU-possible; GPU easy (< 6GB full) | Apache-2.0 | Pretrain EN+code ONLY: ES needs real ES finetune data, weaker cross-lingual prior than XLM-R/mDeBERTa | Best suspenders: 8k ctx + modern arch, but zero ES prior -- finetune or nothing |
| mDeBERTa (G2, edithngalame EN-ES injection) | 278M, DeBERTaV3 fp32 | Yes | Yes | fp32 YES (repo ships onnx/); INT8 BROKEN upstream (never load model_int8.onnx) | ~1.1G weights, CPU OK; GPU easy | MIT | ES injection data exists (its own finetune); general-ES needs own pairs | Ships a working fp32 ONNX -- shortest path to a local gate/screen head |
| Laya-multilingual | mmBERT, transformers lib | Yes -- R3i IS the finetune (same-dose SFT lineage v5-v10 + r3a-r3i) | Per laya package (r3i lineage used full SFT, not LoRA) | Via laya package | Known: 12G+2.5G+0.8G cache, 3-checkpoint preload ~90s | Apache-2.0 | Multilingual incl. ES (its own pretrain + our 699-row mix) | Ceiling evidence: same-dose SFT exhausted at 56+56 -- further gains need new data/axes, not more epochs |
| GLiClass (knowledgator multilang-mini) | 288M, GLiClass | Via `gliclass` package `training` module (present in 0.1.20, installed) -- verify API before use | Unverified (package-specific) | Package-served (r3i lineage pattern) | Known: ~0.5s/case CPU infer | Apache-2.0 | Multilingual incl. ES (its pretrain + our mix) | Proven lineage: stock 41+40 -> r3i 56+56 on the same dose -- the only backbone with a measured finetune delta in OUR harness |

R3T5 read: the only backbone with a measured zero-shot->finetuned delta
under our harness is GLiClass (stock 41+40 vs r3i 56+56). MiniLM is the
cheapest NLI-shaped probe; ModernBERT the best architecture with zero ES
prior; mDeBERTa the shortest ONNX path; Laya the exhausted incumbent.
Parent R3T6 picks the finetune horse; a finetune run needs separate
approval (R3T7).
