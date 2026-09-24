# P1 Semantic Policy — Implementation Log (Fase 3)

Branch: `odd/fase-3-p1-policy` stacked over `odd/fase-2-p0-backend` @ `519d3f0`
(P0 unmerged; feature-branch-chain inheritance). Scope is P1 honest semantics
only: Perception-to-Decision separation, uncalibrated-signal renaming, first-class
ABSTAIN, explicit evidence structures, a deterministic versioned Policy Engine
without LLM, declarative policies, and the rework of all 11 tool outputs wired
to the engine, plus this file.

All "before" citations refer to `519d3f0` (end of Fase 2), verified with
`git show 519d3f0:<file>` during T8. All "after" citations refer to the working
tree at `94bd216` plus the T8 docs commit. Fase 2 baseline artifacts live in
`artifacts/baseline/*.txt` (Fase 1); the Fase 2 reference state is the `519d3f0`
tree plus `P0_IMPLEMENTATION.md`.

## 1. Architecture: Perception -> Evidence -> Policy -> Decision

Before P1, every handler decided Model -> Action inline: raw Router/GLiNER
numbers were thresholded by literals scattered in `src/tools/*.ts`, verdicts
were forced (no abstention path), and the words `confidence`/`probability`
labeled uncalibrated signals. After P1, the pipeline has four explicit stages:

```
Perception          Evidence               Policy              Decision
(unchanged P0)      (new, src/            (new, src/          (engine output,
                     evidence.ts)           policy/)            handler-rendered)
---------           ---------              ---------           ---------
Laya Router         Signal{source,         evaluate(input):    {decision:
noul / choice /      kind, signal_          1. unknown           ALLOW | REVIEW |
score answers;       strength |             policy ->             DENY | ESCALATE,
GLiNER spans;        relevance_score |      structured           reason_codes[],
regex matches        distribution |         error                 policy{name,
                     winner_probability    2. abstained ==       version}}
                     | detector_score |     true -> ESCALATE
                     score, candidate,      ["abstained_
                     span, detector,        evidence"]
                     model, revision,       (global rule,
                     metadata}              no override)
                    Evidence{signals[],     3. else delegate
                     model, revision,        to the versioned
                     detector} +             policy definition
                    Abstention{              with the shared
                     abstained, reason}      threshold table
```

Handlers (`src/tools/*.ts`) are now thin: they parse backend answers into
Evidence via `src/evidence.ts` constructors, call `evaluate()` with a pinned
`{name, version}` policy ref, and render `{signals | rubric | findings,
assessment | values, decision, evidence, abstention}`. No threshold literal
remains in any handler; cut points resolve from the shared policy table
(`src/policy/thresholds.ts`) and only policies own the mapping. `src/tool.ts`,
`src/index.ts`, `src/limits.ts`, `src/health.ts`, `src/client.ts`,
`src/gliner.ts`, and all of `py/` are byte-identical to `519d3f0` (verified by
`git diff 519d3f0..HEAD --stat`: only `README.md`, `src/evidence.ts`,
`src/policy/`, `src/tools/`, and `tests/` changed).

## 2. Semantics: honest names for uncalibrated signals

Every numeric value from Laya/GLiNER is an uncalibrated signal, never a
calibrated probability and never an authorization. The renames:

| Raw signal (source) | Old label (removed from MCP outputs) | Honest name (v1) | Notes |
|---|---|---|---|
| Router `noul` output | `confidence` / `probability` / `probabilities` | `signal_strength` | Carried as-is; null when the backend gave no answer |
| Rerank Router `noul` | `relevance` (with `?? 0` default) | `relevance_score` | Null when missing; missing scores sort last (the `?? 0` default is gone) |
| Router choice dict | `confidence` dict / `probabilities` | `distribution` | Raw shares, verbatim |
| Max over choice dict | `confidence` number (0 when missing) | `winner_probability` | Null when missing or empty; empty-dict `-Infinity` bugfix from T3 kept (`winnerOf` returns null; JSON already serialized `-Infinity` as null, so null-readers see no change) |
| GLiNER span score | sidecar `confidence` | `detector_score` | No threshold applied server-side (preserved: the legacy handler never cut GLiNER scores either) |
| Review/gate 0-2 rubric numbers | `scores` flat numbers | `score` (unchanged) | Audit-only in v1; the decision reads only `safe_to_apply` + claim signals |
| Verify per-claim verdicts | `verified` / `unsupported` / `contradicted` | `SUPPORTED` / `INSUFFICIENT_EVIDENCE` / `ABSTAIN` (+ `CONTRADICTED` since fut-b-semantica T3, emitted only on positive refutation — see §9) | A low support signal is absence of evidence, never refutation |
| Screen sub-verdicts | `action: block/review/skip/pass` | `assessment: malicious-instruction / ambiguous / irrelevant / valid` + `decision` | Relevance is carried for audit; v1 does not branch on it (preserved: the legacy handler computed relevance but never used it) |
| Handler decisions | `action: auto/pass/...`, `selected`, bare `winner` | `decision: {decision, reason_codes, policy{name, version}}` | Every decision names the policy and version that produced it |

