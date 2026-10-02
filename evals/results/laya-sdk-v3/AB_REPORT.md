# A/B report: laya 0.3.21 vs 0.3.23 (T3, measurement only — PARTIAL, blocker found)

No pin was changed. `py/requirements.txt` still pins `laya==0.3.23,<0.4.0`
(the T2 bump under test); this report measures that bump against 0.3.21.

**Verdict: REVERT to `laya==0.3.21` until `py/laya_server.py` accepts the
0.3.23 `usage` shape. Arm B fails every model `/predict` with HTTP 500
(served gold 12/80 vs 35/80; extras 0/14). The SDK itself is innocent:
direct-Router outputs are 72/72 byte-identical with 0 confidence deltas.**

## 1. Setup

| | Arm A (baseline) | Arm B (candidate) |
|---|---|---|
| laya | 0.3.21 | 0.3.23 |
| venv | `%TEMP%\opencode\laya-t3a-0321` (fresh) | `%TEMP%\opencode\laya-t3b-0323` (fresh) |
| Python | 3.11.9 | 3.11.9 |
| torch / transformers | 2.14.1+cpu / 4.57.6 | identical |
| fastapi / uvicorn / pydantic / huggingface_hub / psutil / numpy | 0.141.1 / 0.53.0 / 2.13.5 / 0.36.2 / 7.2.2 / 2.4.6 | identical |
| `pip check` | clean | clean |
| server | stock `py/laya_server.py`, `LAYA_DEVICE=cpu`, port 8775 | same file, `LAYA_DEVICE=cpu`, port 8776 |
| checkpoints | english + multilingual + typed-decisions from the shared HF cache | same |

Arm A was installed from a `%TEMP%` copy of `py/requirements.txt` with only the
laya line set back to `laya==0.3.21,<0.4.0`; arm B from a verbatim copy of the
repo file. No `0.3.23` extras installed. CPU-only (no GPU on this box;
`torch.cuda.is_available()` False both arms).

## 2. Method (fresco protocol, v2 AB_REPORT sections 2-4 reused)

Same 80 gold cases (10 suites x 8, `pii` excluded, no gliner sidecar) through the
real `dist/` handlers with a live `LayaClient`, 1 pass, singular `predict` only.
The v2 probe (`ab.mjs`) no longer exists in `%TEMP%`, so an equivalent probe
(`ab-t3.mjs`) was written, also in `%TEMP%` (repo untouched except evidence).
The T4 stored run (`odd/spike-laya-fresco:...run-sdk-0.3.12.json`) does not exist
(no such dir, no `laya-sdk-v1` dir) — recorded as gap; v2 crudos are the reference.

Harness fidelity is proven, not assumed:

- The 72 predict-call `(state, questions)` pairs were captured by replaying arm-A
  answers through the handlers: captured questions are byte-identical to the live
  arm-A raws on **72/72 pairs, 0 mismatches**. Pairs are SDK-independent
  (handlers build them without the model), so the direct-Router comparison below
  runs on byte-identical inputs by construction.
- Served arm-A questions are byte-identical to the v2 `run-sdk-0.3.21.json` raws on
  **67/80 cases**. The 13 diffs are all handler evolution since v2 (verify x6 +
  gate x7: `refute_0` dual probe + reworded criteria from post-v2 merges), not the
  SDK — proven by `git diff 965354a HEAD` on `src/tools/{verify,gate}.ts` and
  `evals/suites/{verify,gate}.mjs`.
- Served arm-A reproduces the v2 shape exactly: routing **72/72 english (39/33
  reasons)**, same as T4/v2.

## 3. Base-80 results

**Served path (stock server): arm B is broken.**

- Arm A: **35/80** gold pass (classify 1, compare 2, decide 2, extract 5, find 4,
  gate 1, rerank 6, review 3, screen 5, verify 6), 72 predict calls.
  (v2 arm scored 36/80; the 1-case delta is `gate-negative-02` flipping under the
  evolved gate handler/gold, not the SDK: same-version answers are 59/59
  byte-identical on same-question raws, confidence 107/107 delta 0.)
- Arm B: **12/80**. 68/68 model calls fail with
  `laya-server /predict returned HTTP 500`. The 12 passes are the 10 zero-call
  limit-guards plus the only 2 calls that succeed (empty-question silence cases).
- **Root cause** (server traceback + local wheel diff, both verified): 0.3.23
  `agent.py` always emits 4 new `usage` keys
  (`state_tokens`, `state_tokens_dropped`, `truncated`, `truncated_questions`;
  empty list when nothing truncated). Our `PredictResponse.usage: Dict[str, int]`
  (`py/laya_server.py:652`) rejects the list:
  `usage.truncated_questions: Input should be a valid integer, input_value=[]`.
  The 2 succeeding calls are exactly the 2 pairs whose `usage` keeps the old
  2-key shape (empty questions → no truncation accounting). `/health` still 200.

**Model level (direct `Router.predict` on the identical 72 pairs, supplementary —
NOT the served path): 0.3.21 and 0.3.23 are indistinguishable.**

- **Questions 72/72, answers 72/72 byte-identical. 0 choice flips.**
- **Confidence: 158 values compared, 0 nonzero.**
- **Routing identical**: 72/72 `english`, same reasons (39x / 33x) both arms.
- **Usage**: identical on 2/72; the other 70 differ ONLY by the 4 added keys on B.
  No answer key added or removed (incl. `answer_confidence` on both).
