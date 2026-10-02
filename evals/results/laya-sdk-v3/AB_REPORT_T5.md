# A/B re-run T5: laya 0.3.21 vs 0.3.23 + `usage` fix (commit `1d9168a`) — SERVED PATH CLEAN

Supplement to `AB_REPORT.md` (T3, PARTIAL). T3 report untouched; this file only adds the T5 re-run.

**Verdict: STAY on `laya==0.3.23`. The fix holds: arm B serves 200 on all non-empty
`/predict`, `usage` carries the 4 new keys, and served behavior is identical to arm A
(0 flips, 0 confidence deltas). No remaining gaps from the T3 blocker.**

## 1. Setup

| | Arm A (reference, stored T3 raws) | Arm B-fixed (re-run live) |
|---|---|---|
| laya | 0.3.21 (not re-run; see method) | 0.3.23 |
| venv | `%TEMP%\opencode\laya-t3a-0321` (T3 reuse, 3.11.9) | `%TEMP%\opencode\laya-t3b-0323` (T3 reuse, 3.11.9) |
| server | repo `py/laya_server.py` @ `1d9168a` (stock + fix), `LAYA_DEVICE=cpu`, port 8781 | same file, `LAYA_DEVICE=cpu`, port 8782 |
| checkpoints | english + multilingual + typed-decisions, shared default HF cache | same |

Venvs were reused (pins unchanged since T3), so no `pip check` re-run per protocol.
`/health` 200 on both arms; `/ready` shows `ready:true`, 3/3 loaded, `device:cpu`,
correct `laya_sdk` per arm. First `/health` call per arm was slow (>10 s, passed at
90 s timeout); subsequent calls fast — noted, not investigated (liveness probe
`/live`+`/ready` unaffected).

## 2. Method (T3 reuse, stated deviations)

Same 80 gold cases + same 14 extras as T3 (pairs/payloads from `pairs.json`,
`pairs-extra.json`, `extras.json` in `laya-t3ab`), real `dist/` handlers + live
`LayaClient`, 1 pass, singular `predict` only. Probe `ab-t3.mjs` reused verbatim
from `%TEMP%\opencode\laya-t3ab`. Only new work in `%TEMP%` (`laya-t5/`); repo
writes are evidence only (this file + 2 raw jsons + `MANIFEST_T5.json`), uncommitted.

Arm A was NOT re-run (cheap-path option per task brief): B-fixed is compared against
the stored T3 arm-A raws (`run-sdk-0.3.21.json`, `run-extra-0.3.21.json`, sha256 in
T3 `MANIFEST.json`). Justification: the fix is backcompat-verified for the 0.3.21
`usage` shape (T4 payload check), and a same-day live smoke on arm A (`/predict`
noul 200, 2-key `usage`, byte-identical answer to B-fixed noul smoke) confirms the
fixed server still serves 0.3.21. Harness fidelity is re-proven by byte-compare below.

## 3. Base-80 results: B-fixed vs A

- Gold pass: **A 35/80 vs B-fixed 35/80, per-suite identical**
  (classify 1, compare 2, decide 2, extract 5, find 4, gate 1, rerank 6, review 3,
  screen 5, verify 6). **Case-level pass flips: 0.**
  (The 45 non-passes are pre-existing gold-vs-handler disagreements, identical on
  both arms — comparative pass, not a quality bar; same reading as T3 §3.)
- HTTP failures on B-fixed: **0** (T3 B: 68x HTTP 500). Predict calls 72/72 both arms.
- Question byte-compare A-vs-B-fixed: **72/72 identical, 0 mismatches**
  (same-harness fidelity; no `pairs.json` re-capture needed).
- Answers: **72/72 byte-identical, 0 choice flips.**
- Confidence: **158 values compared, 0 nonzero deltas.**
- Routing: **0 mismatches** (72/72 english both, same reasons as T3).
- `usage` on B-fixed: 70/72 calls carry all 6 keys
  (`input_tokens`, `output_tokens` + the 4 new `state_tokens`,
  `state_tokens_dropped`, `truncated`, `truncated_questions`).
  The 2 calls with the old 2-key shape are the empty-question silence cases
  (`verify/verify-abstention-02`, `rerank/rerank-abstention-01`, questions `{}`) —
  expected per T3 §3 (no truncation accounting when there is nothing to truncate),
  not a gap.

## 4. Extra ES/mixed set (14 cases)

Served: **A 14/14 vs B-fixed 14/14, 0 errors.**
Per-case A→B-fixed: routing **14/14 identical** (11 multilingual / 3 english),
answers **14/14 same**, confidence **14 values, 0 nonzero deltas**.
(The v2 ES/PT fixes #207/#350/#406 hold on the served path under 0.3.23 + fix.)

## 5. Verdict: STAY on 0.3.23 — no remaining gaps

The T3 blocker is closed: `PredictResponse.usage: Dict[str, Any]` + `_coerce_usage`
serves the 0.3.23 shape (6 keys incl. `truncated_questions: []`) and still serves
the 0.3.21 shape (2 keys, live-smoked). Served model behavior 0.3.21→0.3.23 remains
a wash (identical answers/routing/confidence), so there is no model-quality cost
to staying; the serving outage is gone. `py/requirements.txt` pin untouched
(still `laya==0.3.23,<0.4.0` from T2).

Known non-gaps carried over from T3 (unchanged, not re-probed): no GPU spot (no GPU
on box), no latency comparison (excluded by protocol), `bytes`-valued dict fields
unexercised, first-`/health` slowness noted above.