What is NOT calibrated: every cut point in v1 preserves a pre-P1 literal
(see §4). There is no calibration harness in this repo, so the numbers are
honest pass-throughs of what the code already did. Env overrides
(`LAYA_POLICY_*`, see §4) move the preserved cut points for ops/tests only;
overrides do not calibrate anything.

## 3. Policy Engine: deterministic, I/O-free, versioned

- Location: `src/policy/engine.ts` (+ `types.ts`, `loader.ts`,
  `thresholds.ts`, `index.ts` barrel).
- `evaluate(input, opts?)` is a pure function of (evidence, abstention,
  context, risk, policy ref, resolved thresholds). No I/O, no dates, no
  randomness in the decision path. The only I/O in the module graph is
  threshold env resolution at load time in `loader.ts`; tests bypass it by
  injecting thresholds, and double evaluation is byte-identical (pinned by
  tests in every battery).
- Evaluation order: (1) load the policy by name+version — unknown names or
  versions fail with structured `PolicyNotFoundError`
  (`code: "policy_not_found"`, detail carries the requested ref plus the full
  available list), never undefined behavior, never fallback; (2) the single
  global abstain rule: `abstention.abstained === true` short-circuits to
  `{decision: "ESCALATE", reason_codes: ["abstained_evidence"]}` without
  consulting any policy — `context`/`risk` never rescue abstention, and no
  policy may override this rule; (3) otherwise delegate to the policy
  definition with the shared thresholds.
- Versioning: every policy is `{name, version}` (all v1 are `1.0.0`); the
  input ref selects the definition and the decision echoes it, so consumers
  can pin and audit exactly which policy decided.
- `context`/`risk` handling: accepted, forwarded, and validated (an
  invalid risk tier is rejected). Since fut-b-semantica T2, `risk` is
  EFFECTIVE where the policy documents it — `gate`/`screen` move numeric
  bands by the shared `RISK_CUT_DELTA` (0.05, uncalibrated step, same
  honesty as the v1 table) and `pii` moves its non-secret branch
  (high fails closed, low relaxes) — while every other v1 policy still
  ignores it (pinned: identical firm evidence decides identically under
  `low` vs `high`). `risk: "normal"` (the default) is byte-identical to
  the pre-T2 cuts, so no policy version moved (all stay `1.0.0`).
  `find@1.0.0` reads `context.candidateCount` for the arithmetic 1/N
  weak-winner baseline — the single documented `context` read. Neither
  `context` nor `risk` ever rescues abstention or a missing signal.

## 4. Policies: list, versions, threshold origins

All 14 policies are `1.0.0`. Eleven back the MCP tools; three are named
profiles (`code-review`, `security`, `normal`).

