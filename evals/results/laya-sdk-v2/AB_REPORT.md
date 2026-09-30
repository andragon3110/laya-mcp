# A/B report: laya 0.3.12 vs 0.3.21 (ODD T2, measurement only)

No pin was changed. `py/requirements.txt` still pins `laya==0.3.12,<0.4.0`.

## 1. Setup

| | Arm A (baseline) | Arm B (candidate) |
|---|---|---|
| laya | 0.3.12 | 0.3.21 (latest on PyPI at measurement time) |
| venv | `%TEMP%\laya-t1-base` (reused from T1) | `%TEMP%\laya-t2-0321` (fresh) |
| Python | 3.11.9 | 3.11.9 |
| torch / transformers | 2.14.0+cpu / 4.57.6 | 2.14.0+cpu / 4.57.6 |
| fastapi / uvicorn / pydantic / huggingface_hub / numpy / psutil | 0.141.1 / 0.53.0 / 2.13.5 / 0.36.2 / 2.4.6 / 7.2.2 | identical |
| `pip check` | clean | clean |
| server | stock `py/laya_server.py`, `LAYA_DEVICE=cpu`, port 8775 | same file, `LAYA_DEVICE=cpu`, port 8776 |
| checkpoints | english + multilingual + typed-decisions from the shared HF cache (same weights both arms) | same |

Arm B was installed from a `%TEMP%` copy of `py/requirements.txt` with only the
laya line changed (`laya==0.3.21,<0.4.0`); the repo file was not touched.
Base dependency requirements of the two wheels are identical
(`torch>=2.0`, `transformers>=4.48`, `safetensors`, `huggingface_hub>=0.20`,
`numpy`); 0.3.21 only adds new *extras* (`structured`, `onnxscript`,
`llamaindex`, `crewai`), none installed here.

## 2. Method (fresco T4 protocol, reused)

Same 80 gold cases (10 suites x 8, `pii` excluded, no gliner sidecar) through the
real `dist/` handlers with a live `LayaClient`, 1 pass, singular `predict` only
(never `predict_batch` / `FastLaya` / ONNX). The T4 probe script (`ab.mjs`) no
longer exists (it lived in `%TEMP%`), so an equivalent probe was written, also
in `%TEMP%` (repo untouched). Harness fidelity is proven, not assumed:

- Arm-A captured **questions are byte-identical to the T4 stored run**
  (`odd/spike-laya-fresco:evals/results/laya-sdk-v1/run-sdk-0.3.12.json`) on
  **80/80 cases**.
- Arm-A gold pass **36/80** with the exact per-primitive split from T4
  (classify 1, compare 2, decide 2, extract 5, find 4, gate 2, rerank 6,
  review 3, screen 5, verify 6) and routing **72/72 english (39/33 reasons)**,
  reproducing T4 exactly — on CPU where T4 used GPU.

## 3. Base-80 results

- **Questions 72/72, answers 72/72, confidence 72/72, usage 72/72 byte-identical.**
- **Routing decisions identical**: 72/72 `english` on both arms, same reasons
  (39x `English Latin text`, 33x `Latin script ... using default (english)`).
- The **only** byte delta in 70/80 rows is one added key in the detection
  payload on arm B: `"mixed_segment": null`. (The 10 fully identical rows are
  exactly the 10 zero-call limit-guard cases.) `mixed_segment` is the
  transparency key PR #207 adds on every detection branch.
- **Gold pass identical**: 36/80 both arms, per-primitive diffs all 0
  (comparative only — golds are oracle-stub based, not a quality bar).
- **Confidence deltas: 143 values compared, 0 nonzero.** The temperature-clamp
  caveat is unchanged: both arms emit the identical `RuntimeWarning`
  (`... using choice:11+=0.10058280825614929 -> 0.5 ...`, bounds `[0.5, 5]`;
  call site `laya/router.py:260` on 0.3.12 vs `:456` on 0.3.21 — same Agent
  code, line moved by file growth). Confidence from the affected entries stays
  uncalibrated on both arms.

## 4. Extra ES/mixed set (14 cases, direct singular `/predict`, no golds)

Designed from the three upstream PRs (all merged after 0.3.20, all in 0.3.21):

