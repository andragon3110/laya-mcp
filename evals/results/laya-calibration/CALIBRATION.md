# T1 calibration: ECE on own golds + per-scenario cuts + per-call wiring plan

Branch `odd/laya-calibration` @ T1. Zero prod change (this dir only). TDD off.

## 1. Method and N (own numbers)

- Reused live raws, no new bulk live: `evals/results/doubt-gate-es/pass-{0..5}.json`
  (ES 20 cases x 6 passes) + `anchor-base-1pass.json` (base 80 x 1). Stored calls:
  114 ES + 72 anchor predicts, 0 x HTTP 500, laya 0.3.23, CPU.
- New live in T1 (minimum): 6 `/predict` on port 8795 (venv `laya-t3b-0323` reused):
  3 cases via real `dist/` handlers + 3 direct re-POSTs. `/health` 200, 3/3 ckpts.
- Case confidence = min over per-question `answer_confidence` (max-p; never the
  entropy `confidence`). Label = case gold pass (handler decision vs oracle gold).
  Metric below is **ECE_decision** (case-min vs gold-pass), NOT upstream per-answer
  ECE — numerically incomparable by construction (weakest-link min is pessimistic).
- Bins: `[0,.5),[.5,.6),[.6,.7),[.7,.8),[.8,.9),[.9,1.0]`, pooled passes.
  6-pass repeats are NOT independent (questions 20/20 byte-identical across
  passes) — effective n ~= cases, stated per row. No Jungla CSV found in
  TEMP/repo, so per contract nothing ingested (base 80 + ES 20 only).
- Observations with signal: **182** = 114 ES case-passes (19 cases x 6;
  `vaut-es-09` limit-guard 0 calls excluded) + 68 base (80 minus 12 no-signal:
  10 x limit-guard 0 calls + 2 x empty-question silence, gate sleeps by design).
  Per-question confidences: 464 (noulx2 384, choice 36, scorex3 42).

## 2. Client param audit (0.3.23 supports; what WE send today)

SDK `Router.predict` signature (venv 0.3.23, verified): supports `model`,
`task`, `lang`, `max_len`, `head_max_len`, `min_confidence` per call.