| Policy | Decision range (v1) | Thresholds (origin: preserved pre-P1 behavior, NOT calibrated) |
|---|---|---|
| `screen@1.0.0` | DENY / REVIEW / ALLOW / ESCALATE | `screenInjectionBlock` 0.75 (strict `>`), `screenInjectionReview` 0.25 (strict `>`), `screenSubstanceSkip` 0.4 (strict `<`); from `screen.ts` legacy action. Edges: 0.75 -> REVIEW, 0.25 -> substance branch, 0.4 -> ALLOW. Since T2 the optional `risk` tier shifts ONLY the two injection cuts by `RISK_CUT_DELTA` (high 0.70/0.20, low 0.80/0.30; strict edges pinned in `tests/t4_semantica_edges.mjs`); the substance cut never moves |
| `verify@1.0.0` | ALLOW (all verified) / REVIEW (unsupported, none contradicted) / DENY (any positively-refuted claim) / ESCALATE | `claimVerified` 0.8 (`>=` — since T3 the firm band for BOTH the support and the dedicated refutation probe). `claimContradicted` 0.4 is RETAINED in the shared table (defaults, env override, compat) but NO LONGER consulted (T3 BREAKING vs P1: low support without firm refutation REVIEWs as unsupported instead of DENYing; absence is never refutation). Shared with `gate` via the table |
| `review@1.0.0` | ALLOW / REVIEW / ESCALATE (never DENY) | `reviewAuto` 0.85 (strict `>`), `reviewReview` 0.5 (strict `>`); shared with `gate`/`code-review`. Edges: 0.85 -> REVIEW, 0.5 -> ESCALATE |
| `gate@1.0.0` | ALLOW / REVIEW / ESCALATE (never DENY) | `claimVerified` 0.8 (firm band for support AND refutation probes since T3; `claimContradicted` 0.4 retained but unconsulted, same T3 breaking as `verify`) + `reviewAuto` 0.85 (strict `>`, moved by `risk` since T2: high 0.90 / low 0.80 — the 0.80-low edge is a deterministic IEEE-754 float fact, pinned in `tests/t4_semantica_edges.mjs`). Positively-refuted claims dominate safety (ESCALATE even with high `safe_to_apply`); low safety alone REVIEWs (deliberate difference from `review`, which ESCALATEs at <= 0.5). Gate asks 3 rubric questions (not test_gap/blast_radius) plus two per claim (support + refutation since T3), so 30 claims fit the 64-question server budget (3 + 2x30 = 63) |
| `pii@1.0.0` | DENY (secret) / REVIEW (finding) / ALLOW (clean) / ESCALATE | No numeric cut: count-based (`secrets > 0 ? deny : findings > 0 ? review : allow`, preserved). Secret membership from the shared `secretTypes` table (`["api_key", "token_secreto", "password"]`, from `pii.ts` `SECRET_TYPES`). Since T2 the optional `risk` tier moves ONLY the non-secret branch (high `pii_high_risk_deny` DENY, low `pii_low_risk_allow` ALLOW); secrets, clean, and abstention are fixed points |
| `find@1.0.0` | ALLOW-or-ESCALATE | No numeric cut (legacy find had none). Derived checks only: exact tie (1e-9) and weak winner (top share <= 1/N from `context.candidateCount`; arithmetic baseline, not a tuned threshold) |
| `rerank@1.0.0` | ALLOW-or-ESCALATE | None (legacy rerank sorts, never cuts). Authorizes use of the ordering when every candidate signal is firm |
| `classify@1.0.0` | ALLOW-or-ESCALATE | None numeric (legacy had none). Firmness = signal presence |
| `decide@1.0.0` | ALLOW-or-ESCALATE | `requireSupport` 0.8 (requirement signal `>=` counts as met; edge 0.8 -> supported). Mirrors the verify 0.8 cut |
| `compare@1.0.0` | ALLOW-or-ESCALATE | None (legacy had none). The relation value never gates: `same_fact`, `contradicts`, `different_facts` are all reportable |
| `extract@1.0.0` | ALLOW-or-ESCALATE | None numeric (values are verbatim substrings). A firm `none` (judge saw candidates and rejected them) still ALLOWs; only zero-candidate / invalid-pattern fields escalate |
| `code-review@1.0.0` | ALLOW / REVIEW / ESCALATE (never DENY) | Same shared 0.85/0.5 cuts as `review` under a workflow-facing name so API consumers pin it while cut points stay in one table |
| `security@1.0.0` | DENY / REVIEW only (never ALLOW) | `screenInjectionBlock` 0.75 + `secretTypes`. Fail-closed posture for untrusted content: clean evidence still returns `security_default_review` REVIEW. Fail-closed without overriding the global abstain rule (abstention -> ESCALATE in the engine; this policy never runs then) |
| `normal@1.0.0` | ALLOW-or-ESCALATE | None by design: the explicit "no numeric gate" baseline for low-risk informational reads |

