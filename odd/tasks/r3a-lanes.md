# ODD Feature: r3a-lanes

Serve the adjudicated r3a checkpoint (`run-20261009T055724Z-r3a`: 53/60
simplified-scorer, probe 73, p95 453ms) through production harness lanes
(classify/gate/screen/rerank) with abstention-aware adjudication, and measure
the composed system (r3a + Qwen/GTE find) on r1 under production scoring.
NO training in this feature.

## Problem
- The harness has a GLiClass lane for classify only
  (`lanes-r1.mjs:300` throws unless `class_*` questions); r3a's
  gate/screen/rerank numbers exist only under the standalone CPU scorer,
  which has no abstention path (2 find nones + 2 gate ABSTAINs are
  forced misses there).
- Production scoring (`score.mjs`/`metrics.mjs`) EXCLUDES abstained cases
  from the denominator and scores find-nones via decision+abstained —
  the 4 abstention cases must be ROUTED (omit key → handler abstains),
  not won. No GLiClass lane does that today.
- Serving gaps (scout `py/gliclass_server.py`, `lanes-r1.mjs`): revision
  always unpinned; 25-label cap breaks multi-claim gate fan-out;
  within-call scores stuffed into `probabilities` (magnitude cuts
  invalid); first-max ties vs required input-order/escalate pattern.

## Why
Unlock the true production number (composed ceiling 12+10+12+12+10=56/60)
with zero training risk; unblock productive use of r3a; base Fase-2
micro-trains on measured gaps, not simplified-scorer gaps.

## Scope decisions (parent, frozen — pending user review of this spec)
- Lanes: classify (repoint existing lane to r3a), gate (new), screen (new),
  rerank (new). NO find lane for r3a (F7 scope stands: find→Qwen/GTE).
- Abstention routing lives LANE-side (omit key → handler abstains, per the
  d1/policylm/qwen patterns). No server protocol change.
- Thresholds seeded from R3.2 validation, tuned ONLY under harness metrics
  (abstention_rate, wrong_confident), NEVER on r1 (single final measurement).
- Checkpoint stays out of git (F7 rule); manifest pins computed
  sha256(model.safetensors) + run-dir name + GLICLASS_MODEL path. Never
  invent a hash.

## Serving changes (`py/gliclass_server.py`)
- S1: run with `GLICLASS_MODEL=<abs path>/run-20261009T055724Z-r3a/checkpoint`
  (`from_pretrained` accepts a local path verbatim). Compat probe FIRST:
  load r3a under `py/.venv-r1`, compare 3 probe scores vs `py/.venv-ft`
  (gliclass version-drift check between train and serve envs).
- S2: manifest pin = sha256 + run-dir + path (computed at smoke time).
- S3: gate fan-out = one POST per claim (`text = ev + " || " + cl`, 3 labels).
  Keeps the 413 guard meaningful; matches the d1 per-question pattern.
- S4: no null-signal protocol — server always returns scores; the lane
  decides omission.
- S5 (noted, out of scope): no /health, no in-flight cap, stdlib http.server.

## Lane changes (`evals/lanes-r1.mjs`)
- L1: per-primitive request builders (classify as today; gate per-claim;
  screen text+3 labels; rerank query-as-text + candidate texts as labels).
- L2: adjudication copied from existing patterns — gate←d1
  (choice/score questions, omit-on-null, verdict mapping incl. ABSTAIN
  emission rule); screen←policylm (missing-signal→ESCALATE);
  rerank←qwen (score order, input-order ties); classify unchanged.
- L3: abstention-routing thresholds (gate m/τ; screen τ if warranted),
  default OFF (= R3.2 validation optimum), tuned under harness metrics on
  validation data only.
- L4: result shape per `score.mjs` contract — `body.decision{decision}`,
  `body.abstention{abstained}`, task fields per `metrics.mjs`
  (verdicts/order/assessment mapping), `judgments:[]` (R1 signals excluded).
- L5: registry adds `gliclass` to gate/screen/rerank. find untouched
  (qwen/gte/d1-choice per F7 scope).