| param | SDK 0.3.23 | our client sends | our server forwards | note |
|---|---|---|---|---|
| `lang` | yes | YES (`src/client.ts:101,249`) | YES (`py/laya_server.py:599,806`) | no caller passes it today |
| `head_max_len` | yes | NO | NO (Pydantic drops unknown extras) | needs both sides |
| `min_confidence` | yes (#361: per-answer `low_confidence` flag + `abstention` state; argmax untouched) | NO | NO | needs both sides; handlers ignore those fields today |
| `temperature` | NO per-call kwarg (verified: absent from signature) | n/a | n/a | checkpoint config only, see §7 |

## 3. Upstream docs (correction to the task brief)

- `finetune/#calibration-is-part-of-the-run`: fits **one temperature per
  QUESTION TYPE** (`choice`/`score`/`noul`), NOT per (type x options). Legacy
  `temperature_by_options` buckets take precedence and must be REMOVED when
  refitting. Fit on a held-out slice (<=400 items/10%, fixed seed), LBFGS on
  log-T clamped [0.1,10]; T=1.0 if slice < 10 items. Scaling never moves argmax.
- `questions-and-answers/`: gate on `answer_confidence` (max-p) **after fitting**;
  never on `confidence` (normalized entropy, different scale); a threshold
  measured at one option count does not transfer (#394: 20-option gate .85 with
  precision .556 < .583 base rate; high-count right/wrong distributions overlap).
- `benchmarks/`: base checkpoints ship OVER-confident (fit before gating), except
  a routing task that was under-confident; `score` weakest primitive; keep
  choice to ~20 options / shortlist above. Limits: negation (#377), `noul`
  label-following, wording/order sensitivity.

## 4. ECE per cell (type x n-options) and per scenario, with n

### 4a. Cells (case question-shape; pooled ES+base)

| cell | n (case-passes) | pass | ECE_decision | >=.90 -> hit | .80-.90 -> hit | <.80 -> hit |
|---|---|---|---|---|---|---|
| noulx2 | 133 | 60/133 = .451 | **0.319** | **0/6 = .000** | 14/26 = .538 | 46/101 = .455 |
| choicex3 | 21 | 3/21 = .143 | 0.577 | 0/4 = .000 | 0/5 = .000 | 3/12 = .250 |
| choicex2 | 8 | 3/8 = .375 | 0.611 | 1/5 = .200 | 1/1 = 1.00 | 1/2 = .500 |
| noulx2+scorex3 | 14 | 2/14 = .143 | 0.304 | n=0 | n=0 | 2/14 = .143 |
| choicex4 | 2 | 1/2 | 0.300 | n=0 | n=0 | 1/2 |
| choicex2+noulx2 | 2 | 0/2 | 0.741 | 0/1 | n=0 | 0/1 |
| choicex1 | 2 | 2/2 | 0.000 | 2/2 (degenerate p=1.0) | — | — |

Pooled >=.90 over real cells: **1/11 = .091** (noulx2 0/6 + choicex3 0/4 + choicex2 1/5).

### 4b. Scenarios (tool; ES pooled x6, base x1)

| scenario | n | pass | ECE | >=.90 | .80-.90 | <.80 |
|---|---|---|---|---|---|---|
| screen-es | 66 | 36/66 = .545 | 0.260 | n=0 | 6/12 = .500 | 30/54 = .556 |
| verify-es | 48 | 12/48 = .250 | 0.592 | 0/6 = .000 | 6/12 = .500 | 6/30 = .200 |
| base screen (noul) | 7 | 4/7 | 0.372 | n=0 | n=0 | 4/7 |
| base verify (noul pairs) | 6 | 4/6 | 0.164 | n=0 | 1/1 | 3/5 |
| base rerank (noul) | 6 | 4/6 | **0.087** | n=0 | 1/1 | 3/5 |
| base extract (choice var) | 7 | 4/7 | 0.165 | 2/2 = 1.00 | n=0 | 2/5 |
| base review (scorex4+noul) | 7 | 2/7 | 0.192 | n=0 | n=0 | 2/7 (all minConf ~.4) |
| base find (choice) | 7 | 3/7 | 0.493 | n=0 | 1/4 = .250 | 2/3 = .667 (INVERTED) |
| base gate (scorex2+noulx3) | 7 | 0/7 | 0.415 | n=0 | n=0 | 0/7 |
| base classify (choicex3) | 7 | 0/7 | 0.740 | 0/1 | 0/1 | 0/5 |
| base compare (choice) | 7 | 1/7 | 0.720 | 0/3 | 0/1 | 1/3 |
| base decide (choicex2[+noul]) | 7 | 1/7 | 0.755 | 1/6 = .167 | n=0 | 0/1 |

### 4c. Per-question confidence distribution by type x options (no labels exist)

Per-question correctness is unmeasurable (gold pass is case-level incl. policy
cuts) — distribution only. Confirms upstream scale effect on OUR traffic:

| qtype x n | n | mean | min-max | frac >= .90 |
|---|---|---|---|---|
| choicex2 | 10 | .861 | .57-.97 | .600 |
| noulx2 | 384 | .804 | .50-1.00 | .315 |
| choicex3 | 24 | .710 | .37-.99 | .167 |
| choicex4 | 2 | .542 | .34-.74 | .000 |
| scorex3 | 42 | .518 | .36-.79 | .000 |

Scale spreads .52-.86 by shape: one cut on a mixed-shape case-min is dominated
by the lowest-scale question in the case (review/gate minConf .3-.4 always).

## 5. Disposition: signal vs overlap

**No separable cells.** Every cell with n >= 8 has overlapping bands
(noulx2 .538 vs .455; choicex3 flat-zero above .70; ES screen inverted
.500 vs .556). High band is anti-signal (1/11 pooled). Apparent structure
(extract 2/2, rerank ECE .087, verify-base .164) rests on n <= 7 single-pass.
classify/gate 0% pass = handler-vs-oracle disagreement, not calibration signal.
find bands invert. classify/compare/decide ECE .61-.76 = #394 pattern live
(confident misses: decide 6/7 cases >=.90 with 1/6 pass).
Consequence: NO data-driven cut exists anywhere at usable n — same posture as
doubt-gate-es T3 (conservative tripwire + flags), now extended per scenario.

## 6. Proposed per-scenario cuts (all 0.90-UNCALIBRATED; T2 wires the table, not new numbers)

Uniform 0.90 because nothing separates; per-scenario rows carry n,
justification, and the flag T2 must ship alongside. Effective-n ~= cases.

| scenario | cut | n | justification |
|---|---|---|---|
| screen / screen-es | 0.90 UNCALIBRATED | 7 + 66 | bands overlap/inverted; >=.90 band empty in ES (waves nothing through); review-by-default |
| verify / verify-es | 0.90 UNCALIBRATED | 6 + 48 | >=.90 = 0/6 (vaut-es-05 overconfidence exhibit); base ECE .164 at n=6, not fittable |
| rerank | 0.90 UNCALIBRATED | 6 | best ECE (.087) but n=6 single-pass; keep, do not tune to it |
| extract | 0.90 (only non-flagged) | 7 | only >=.90-hit cell (2/2); 0.90 already exploits it |
| review | 0.90 UNCALIBRATED | 7 | score-scale piles minConf ~.4 → 0.90 escalates 7/7; equivalent to any cut >=.5; do NOT lower to quiet it |
| gate | 0.90 UNCALIBRATED + BROKEN-GOLDS | 7 | 0/7 pass; cut meaningless until golds fixed |
| classify | 0.90 UNCALIBRATED + BROKEN-GOLDS | 7 | 0/7 pass; same |
| compare | 0.90 UNCALIBRATED | 7 | ECE .720; >=.90 = 0/3 |
| decide | 0.90 UNCALIBRATED | 7 | #394 pattern (6/7 >=.90, 1/6 pass); raising the cut cannot fix (would need >.96 and still waves a miss) |
| find | 0.90 UNCALIBRATED + INVERTED | 7 | higher band worse (1/4 vs 2/3); do not tune a cut to this |

## 7. Wiring plan for T2 (exact points, per param)

1. `src/client.ts` — `PredictOpts` (+2 fields after `lang`, ~L101):
   `head_max_len?: number; min_confidence?: number`. `predict()` body (~L244-250):
   add `...(opts?.head_max_len != null ? { head_max_len: opts.head_max_len } : {})`
   and same for `min_confidence`. (model/task/lang pattern already there.)
2. `py/laya_server.py` — `PredictRequest` (+2 fields after `lang`, ~L599):
   `head_max_len: int | None = None`, `min_confidence: float | None = None`;
   forward both into `kwargs` in `predict()` (~L801-807). Add explicit
   `min_confidence` range check → 422 (SDK raises ValueError → 500 otherwise).
3. New per-scenario table (T2; e.g. `src/policy/scenarioCuts.ts`):
   `Record<toolName, { minConfidence: 0.90, flag, lang?: unset, head_max_len?: unset,
   min_confidence?: unset }>` with §6 values. `evaluateForTool`
   (`src/policy/mode.ts:171`, fill site L187-189) selects the cut by tool name;
   global `thresholds.minConfidence` stays as fallback. No threshold moves in
   `thresholds.ts` defaults (still honest v1 + UNCALIBRATED flag).
4. Per-call send: `runTool` already forwards `opts` (`src/tool.ts:210`) — each of
   the 9 runTool tools passes its scenario row; `decide.ts:225,241` and
   `pii.ts:273` pass it directly to `client.predict`. T2 sends NOTHING new by
   default (all optional fields unset = byte-identical payloads); plumbing only.
5. `lang`: wire but leave UNSET in T2 (auto-detect; measured ES routing
   84 multilingual / 30 english, deterministic per case, no pass correlation).
   Forcing `lang:"es"` per-request needs request-level language (tools have no
   lang arg today) — no heuristic guessing in T2.
6. SDK `min_confidence`: wire but leave UNSET (unset = SDK writes nothing;
   set = per-answer `low_confidence`/`abstention` fields NO handler reads —
   consuming them is handler + gold work, T3+ at earliest).
7. `head_max_len`: wire but leave DEFAULT (our max = 4 options; Banking77-scale
   budget issue does not apply; zero evidence).

## 8. What NOT to do

- NO temperature in T2: no per-call kwarg exists (verified); it lives in
  `rl_agent_config.json`, fitted post-training on a HELD-OUT slice (>=10
  items/type) via LBFGS — we have no per-question labels, no fittable slice,
  and checkpoints load from HF cache unpinned (editing = fork/export pipeline,
  i.e. the retrain track). Fitting on training data returns a degenerate scale
  (upstream warning). Never resurrect `temperature_by_options` (masks refits).
- NO cuts fitted on pooled-pass n (repeats aren't independent) or on
  classify/gate 0%-pass golds.
- NO lowering cuts to reduce escalation noise (launders permission); NO gating
  on entropy `confidence` (scale .52-.86 by shape — §4c).
- NO use of choicex1 degenerate (p=1.0, n=2) or limit/silence cases.

## 9. Verification (foreground)

- `pip check` (venv `laya-t3b-0323` reused, 0.3.23): No broken requirements found.
- `/health` :8795: 200, ready=true, 3/3 ckpts, cpu, laya_sdk 0.3.23.
- N and calls: stored 114 ES + 72 anchor predicts reused; new live 6 (3 handler + 3 direct).
- Byte-identity: ES questions 20/20 identical across 6 passes; live re-run 3/3
  questions MATCH + 3/3 answers MATCH vs stored (sph-es-02, vaut-es-01,
  verify-normal-01). Live decisions all ESCALATE via the T3 gate (minConfs
  .877/.841/.658 < .90) — gate behavior confirmed end-to-end, not a regression.
- `git show --stat HEAD`: this commit, this dir only (filled at commit time).

## 10. Gaps

n <= 8 per base tool single-pass; oracle golds (!= quality labels); abstention
golds untestable vs never-silent backend; case-level labels block temperature
fitting; CPU-only; single SDK 0.3.23; gate changes the traffic it measures
(re-measure after T2).