Env overrides (ops/tests only): `LAYA_POLICY_SCREEN_BLOCK` (0.75),
`LAYA_POLICY_SCREEN_REVIEW` (0.25), `LAYA_POLICY_SCREEN_SUBSTANCE_SKIP` (0.4),
`LAYA_POLICY_CLAIM_VERIFIED` (0.8), `LAYA_POLICY_CLAIM_CONTRADICTED` (0.4),
`LAYA_POLICY_REVIEW_AUTO` (0.85), `LAYA_POLICY_REVIEW_MIN` (0.5),
`LAYA_POLICY_REQUIRE_SUPPORT` (0.8), `LAYA_POLICY_SECRET_TYPES`
(`"api_key,token_secreto,password"`). Missing or non-finite values fall back
to v1 defaults without throwing; the decision path never touches
`process.env`. Since T3, `LAYA_POLICY_CLAIM_CONTRADICTED` still resolves
into the table (compat) but moves no verify/gate decision — the firm cut
for both probes is `LAYA_POLICY_CLAIM_VERIFIED` (pinned inert in
`tests/t4_semantica_edges.mjs`).

## 5. Evidence schema per tool

Base types (`src/evidence.ts`): `Signal{source: laya|gliner|regex|none,
kind: noul|choice|score|span, signal_strength?, relevance_score?,
distribution?, winner_probability?, detector_score?, score?, candidate?,
span{start,end}?, detector?, model?, revision?, metadata?}`,
`Evidence{signals[], model, revision, detector, metadata?}`,
`Abstention{abstained, reason}`. `model`/`revision` pass through the backend
`routing` block (`revision: null` + unpinned stays, per P0 §8).

| Tool | Signals (one per unit) | Abstention triggers (now authoritative via engine ESCALATE) |
|---|---|---|
| `laya_screen` | 3 `noul` (`is_injection`, `has_substance`, `is_relevant`; `signal_strength`) | Any missing Router answer |
| `laya_verify` | 1 `noul` per claim (`signal_strength`, `candidate` = claim text) | Zero claims; any claim in low band (< 0.40); any in mid band (0.40-0.80, ambiguous support) |
| `laya_find` | 1 `choice` (`candidate` = winner or `none`, `distribution`, `winner_probability`) | `none`/null winner, empty distribution, exact tie, weak winner (top <= 1/N) |
| `laya_rerank` | 1 `noul` per candidate (`relevance_score`, `candidate` = id, `metadata.rank`) | Zero candidates; any missing candidate signal |
| `laya_classify` | 1 `choice` per item (`candidate` = class, `distribution`, `metadata.item_id`) | Any missing answer or empty distribution |
| `laya_decide` | 1 `choice` (`selected`) + 1 `noul` per requirement (`signal_strength`) | Null selection, empty/flat distribution, missing requirement, requirement < 0.8 |
| `laya_compare` | 1 `choice` overall + 1 per aspect (`candidate` = relation, `metadata.aspect`) | Any missing overall/aspect answer |
| `laya_extract` | 1 `choice` per field (`candidate` = key, `metadata.field_id/candidate_count`, entity mode adds `span` + `detector_score`) | Zero candidates or invalid pattern per field |
| `laya_review` | 4 `score` (correctness/spec_match/test_gap/blast_radius, audit-only) + 1 `noul` (`safe_to_apply`) | Missing `safe_to_apply`; mid band (0.5, 0.85] (neither firm auto nor firm escalate) |
| `laya_gate` | 2 `score` (correctness/spec_match, audit-only) + 1 `noul` (`safe_to_apply`) + 1 `noul` per claim | Missing `safe_to_apply`; mid-band safety (same band as review) |
| `laya_pii` | 1 `span` per finding (`detector: gliner:<type>`, `span` offsets, `detector_score`, `metadata.weak_type`) | All findings weak-type only (ambiguous detector judgment). Each rendered finding adds `entity_type`, `category` (secret/credential/pii/identifier/unknown; `false-positive` reserved, never emitted), `laya_signal` (per-span Laya judge `noul`, raw and uncalibrated, since fut-b-semantica T2 — real signal when the backend judges the span, `null` + honest `pipeline.laya_note` reason when it does not; informational only, the count-based policy never reads it), `finding_status: "candidate"`, `pipeline.laya_judged` (true iff every finding carries a signal, vacuously true on zero spans), and the sidecar-verbatim `type` alias for span round-trip consumers |