| case | topic | A (0.3.12) | B (0.3.21) | note |
|---|---|---|---|---|
| x207a PT ticket + EN traceback | #207 | english | **multilingual** (`mixed_segment` = PT line) | fix works; same answer choice, conf 0.45 -> 0.94 |
| x207b PT field + EN payload (dict) | #207 | english | **multilingual** | fix works; conf 0.84 -> 1.00 |
| x207c EN template + PT body (dict) | #207 | english | **multilingual** | fix works; conf 0.95 -> 1.00 |
| x207d ES ticket + EN traceback | #207 (ES) | english | **multilingual** (`'es'` segment) | fix works in Spanish too; conf 0.69 -> 0.94 |
| x207e EN ticket + PT error | #207 rev | multilingual | multilingual | already correct on A |
| x207f all-caps PT line | #207 | multilingual | multilingual | already correct on A |
| x350a café/résumé | #350 | multilingual | multilingual | **by design**: two accented words exceed the rescue bar (at most one) |
| x350b José/Zürich | #350 | multilingual | multilingual | same as above |
| x350c German control | #350 | multilingual | multilingual | control holds |
| x350d plain English control | #350 | english | english | control holds |
| x350e café, boundary rate | #350 | multilingual | **english** | rescue works (rate 0.0204, one accented word) |
| x350f María, boundary rate | #350 | multilingual | **english** | rescue works (rate 0.027, one accented word) |
| x406a long EN note + short DE msg (dict) | #406 | english | **multilingual** (`mixed_segment` = DE field) | fix works; conf 0.36 -> 0.53 |
| x406b ES body + EN meta (dict) | #406 | multilingual | multilingual | already correct on A |

7/14 change routing, all toward the checkpoint that can read the text. Where the
answer choice is language-robust (x207a-d, x406a), arm B keeps the choice with
higher confidence; where the checkpoint change flips a close call (x350e/f),
answers move as expected with a checkpoint change — no golds exist here, so this
is reported descriptively, not scored.

## 5. What changed in the SDK (wheel diff 0.3.12 -> 0.3.21, verified locally)

Unlike the 0.3.12-vs-0.3.20 A/B (router.py identical), 0.3.21 touches the served
path. 21 shared files differ, 8 new files (none served: `_compile`,
`confidence`, `evals`, integrations for crewai/llamaindex, `revisions`).

Served-path behavior entries from the
[v0.3.21 changelog](https://github.com/NandhaKishorM/laya/releases/tag/v0.3.21)
(canonical repo `NandhaKishorM/laya`, releases 0.3.12 `2026-09-24T03:25:42Z`,
0.3.20 `2026-09-24T05:41:02Z`, 0.3.21 `2026-09-27T19:41:23Z`):

- Routing (`route`/`analyse`): #207 (mixed-segment scan),
  #350 (loanword rescue, fixes #337), #406 (per-value dict detection, fixes
  #384), #368 (language-agnostic LANG codes fall through to detection).
- Answer validation: #380 (choiceless label type), #342 (null score level),
  #425 (nested choice label), #496 (option/answer-key coverage), #508 (null
  choice label), #609 (question validation, None-state reject).
- Load: #502 (short temperature list fails at load), #462 (tokenizer
  encoding, no overwritten-weight init). `predict_long` (#497) and
  `min_confidence` (#456) are new opt-in APIs, off by default — not our path.
- Perf-only on our path: #383, #287, #531, #405 (shortlist cache), #615.

`predict = system_one` alias retained; no served forward function removed.

## 6. Recommendation: MOVE the pin to `laya==0.3.21`

Why: zero regression on the base workload (identical answers/confidence/routing
decisions/gold pass), plus measured fixes for exactly our traffic shape —
Spanish/Portuguese customer text mixed with English logs/templates routes to
the checkpoint that reads it (0.97 confidence at 0.47 accuracy on `pt` per the
upstream PR is the failure being fixed), and boundary loanword English stops
being misrouted. The only base-set payload change is an additive,
documented `mixed_segment: null` key.

Re-test still missing before/after the bump (T2 does not bump):

1. `py/doctor.py --no-live` + live smoke on a clean-room 0.3.21 venv
   (install order per `install.sh`, including the gliner combined venv
   converging on `huggingface_hub==0.36.2`).
2. `npm run typecheck` if Node is touched (not expected for a pin comment).
3. GPU parity spot check (this A/B ran CPU-only; weights are identical and the
   forward is deterministic, but one live `predict` on CUDA closes the gap).
4. Downstream consumers of the `routing.detection` payload, if any code
   asserts exact keys (new `mixed_segment` key) — `grep` for `detection` in
   `src/`/`py/` showed no such assertion at T2 time, but re-check at bump time.

## 7. Verified vs assumed vs gaps

- Verified: wheel contents of both versions; PyPI availability (0.3.21 present,
  0.3.7/0.3.8 absent — `pip index versions laya`); upstream PR bodies and merge
  dates for #207/#350/#406; release timestamps; every number in sections 2-4
  from live runs in this directory (sha256 in MANIFEST.json).
- Assumed (stated, not proven): same-HF-cache weights across arms (cache dir
  shared, no revision pins — matches production behavior); CPU results transfer
  to GPU (same code path, deterministic forward; flagged as re-test #3).
- Gaps: `bytes`-valued dict fields (#406 sub-case) cannot travel over our JSON
  `/predict` and were not exercised live; multi-accented-word English
  (x350a/b) stays multilingual on both arms — intended per the upstream rule,
  but worth knowing for ticket traffic with several names; no latency
  comparison was made (excluded by protocol; CPU inference ran 90-430ms/call).