- Temperature-clamp caveat unchanged: both arms emit the identical
  `RuntimeWarning` (`choice:11+ ... -> 0.5`, bounds `[0.5, 5]`; call site
  `laya/router.py:456` on 0.3.21 vs `:594` on 0.3.23 — same Agent code, line moved
  by file growth).

## 4. Extra ES/mixed set (14 cases, singular `/predict`, no golds)

Same 14 states/questions as v2 (extracted verbatim from `run-extra-0.3.21.json`).

Served: arm A 14/14 ok (11 multilingual / 3 english); arm B **0/14, all HTTP 500**.

Direct-Router (supplementary): routing **14/14 identical A→B**
(11 multilingual / 3 english — the v2 #207/#350/#406 fixes all hold on both arms),
confidence **0/14 nonzero**, answer choice **14/14 same**, answer keys identical.
Per-case (A→B, direct): x207a-d multilingual, conf unchanged (0.9645 / 0.6685 /
1.0 / 0.967); x207e-f multilingual unchanged; x350a/b multilingual unchanged
(by design: two accented words); x350c multilingual (de control); x350d english
control; x406a multilingual (DE `mixed_segment`); x406b multilingual;
x350e/f english (loanword rescue holds).

## 5. What changed in the SDK (0.3.21 → 0.3.23, verified locally + upstream)

Wheel diff (installed trees): no file removed, 8 new files (none served:
`_eval_policy`, `calibrate`, `evals_shortlist`, `integrations/_controls` docs
and tests), ~30 shared files grown (`agent.py` 79k→107k, `serve.py` 26k→54k,
`router.py` 64k→73k, `common.py`, `confidence.py`, `mcp/*`).

Served-path behavior entries (releases `v0.3.22` 2026-09-29, `v0.3.23` 2026-10-01,
repo `NandhaKishorM/laya`), local-verified where stated:

- **Usage shape** (locally verified, THE blocker): per-call token budgets /
  truncation reporting — `state_tokens`, `state_tokens_dropped`, `truncated`,
  `truncated_questions` always emitted (`agent.py`); `usage` may also carry an
  `options` dict per collapsed question (docstring; not observed here).
- Confidence: abstention-gate state on every answer (#679; `confidence.py`
  +18 `min_confidence` mentions), `answer_confidence` on `DecisionResult` (#685,
  already present in 0.3.21 — no delta here), thresholds gated on
  `answer_confidence` never entropy (#734, integrations/mcp side).
- Routing/detection: Swedish via MASSIVE eval (#728), EN/PT/ES-style French mail
  cleaning (#736), repeated-English-word routing collision fix (#460),
  per-checkpoint pin no longer silently disables the cache (#690).
- `predict_long` fixes: skip-part-of-document (#689), usage merge across windows
  (#653), start-hook question preservation (#692).
- `confidence_threshold` now applies to `answer_confidence` (task-doc note; no
  such literal in either wheel — integrations/mcp behavior).
- Health: `/health` field docs + bearer gate (#811; our `/health` consumers
  unaffected — server still 200, verified live on both arms).
- Per-call `lang`/`min_confidence`/budgets forwarded through serve/mcp/cli (#724,
  #763, #774, #778, #795, #797, #798, #800) — opt-in, off by default, not our path.
- ONNX quant default per-tensor (#792), dynamic export dims (#726) — not our path.

## 6. Recommendation: REVERT the pin to `laya==0.3.21`

Why: 0.3.23 breaks **100% of model `/predict` traffic** through our stock server
(68/68 calls HTTP 500, extras 0/14) via the `usage` contract change. The model
itself is a wash (72/72 identical answers, 0 confidence deltas, routing
unchanged, all v2 ES/PT fixes retained) — there is no model-quality reason to
absorb a serving outage. Reverting restores service with zero model-behavior cost.

Fix-forward alternative (NOT done here): widen the contract, e.g.
`usage: Dict[str, Any]` + explicit truncation fields, then re-run this A/B —
the direct-Router evidence predicts a clean pass. Until then, stay on 0.3.21.

T1/T2 lesson: their 0.3.23 validation called `Router` directly (and
`doctor --no-live`), which never touches `PredictResponse` — the HTTP contract
break was invisible to that path. Any future bump must include one live
`/predict` through the stock server.

## 7. Verified vs assumed vs gaps

- Verified: `%TEMP%` fresh venvs (3.11.9), `pip install` both OK, `pip check`
  clean both, imports + exact pins both; stock-server `/health` 200 both;
  `/predict` 200 on A (all types) / 500 on B (all non-empty types, noul + choice
  probed) with server-side pydantic traceback; wheel file lists + key grep
  (`truncated_questions`/`state_tokens` absent 0.3.21, present 0.3.23);
  upstream release notes v0.3.22/v0.3.23; every number above from live runs in
  this directory (sha256 in MANIFEST.json).
- Assumed (stated, not proven): same-HF-cache weights across arms (cache shared,
  no revision pins — matches production); CPU results transfer to GPU (same code
  path; flagged as re-test); torch 2.14.0→2.14.1 as cause of the extras
  same-version drift (weights byte-identical, runs deterministic within this env;
  not bisected — routing was stable 14/14 regardless).
- Gaps: T4 stored run missing (no `odd/spike-laya-fresco`, no `laya-sdk-v1`);
  v2 crudos stale on 13/80 questions (handler evolution, dispositioned);
  `bytes`-valued dict fields still unexercised (JSON transport); no latency
  comparison (excluded by protocol); no GPU spot (no GPU on box).