## 6. Changes made (per slice/commit)

- **T3 `6c1407e` feat(evidence), +736/-6: `src/evidence.ts` (new) + additive
  `{evidence, abstention}` on all 11 handlers.** Legacy decisions
  byte-identical (38/38); old tests intact (42/42 + 16/16). Contains the
  `-Infinity` bugfix: `Math.max(...[])` over an empty distribution now yields
  null instead of `-Infinity` (`winnerOf`).
- **T4 `83a080b` feat(policy), +1586/-0: `src/policy/` (engine, loader,
  thresholds, 14 policies) + `tests/policy_engine.mjs` (49 checks).** Pure
  engine with no callers; thresholds v1 shared table; old battery intact
  (42/42 + 16/16).
- **T5 `3516efe` feat(policy)!, +437/-65: `review`/`gate`/`verify` wired to
  the engine (breaking reshape).** Rubric objects, SUPPORTED/INSUFFICIENT/
  ABSTAIN vocabulary, thresholds via the shared table,
  `tests/t5_review_gate_verify.mjs` (19/19). No old test asserted the old
  shapes, so none needed updating.
- **T6 `10f55f8` feat(policy)!, +897/-89: `screen`/`pii`/`find`/`rerank`/
  `classify`/`decide`/`compare`/`extract` wired to the engine (breaking).**
  Honest renames, pii pipeline with explicit `laya_judged: false`,
  `SCREEN_AUTHORITY_NOTE` detector-only note, README "Screen-pass is not
  authority" property, `tests/t6_screen_pii_rest.mjs` (25/25). One old-test
  update, documented: `tests/mcp_smoke.mjs` pii assert
  (`action === "block"` -> `decision.decision === "DENY"` + policy identity;
  same secret cut, shared table).
- **T7 `94bd216` test(policy), +398: `tests/t7_semantic_adversarial.mjs`
  (17/17).** Zero functional code; blind spots pinned honestly (see §9).
- **T8 (this commit) docs(policy): `README.md` P1 section + this file.** No
  functional code changed in T8.
- **fut-b-semantica T2 `d3b3f67` feat(pii,policy), +822/-110: Laya-judge per
  span in `laya_pii` (one additional `/predict` call, one `noul`
  confirmation per GLiNER span; `laya_signal` real per finding, `null` +
  honest note on outage; `laya_judged` flag; 64-question cap) + effective
  `risk` in `gate`/`screen`/`pii` (optional `risk` input on
  `laya_gate`/`laya_screen`/`laya_pii`; `RISK_CUT_DELTA` 0.05,
  uncalibrated; `normal`/unset byte-identical, no version bump).**
  `tests/t2_pii_judge_risk.mjs` (22/22). Intentional breakings, documented
  in code + §4/§9 deltas above: judge-failure vocabulary (`laya_judged`,
  notes), new optional `risk` inputs, risk-moved bands.
- **fut-b-semantica T3 `814e08b` feat(verify,gate), +901/-259: dedicated
  refutation probe (`refute_<i>`) per claim in `laya_verify`/`laya_gate`;
  `CONTRADICTED` emitted ONLY on positive refutation (firm denial at the
  shared 0.8 cut + weak support; conflicting firm probes ->
  `INSUFFICIENT_EVIDENCE`; low support alone never contradicts); band
  abstention removed from `verify`/`review`/`gate` evidence (present
  mid/low signals reach policy REVIEW/DENY bands; only genuine missing
  signals abstain); caps 64->32 (`laya_verify`) and 61->30 (`laya_gate`)
  claims for the two-questions-per-claim budget.** `tests/t3_refute_bands.
  mjs` (20/20). Intentional breakings: `claimContradicted` unconsulted
  (compat-retained), tighter claim caps (previously-valid 33-64/31-61
  claim calls now `input_too_large` — contract-major, see
  `MCP_CONTRACT.md` §11).

## 7. Tests (acceptance criteria -> file + counts; total 42/42 py + 126 mjs at T8, + 49 fut-b-semantica checks since: t2 22 + t3 20 + t4 7)

- `tests/test_opencode_v2.py` — pre-existing config-layer unit tests. 9/9
  pass (untouched).