## Checklist
- [x] G1: compat probe DONE (parent, 2026-10-10): `.venv-r1` (torch 2.14.1+cpu, transformers 5.19.0, gliclass 0.1.20) carga r3a y reproduce a `.venv-ft` (torch 2.11.0+cu128, resto idéntico) con scores bit-idénticos en 3 probes (classify/gate/screen shapes, 6 decimales). Pin del checkpoint (sha256 de model.safetensors + run-dir) lo computa y registra el worker en el manifiesto v11.
- [ ] G2: serving S1–S4 + `/predict` smoke per primitive (classify/gate/screen/rerank).
- [ ] G3: lanes L1–L5 + stub 98/98 + r1 158/158 green (no regression) + backend-down exit 2.
- [x] G4: lane smoke 1 case/lane (VERSIONED: `evals/smoke-r3a-lanes.mjs`, salda deuda T6a) + matriz `--live` → `evals/results/v11/` (manifest+metrics+composed) + tabla compuesta (r3a + find qwen/gte reutilizado de v8/v9, sin re-correr). Regresión 98/98 + 158/158 verificada por parent.
- [x] G5 VEREDICTO (parent, 2026-10-10): número de producción = **compuesto decisión 56/60 (= techo predicho exacto), task 54/60** (r3a classify/gate/rerank/screen + qwen-find 12/12). Lanes r3a: classify dec 12/task 10, gate 10/10, screen 10/10, rerank 12/12, abstention_rate 0.0 en todos. Decisiones: (1) magnitudes fijas aceptadas como adjudicación provisional + raw scores/márgenes ya preservados por fila en metrics.json — el routing futuro USA márgenes raw, nunca bandas; (2) exclusión de `other` en el lane classify = scope del lane compartido (preserva comparabilidad R1): los 2 task-misses negativos son estructurales del lane, NO gap del modelo — sin cambio de lane, sin retrain classify; (3) r3a OWNS rerank (12/12 > qwen/gte 9/12); (4) thresholds de gate MUERTOS a nivel producción (ABSTAIN golds → SUPPORTED 0.988/0.977: solo training argmax-ABSTAIN o aceptación); (5) screen tiene UN caso margin-accionable (en-filler 0.30/0.065) → experimento de routing (Track B); es-filler 0.949 confident se acepta; (6) find parkeado permanente (qwen 12/12). Vías lanzadas: Track A (gate-only refnear micro-train r3a→r3e, worktree finetune, doc `odd/tasks/gate-refnear-micro.md`) + Track B (routing-delta con thresholds de validación → v12, este checkout).

## Close-out — Phase 1 measured (2026-10-10, parent)
- Track A DONE FAIL (gate 9/12 vs ≥11, −1 vs r3a; rest green; no abort): refnear hypothesis tested-negative (did not move dissimilarity-silence ABSTAINs, blurred one CONTRADICTED). M3 PARK; r3e parked-healthy; gate SFT-continuation exhausted as an avenue (doc: finetune worktree `odd/tasks/gate-refnear-micro.md`).
- Track B DONE (v12): screen τ=0.2 from 580 held-out validation rows (small-n caveat 7-vs-1 recorded, not a strong claim); gate routing OFF confirmed dead; single r1 pass: routing fired exactly once (en-filler thin-margin → abstain, 0 false), rest bit-identical to v11; screen wrong_confident 0.167→0.091 (6→5 confident, abstention_rate 0.083); composed UNCHANGED 56/60 dec, 54/60 task (abstain converts wrong→excluded).
- Record corrections (parent, declared here): v12 manifest/composed stale labels fixed post-hoc (method/source strings; numbers untouched; `record_correction` fields added); smoke template parameterized (`source`=outTag, method interpolated from live lane constants) + syntax repair; interpolation verified against real constants.
- Production number: **composed decision 56/60 (= predicted ceiling), task 54/60**. Remaining: 2 classify lane-structural (`other` exclusion, shared flow — no change), 2 gate accepted (training exhausted, thresholds dead), 1 screen confident (0.949, accepted), 1 screen abstained (excluded, monitored). No promotion in this feature (G5). No model training left on the table: find parked (scope), gate parked (exhausted), screen mass parked (abort), classify parked (lane scope).

## Commits (local branch only; no push/PR/merge — user decisions)
- `3b4fc45` feat(evals): lanes gate/screen/rerank + versioned smoke + v11.
- `87ea071` feat(evals): validated screen routing + v12 delta.
- (this commit) docs(odd): this feature record.
- Review RDD (2026-10-10, parent): inspect → start sobre el target base-diff completo bloqueado preflight (`lens_context_budget_exceeded`, sin autoridad, nada mutado). Disposición del usuario: cadena de revisiones por work-unit commit (7 eslabones).

## Authorized scope
- `odd/r3a-lanes` branch, main checkout only:
  `evals/lanes-r1.mjs`, `evals/score.mjs` (only if the abstention contract needs
  an additive field — avoid), `py/gliclass_server.py`,
  `evals/results/v11+/` (new manifests), `odd/tasks/r3a-lanes.md` (this file).
- Read-only: `evals/corpus-r1/`, finetune worktree `artifacts-ft/` (checkpoint
  bytes + `r3a-eval.json` reference numbers), `ft/` scripts.
- Forbidden: retraining, threshold tuning on r1, `train/` data, checkpoints
  into git, push/PR/merge (user decisions).

## Acceptance criteria
- `node evals/run.mjs` 98/98 AND `--corpus r1` 158/158 intact after G3.
- New lanes smoke green with a versioned command; backend down → exit 2.
- Manifests v11+ published with per-lane abstention_rate + wrong_confident;
  thresholds documented with validation evidence (no r1 tuning).
- Composed-system table (r3a lanes + qwen/gte find) reported with the
  production-scored number.

## Applicable checks
- `python3 -m py_compile` + endpoint smoke per primitive (G2).
- Programmatic lane smoke, versioned this time (G4).
- Full `--live` matrix as the feature's own gate (G4).
- No test-first exception needed: harness + lanes are behavior code, but the
  applicable check is the live matrix + stub/r1 regression (deterministic
  unit RED not meaningful for lane wiring; same exception as T6a).