- `tests/test_p0_t4t5_robustness.py` — P0 load/concurrency behavior. 14/14
  pass (untouched; proves P0 probes/retry/circuit intact).
- `tests/test_p0_t6_limits.py` — P0 boundary tests. 11/11 pass (untouched).
- `tests/test_p0_t7_gaps.py` — P0 coverage gaps. 8/8 pass (untouched).
- `tests/t6_limits.mjs` — P0 TS builder boundaries. 16/16 pass (untouched).
- `tests/policy_engine.mjs` — 49 engine/policy checks (edges 0.75/0.25/0.4,
  0.8/0.4, 0.85/0.5, abstain precedence, determinism, unknown-policy errors,
  registry = 14 @ 1.0.0, shared claim table verify+gate, env overrides).
  Covers: honest names, versioned policies, determinism, threshold origins.
- `tests/t5_review_gate_verify.mjs` — 19 handler checks (evidence-only
  outputs, SUPPORTED/INSUFFICIENT/ABSTAIN, gate context+risk echo without
  moving cuts, invalid-risk rejection, determinism). Covers: review/gate/
  verify reshape, ABSTAIN first-class, gate context+risk consumption.
- `tests/t6_screen_pii_rest.mjs` — 25 handler checks (screen cuts incl.
  edges, adversarial screen-ALLOW-grants-nothing, pii pipeline + categories,
  all 8 remaining tools incl. missing-signal escalation, determinism).
  Covers: screen separation, pii pipeline, screen-pass property
  (adversarial), remaining tools on the engine.
- `tests/t7_semantic_adversarial.mjs` — 17 checks (all 11 handlers
  handler->evidence->engine wiring with pinned versions, 0.80/0.40 edges,
  contradictory-claims documentation, zero-width/paraphrase attacks,
  obfuscated-secret blind spots, tie/uniform/empty-distribution flats,
  risk-never-rescues, env overrides end to end, `winnerOf` null pin).
  Covers: adversarial property, risk posture, remaining semantic gaps.
- `tests/t2_pii_judge_risk.mjs` — 22 checks (fut-b-semantica T2: judge
  confirm/doubt/abstain per span, honest-null outage degrade, vacuous
  zero-span, 64-question cap, non-backend errors propagate, timeout
  degrade, invalid-risk rejection, gate/screen/pii risk bands + fixed
  points, abstention precedence over risk, `riskCutDelta` unit + other
  policies ignore risk, tool-level screen/pii risk).
- `tests/t3_refute_bands.mjs` — 20 checks (fut-b-semantica T3:
  CONTRADICTED positive + negative (handler + engine, verify + gate),
  0.80 refutation edge, both-firm conflict, missing-probe ABSTAIN,
  mid-band REVIEW reachability (verify/review/gate), legacy support-only
  degrade, builder caps 32/30).
- `tests/t4_semantica_edges.mjs` — 7 checks (fut-b-semantica T4 gap-fill:
  risk-shifted strict edges for screen high/low + gate normal/low,
  `claimContradicted` override inert, `normal` == unset for gate/pii,
  screen/pii `risk` inputSchema shape).
- No-regression vs Fase 2 (`519d3f0`), T8 re-run:

| Check (command:result) | Fase 2 (`519d3f0`) | Now | Verdict + cause |
|---|---|---|---|
| `npm run typecheck`:exit | 0 | 0 | equal |
| `npm run build`:exit | 0 | 0 | equal |
| `python -m unittest` py:pass | 42/42 | 42/42 | equal (P0 files untouched) |
| `node tests/t6_limits.mjs` | 16/16 | 16/16 | equal (P0 limits intact) |
| `node tests/policy_engine.mjs` | n/a (new T4) | 49/49 | new, green |
| `node tests/t5_review_gate_verify.mjs` | n/a (new T5) | 19/19 | new, green |
| `node tests/t6_screen_pii_rest.mjs` | n/a (new T6) | 25/25 | new, green |
| `node tests/t7_semantic_adversarial.mjs` | n/a (new T7) | 17/17 | new, green |
| `LAYA_SKIP=1 python tests/smoke.py` | OK, 10 builders | OK, 10 builders | equal |
| `python py/doctor.py --no-live`:exit / counts | exit 2, 10 pass / 0 warn / 1 fail / 3 skip | exit 2, 10 pass / 0 warn / 1 fail / 3 skip | equal (the single fail is environmental `laya-sdk not installed`; no `pip install laya` per mission) |
| `python -m py_compile` both servers:exit | 0 | 0 | equal |
| `node tests/mcp_smoke.mjs` | exit 1 FAIL at `laya_extract advertised` | exit 1 FAIL at `laya_extract advertised` | equal, by design offline (laya-server down -> `tools: []`; servers never lifted, no model downloads per mission). Only change: the pii assert now reads the DENY vocabulary (documented, §6 T6) |
| `bash tests/test_*.sh` | not executable (`execvpe(/bin/bash) failed`) | same literal error | equal, environmental (no bash on native Windows) |
| lint | n/a (no config in repo) | n/a | equal |

No test was deleted or weakened to reach green. The single `mcp_smoke.mjs`
assert update is an update, not a weakening (it asserts strictly more: the
decision kind plus the policy identity).

## 8. Breaking changes (complete old -> new per tool)

All pre-P1 MCP vocabularies below were verified old-vs-new (`git show
519d3f0:src/tools/<t>.ts` vs the working tree; each handler carries a
`P1-T5/T6 (breaking)` comment with the same mapping).

| Tool | Removed (old) | Replacement (new) |
|---|---|---|
| `laya_screen` | `action: block/review/skip/pass`, `probabilities` dict, top-level `model`, `recommendation` sentence ("Safe to include.") | `signals{injection,substance,relevance}` (`{signal, finding}`), `assessment` (malicious-instruction/ambiguous/irrelevant/valid), `decision` (DENY on block cut, REVIEW on review/skip bands, ALLOW on pass, ESCALATE on abstain), `evidence`, `abstention`, `authority_note` |
| `laya_verify` | Per-claim `{probability, verdict: verified/unsupported/contradicted}`, numeric summary | Per-claim `{claim, signal, verdict: SUPPORTED/INSUFFICIENT_EVIDENCE/ABSTAIN}`, honest summary keys, `decision` (verify@1.0.0). Empty claims: structured ABSTAIN + ESCALATE (was a zero summary) |
| `laya_review` | `scores` flat numbers, top-level `safe_to_apply`, `action: auto/review/escalate` | Rubric objects (`{score}`/`{signal}`), `decision` (review@1.0.0). No direct AUTO: high safety ALLOWs via policy |
| `laya_gate` | `action: auto/review/escalate`, `review: {safe_to_apply}`, per-claim `{probability, verdict}` | Rubric objects, per-claim `{claim, signal, verdict}` (SUPPORTED/INSUFFICIENT/ABSTAIN), `decision` (gate@1.0.0) |
| `laya_find` | `probabilities` dict | `distribution` + `winner_probability` (null when empty), `decision` (find@1.0.0). Winner value unchanged for firm winners |
| `laya_rerank` | `relevance` number with `?? 0` default (missing sorted as zero) | `relevance_score` (null when missing; missing sorts last), `decision` (rerank@1.0.0). Sort unchanged for firm sets |
| `laya_classify` | `confidence` number (max over dict, 0 when missing) | `winner_probability` (null when missing/empty), `decision` (classify@1.0.0) |
| `laya_decide` | `confidence` dict, requirement verdicts | `distribution` + `winner_probability`, requirements as `{signal, supported}` (display-only; the policy owns the cut), `decision` (decide@1.0.0) |
| `laya_compare` | `confidence` dict per judgment | `distribution` + `winner_probability` per judgment, `decision` (compare@1.0.0) |
| `laya_extract` | `confidence` number (0 when missing) | `winner_probability` (null when missing/empty), `decision` (extract@1.0.0). Entity mode keeps `span` + `detector_score` |
| `laya_pii` | `action: block/review/pass` | `decision` (pii@1.0.0 over the shared secret table), enriched findings (`entity_type`, `span`, `detector_score`, `laya_signal` (reserved-null in P1; real per-span judge signal since fut-b-semantica T2, `null` + note when unjudged), `category`, `finding_status: "candidate"`, `type` alias kept) |

## 9. Risks

- **Thresholds are preserved, not calibrated.** Every cut point is a
  pre-P1 literal with its origin documented in `thresholds.ts`. Operators
  must not read them as probabilities; env overrides move uncalibrated cuts
  without calibrating them. Any future calibration needs a harness that
  does not exist here (explicitly out of scope).
- **`CONTRADICTED` is emitted, but ONLY on positive refutation (since
  fut-b-semantica T3).** A low support signal is still absence of
  evidence, never refutation — but a FIRM denial from the dedicated
  `refute_<i>` probe (>= shared 0.8 cut) PLUS weak support (< 0.8) now
  labels the claim `CONTRADICTED` (`verify_contradicted_deny` DENY in
  `verify`, `gate_contradicted_escalate` ESCALATE in `gate`). Both probes
  firm means conflicting evidence (`INSUFFICIENT_EVIDENCE`, REVIEW —
  never a silent confirm). Legacy support-only evidence (no `refute_<i>`
  signals) still cannot DENY (absence != refutation); an explicit null on
  either probe is a missing signal (-> ESCALATE), never a weak one.
- **`risk` is effective where documented (since fut-b-semantica T2),
  ignored everywhere else.** `gate`/`screen` shift numeric bands by the
  shared `RISK_CUT_DELTA` (0.05 — an uncalibrated documented step, same
  honesty as the v1 table, NOT a calibrated cut); `pii` moves only its
  non-secret branch (high fails closed, low relaxes). `normal`/unset is
  byte-identical to the pre-T2 cuts (no version bump: all policies stay
  `1.0.0`). Fixed points at every tier: the global abstain rule,
  missing-signal escalations, contradicted-claim exits, secret DENY,
  clean ALLOW, the substance cut. Callers must still not read any cut as
  a probability.
- **REVIEW/DENY are reachable via the handlers (since fut-b-semantica
  T3).** The global abstain rule is unchanged — real abstention still
  precedes every band — but band-position abstention is gone: a present
  mid/low signal is firm evidence for its REVIEW/DENY band, not
  ambiguity. Evidence abstains ONLY on missing/degraded input (null
  signals, empty claims, missing `safe_to_apply`). Reachable now:
  `verify` REVIEW (unsupported) + DENY (positively-refuted),
  `review`/`gate` REVIEW (mid-band safety), `screen` DENY/REVIEW
  (injection bands), `pii` DENY (secret, plus high-risk non-secret).
  Still never: DENY from `review`/`gate`/`code-review`/informational
  policies, ALLOW from `security`.
- **Documented blind spots (pinned adversarially in T7, not fixed).**
  Zero-width-evaded instructions can miss the detector (the output still
  grants no permission); spaced-out secrets can miss GLiNER stubs (ALLOW
  with empty evidence — a detector miss, not a clean bill); `[at]/[dot]`
  obfuscation yields ambiguous judgment (ESCALATE). Mutually contradictory
  high-signal claims are each reported SUPPORTED (v1 has no cross-claim
  consistency check). The screen-pass property ("detector, never authority")
  is documented in README and tested adversarially, but enforcement lives
  with the calling agent/policy, not in this repo.
- **PII pipeline carries a per-span Laya judge (since fut-b-semantica
  T2).** `laya_signal` is the raw judge `noul` per finding (high supports
  the span, low doubts it, `null` abstains with the reason in
  `pipeline.laya_note`); `pipeline.laya_judged` is true iff every finding
  carries a signal (vacuously true on zero spans, when no Laya call is
  made). The signal is informational only: the policy still decides from
  GLiNER candidate counts, `finding_status` stays `"candidate"`, and
  weak-type-only scans still abstain to ESCALATE before any policy runs
  (so the pii risk branches fire on engine-direct inputs — documented in
  the policy header, not hidden).

## 10. Non-facts (explicitly did not happen)

Calibration (no harness exists); shadow mode; eval harness; CUA; a Laya risk
judge inside `laya_pii`; any change to P0 robustness (probes, retry/backoff/
circuit, concurrency bounds, input limits — code byte-identical, batteries
42/42 + 16/16 green); any change to checkpoints, routing rules, or the
`routing` audit block; any Python change (`py/` untouched); model downloads
or lifted inference servers (all P1 tests are server-less; live-model
behavior was never exercised); test deletions or weakenings (one assert
updated to the new vocabulary, asserting strictly more).
