# Fase 4 Search Primitives — Implementation Log

Branch: `odd/fase-4-search` stacked over `odd/fase-3-p1-policy` @ `10cb870`
(P1 unmerged; feature-branch-chain inheritance). Scope is the four search
primitives only — `laya_extract`, `laya_find`, `laya_rerank`, `laya_decide` —
plus configurable candidate selection (top_k, min_gliner_score, pruning,
two-stage decide), benchmarks with real stub/fake data, and this file.

All "before" citations refer to `10cb870` (end of Fase 3), verified with
`git show 10cb870:<file>` and `git diff 10cb870..HEAD --stat` during T8.
All "after" citations refer to the working tree at `196e85f` plus the T8
docs commit. Fase 3 reference state is the `10cb870` tree plus
`P1_IMPLEMENTATION.md`.

P1 contracts reused unchanged: evidence/decision shapes, the versioned
Policy Engine, all four `*@1.0.0` policies, and the honest signal names
(`winner_probability`, `relevance_score`, `detector_score` are raw,
uncalibrated signals — never probabilities, never confidences). Ranking
score != calibrated probability is documented in the `laya_rerank` tool
description, in `README.md`, and in §9 below.

## 1. Algorithms per primitive (pipeline + pre-filter + rationale)

### 1.1 `laya_extract` — per-field candidate selection + grounded values

Pipeline (`src/tools/extract.ts`):

```
document + fields
  -> regex path:   matchAll per field (document order) -> first `shown`
     entity path:  GLiNER spans -> drop < min_gliner_score -> sort by
                   detector_score desc (stable) -> first `shown`
  -> judge picks m{n} / g{n} / none
  -> resolve choice against the SAME shown set; isGrounded() re-checks
     document[start:end] === text; mismatch -> null/not_found
```

Pre-filter: none beyond the selection itself. Regex keeps document order
(the judge sees the FIRST `shown` matches); entities sort by detector
confidence. Rationale: regex matches have no score to rank by, so order is
the only honest cut; entity spans carry sidecar confidence, so filtering
then sorting by it is sound. The old literal `slice(0, 20)` on the
entities path is replaced by
`selectEntitySpans(spans, minGlinerScore, shown)`; the regex path keeps
first-N semantics with N now configurable.

Grounded invariant: every returned value is a verbatim substring of the
ORIGINAL document. Regex offsets come from `matchAll` (hold by
construction); sidecar spans are re-checked because a mismatched span
resolves to `null`/`not_found`, never to a synthesized or shifted string.
`regexCandidates` now carries `{text, start, end}` and regex results gained
`start`/`end` (additive; entity results already had them).

### 1.2 `laya_find` — token-overlap + exact-dedup pruning, then judge

Pipeline (`src/tools/find.ts`):

```
pool (<= 250)
  -> inactive (top_k >= pool size AND min_score <= 0):
     legacy path verbatim (input order, duplicates kept)
  -> active: normalize (lowercase, diacritics stripped, non-alnum -> space)
     -> exact-dedup on normalized token sequences (first kept)
     -> overlapScore = |query tokens present in candidate| / |query tokens|
        (0 when the query has no tokens)
     -> drop < min_score -> stable-sort desc (ties keep input order)
     -> first top_k
  -> judge over shown + always-appended `none`
```

Method name: `token-overlap+exact-dedup` (no LLM, no embeddings; exported
as `FIND_PRUNE_METHOD`). `candidateCount` reported to evidence/policy is
always the REAL pre-pruning pool size, so the 1/N weak-winner baseline is
computed on N, never on the pruned K. Output appends additive `pruned` +
`pruning:{kept, dropped, method}` (mirrored on `evidence.metadata`;
signals untouched). A fully-pruned pool sends criteria `{ none }` only and
resolves through the pre-existing none path to authoritative ESCALATE —
no policy change. Rationale: lexical overlap is the cheapest signal that
correlates with "addresses the query"; exact-dedup removes wasted judge
calls on byte-identical candidates; keeping input order on ties preserves
determinism.

### 1.3 `laya_rerank` — token-overlap shortlist, judge owns the order

Pipeline (`src/tools/rerank.ts`):

```
pool (<= 64)
  -> inactive (top_k >= pool size): legacy path verbatim (input order)
  -> active: overlapScore over tokenizeForFind (tokenizer + scorer SHARED
     with find) -> stable-sort desc -> first top_k
  -> judge assigns one noul per SHORTLIST entry (keys index the shortlist:
     relevance_<shown-i>_<id>); final order is the judge's alone
```

Method name: `token-overlap` (NO dedupe — see §6). The pre-filter ONLY
selects the shortlist: pre-filter rank never leaks into `relevance_score`
or `rank`. Dropped candidates contribute NO row and NO signal (never
asked); pruning is reported (`pruned` + `pruning:{kept, dropped, method}`
plus the `evidence.metadata` mirror), not evidenced. Entries without a
string id keep their legacy null-score rows. Rationale: judge calls are
1:1 per candidate, so capping the pool caps cost linearly; lexical overlap
is sufficient for a coarse shortlist because the judge re-scores
everything it sees.

### 1.4 `laya_decide` — two-stage selection, then requirements vs winner

Pipeline (`src/tools/decide.ts`):

```
stage 1: `selected` choice question ALONE (criteria = option ids)
  -> selected = null  => NO stage 2; every requirement stays missing
     (signal null, supported null) -> abstains -> ESCALATEs via
     decide_no_selection
  -> selected = id    => stage 2 (only when requirements non-empty):
     one noul per requirement_{i}, each instruction injects the winner id
     (+ description when the id matches a known candidate):
     "Is the following requirement met by the selected option "<id>" ...?"
```

Cost/latency: exactly 2 `/predict` calls when requirements are present
(`latency_ms` is the SUM of both stages; each stage gets the standard
`LAYA_TOOL_TIMEOUT_MS` budget — worst case ~2x single-call), exactly 1
when requirements are empty (zero extra cost). Evidence model/revision
come from stage 1, which owns the pick. A flat distribution still runs
stage 2 (a pick exists) and then abstains on the flat band as before.
Rationale (the T6 dependency proof): requirements asked blind ("met by
the selected option?" with no option in scope) cannot distinguish "holds
for B but not for A". The battery pins it: requirement sweet-only-for-B +
winner A -> `supported:false` + ESCALATE, while the same requirement +
winner B -> `supported:true` + ALLOW.

## 2. Limits (defaults, ceilings, env)

All new parameters are optional; every default reproduces the legacy
behavior (see §6, defaults=legacy).

| Parameter | Tool | Default (= legacy) | Validation | Ceiling / env |
|---|---|---|---|---|
| `top_k` | `laya_extract` | 20 (legacy `slice(0,20)`) | integer >= 1 | `LAYA_LIMITS_MAX_EXTRACT_CANDIDATES` (default 20); above -> `input_too_large`. Lowered operator ceiling also lowers the default (`min(20, ceiling)`) so default callers never throw |
| `max_candidates` | `laya_extract` | 20 | integer >= 1 | same ceiling as `top_k`. Effective shown set = `min(top_k, max_candidates)` |
| `min_gliner_score` | `laya_extract` | 0 (= no filtering) | number in [0,1] | entities path only; spans below the cut are dropped before sorting, counted in `dropped` |
| `top_k` | `laya_find` | 250 (= whole pool) | integer >= 1 | `LIMITS.maxFindCandidates` (250); above -> `input_too_large` |
| `min_score` | `laya_find` | 0 (= no filtering) | number in [0,1] | query-token coverage; dropped before the `top_k` cap, counted in `dropped` |
| `top_k` | `laya_rerank` | 64 (= whole pool) | integer >= 1 | `LIMITS.maxRerankCandidates` (64), checked BEFORE pruning; above -> `input_too_large` |
| (none new) | `laya_decide` | — | — | pre-existing bounds enforced in builder AND handler: 2–6 options, <= 32 requirements |

Pre-existing display truncations (unchanged, pinned by T7): criteria
texts sliced to 240 chars (find, decide, regex-extract `m{n}`); entity
criteria to 200 chars; document cap 20,000 chars; at most 64 extract
fields per call. `LAYA_LIMITS_MAX_EXTRACT_CANDIDATES` is the ONLY new env
variable in Fase 4 (missing / non-integer / <1 values fall back to 20
without throwing; read from the live env at call time; the pure resolver
takes the env dict so tests never touch `process.env`).

## 3. Changes per slice (commit)

- **T3 `fb4ac51` feat(search), +605/-30: extract selection + grounded.**
  `src/tools/extract.ts` (+212): `resolveExtractSelection`,
  `selectEntitySpans`, `isGrounded`, `RegexCandidate` with offsets,
  `truncated`/`dropped` on both paths, hallucinated-choice ->
  `null`/`not_found`. `src/limits.ts` (+42): `resolveExtractLimits`,
  `extractLimitsFromEnv`, `EXTRACT_LIMIT_ENV_VARS`. `src/policy/policies/extract.ts`
  (+12/-0 code): comment-only note (no version bump). Policy stays
  `extract@1.0.0`. Battery `tests/fase4_extract_primitives.mjs` (22
  checks). No breakings.
- **T4 `0a97878` feat(search), +594/-18: find pruning pipeline.**
  `src/tools/find.ts` (+221): `tokenizeForFind`, `overlapScore`,
  `resolveFindSelection`, `selectFindCandidates`,
  `buildFindQuestionsWithInfo`, additive `pruned`/`pruning` (+ evidence
  metadata mirror), real-N `candidateCount`. Policy stays `find@1.0.0`.
  Battery `tests/fase4_find_primitives.mjs` (26 checks). No breakings.
- **T5 `c1e0d3d` feat(search), +743/-49: rerank caps + docs + eval.**
  `src/tools/rerank.ts` (+285): `resolveRerankSelection`,
  `selectRerankCandidates`, shortlist-indexed question keys, judged-only
  rows/signals, `score != probability` in tool description; `README.md`
  (+12): rank-only `relevance_score` + pre-filter note. `min_relevance`
  deliberately rejected (see §6). Policy stays `rerank@1.0.0`. Battery
  `tests/fase4_rerank_primitives.mjs` (26 checks + 10/50/100/500/1000
  eval). No breakings.
- **T6 `447d56c` feat(search), +479/-101: decide two-stage.**
  `src/tools/decide.ts` (+302/-101): `buildSelectionQuestions`,
  `buildRequirementQuestions` (winner id + description injection),
  two-call handler (1 call without requirements / null selection),
  summed `latency_ms`, stage-1 evidence identity. Policy stays
  `decide@1.0.0`. Battery `tests/fase4_decide_twostage.mjs` (11 checks).
  No breakings.
- **T7 `196e85f` test(search), +583/-0: §7 gaps + benchmarks.**
  `tests/fase4_t7_gaps_benchmarks.mjs` only (16 gap checks + absolute
  benchmark tables). Zero functional changes.
- **T8 (this commit) docs(search): `README.md` minimal factual rows +
  this file.** Tool descriptions (in `src/tools/*.ts`) already carried
  the T3–T6 factual updates; T8 adds the missing README coverage
  (extract/find/decide rows + 413-contract line). No functional code
  changed in T8 except none — no regression fix was needed.

`git diff 10cb870..HEAD --stat` (functional): only `src/limits.ts`,
`src/policy/policies/extract.ts` (comment), `src/tools/{extract,find,
rerank,decide}.ts`, `README.md`, and 5 new test files. `py/`, all other
tools, engine core, and all old tests are untouched.

## 4. Benchmarks (absolutes only — method + tables, no claims)

Method (printed above each table in the test files; every ratio/count is
also `assert()`ed deterministic; timings/memory are printed, never
asserted): single process; stub `LayaClient` with `latencyMs=0`, so
reported wall time is pipeline overhead, not inference; memory is absolute
`heapUsed` sampled right after pool construction (approximate process
heap, not a delta); throughput is candidates/s of the pure
selector/builder. Rows within one primitive share the process: compare
shapes, not machines. No improvement is claimed anywhere.

T5 rerank eval (`tests/fase4_rerank_primitives.mjs`, deterministic stub +
fakes):

| N | top_k | questions -> Laya | dropped | pruning_ratio |
|---|---|---|---|---|
| 10 | 10 | 10 | 0 | 0.00 |
| 50 | 10 | 10 | 40 | 0.80 |
| 100 | 10 | 10* | 90 | 0.90 |
| 500 | 10 | 10* | 490 | 0.98 |
| 1000 | 10 | 10* | 990 | 0.99 |

\* Projected judge load: the transport rejects pools > 64 with
`input_too_large` before pruning, so N = 100/500/1000 never reach the
judge in one call.

T7 per-primitive benchmarks (`tests/fase4_t7_gaps_benchmarks.mjs`,
verified by the T8 re-run):

| Primitive | Mode | N | sent -> judge | dropped | pruning_ratio |
|---|---|---|---|---|---|
| extract | default (shown 20) | 200 | 20 | 180 | 0.900 |
| extract | top_k=5 | 200 | 5 | 195 | 0.975 |
| find | legacy (no pruning) | 250 | 250 | 0 | 0.000 |
| find | top_k=10 | 250 | 10 | 240 | 0.960 |
| rerank | legacy (no pruning) | 64 | 64 | 0 | 0.000 |
| rerank | top_k=10 | 64 | 10 | 54 | 0.844 |
| decide | reqs=0 (1 call) | 2 options | 1 Q | — | — |
| decide | reqs=1 (2 calls) | 2 options | 2 Qs | stub-sum 14 ms | — |
| decide | reqs=8 (2 calls) | 2 options | 9 Qs | stub-sum 14 ms | — |
| decide | reqs=32 (2 calls) | 2 options | 33 Qs | stub-sum 14 ms | — |

T6 decide cost (`tests/fase4_decide_twostage.mjs`, stubbed `/predict`):
1 requirement -> 2 calls, stage latencies 5 + 9 = 14 ms stub-sum;
0 requirements -> 1 call, 5 ms. Each stage gets the standard
`LAYA_TOOL_TIMEOUT_MS` budget: worst case ~2x single-call.

## 5. Tests (§7 case -> file + counts; total py 42/42 + mjs 227)

Fase 4 adds 101 checks in 5 new files; no old test was deleted or
weakened. §7 case vocabulary: cero / uno / muchos / idénticos /
similares / incorrecto / ambigüedad / vacío / enorme / límites.

| §7 case | extract (battery `fase4_extract_primitives.mjs`, 22) | find (battery `fase4_find_primitives.mjs`, 26) | rerank (battery `fase4_rerank_primitives.mjs`, 26) | decide (battery `fase4_decide_twostage.mjs`, 11) |
|---|---|---|---|---|
| cero | EXISTING (regex empty doc; entities fully filtered/empty) | EXISTING (0 candidates; fully pruned pool) | EXISTING (0 candidates -> ESCALATE) | NEW §7-decide-cero (`fase4_t7_gaps_benchmarks.mjs`: 0 options -> `input_too_large`) |
| uno | NEW §7-extract-uno (1 criterion + none, grounded) | NEW §7-find-uno (1/N baseline always abstains) | NEW §7-rerank-uno (rank 1 + ALLOW, no 1/N baseline) | EXISTING (1 option -> `input_too_large`) |
| muchos | EXISTING (25 matches -> 20 + dropped 5) | EXISTING (25 pool, top_k=5) | EXISTING (eval 10/50/100/500/1000) | NEW §7-decide-muchos (6-option ceiling e2e; 7 rejected) |
| idénticos | NEW §7-extract-identicos (same text x3, distinct offsets) | EXISTING (exact-dedup to one criterion) | EXISTING (dupes both judged, own scores) | NEW §7-decide-identicos (same description, resolve by id) |
| similares | EXISTING (val0..val24 family + top_k cut) | EXISTING (tied shares -> ESCALATE) | EXISTING (firm ties keep input order) | EXISTING (flat distribution -> ESCALATE) |
| incorrecto | EXISTING (hallucinated m99/g99; span/doc mismatch) | NEW §7-find-incorrecto (unknown judge id verbatim) | EXISTING (missing answer -> null last + ESCALATE) | EXISTING (unknown winner id to stage 2 verbatim) |
| ambigüedad | NEW §7-extract-ambigüedad (tie: no abstention by design) | EXISTING (tie + NONE paths) | NEW §7-rerank-ambigüedad (exact ties: ALLOW, no tie-abstention) | EXISTING (flat band; null selection; stage-2 silence) |
| vacío | EXISTING (empty document -> ESCALATE) | NEW §7-find-vacio (empty query e2e, all-zero scores) | NEW §7-rerank-vacio (empty-text candidate still judged) | NEW §7-decide-vacio (empty decision string resolves) |
| enorme | EXISTING (oversized document -> `input_too_large`) | NEW §7-find-enorme (6000-char query passes through) | EXISTING (2000-char truncation + truncation x pruning) | NEW §7-decide-enorme (500-char description sliced to 240) |
| límites | EXISTING (top_k/max_candidates ceiling) + NEW §7-extract-fields (>64 fields) | EXISTING (>250 pool; top_k > 250) | EXISTING (>64 pool; top_k > 64; cap before pruning) | EXISTING (>32 requirements) + NEW §7-decide-muchos (>6 options) |

All NEW rows live in `tests/fase4_t7_gaps_benchmarks.mjs` (16/16; every
§7 case already covered by a T3–T6 battery is mapped, not duplicated —
verified by grep over `tests/fase4_{extract,find,rerank,decide}*.mjs`).
Pre-existing batteries intact: `tests/test_opencode_v2.py` (9),
`tests/test_p0_t4t5_robustness.py` (14), `tests/test_p0_t6_limits.py`
(11), `tests/test_p0_t7_gaps.py` (8), `tests/t6_limits.mjs` (16),
`tests/policy_engine.mjs` (49), `tests/t5_review_gate_verify.mjs` (19),
`tests/t6_screen_pii_rest.mjs` (25), `tests/t7_semantic_adversarial.mjs`
(17).

No-regression 1-to-1 vs Fase 3 (`10cb870`), T8 re-run (command:result):

| Check | Fase 3 (`10cb870`) | Now | Verdict + cause |
|---|---|---|---|
| `npm run typecheck`:exit | 0 | 0 | equal |
| `npm run build`:exit | 0 | 0 | equal |
| `python -m unittest discover -s tests`:pass | 42/42 | 42/42 | equal (`py/` untouched) |
| `node tests/t6_limits.mjs` | 16/16 | 16/16 | equal |
| `node tests/policy_engine.mjs` | 49/49 | 49/49 | equal |
| `node tests/t5_review_gate_verify.mjs` | 19/19 | 19/19 | equal |
| `node tests/t6_screen_pii_rest.mjs` | 25/25 | 25/25 | equal |
| `node tests/t7_semantic_adversarial.mjs` | 17/17 | 17/17 | equal |
| fase4 batteries (new) | n/a | 22+26+26+11+16 = 101/101 | new, green |
| `LAYA_SKIP=1 python tests/smoke.py` | OK, 10 builders | OK, 10 builders | equal |
| `python py/doctor.py --no-live`:exit / counts | exit 2, 10 pass / 0 warn / 1 fail / 3 skip | exit 2, 9 pass / 1 warn / 1 fail / 3 skip | apparent-worse, environmental: the `memory` check WARNs (5.9 GB host RAM at run time); `py/` is byte-identical to `10cb870`, so no Fase 4 code can move it |
| `python -m py_compile` both servers:exit | 0 | 0 | equal |
| `node tests/mcp_smoke.mjs` | exit 1 FAIL at `laya_extract advertised` | exit 1 FAIL at `laya_extract advertised` | equal, by design offline (servers down -> `tools: []`; servers never lifted, no model downloads per mission) |
| `bash tests/test_*.sh` | not executable (no bash on native Windows) | same literal outcome | equal, environmental |
| lint | n/a (no config in repo) | n/a | equal |

## 6. Decisions (with rationale)

- **Defaults = legacy (zero breaking by default).** Every new parameter
  defaults to the old behavior: extract 20/20/0 reproduces `slice(0,20)`;
  find 250/0 sends the whole pool in input order with duplicates; rerank
  64 sends the whole pool; decide with no requirements makes 1 call.
  Verified by unit checks in each battery ("defaults resolve to legacy")
  and by the untouched old batteries staying green.
- **`min_relevance` rejected (pinned by test).** Rerank gains no score
  cutoff because `relevance_score` is the raw, uncalibrated Router noul
  output with no documented scale: a caller-supplied cutoff would be
  uninterpretable (0.9 is not 90%), non-portable across calls and
  checkpoints, and the cheap pre-filter cannot estimate noul without the
  judge — so the only sound cut point is count-based (`top_k`) BEFORE the
  judge. A score cut would need calibrated scores + a policy change, both
  out of scope (task Constraints: no calibration). The battery asserts the
  param is ignored by design.
- **No dedupe in rerank (unlike find).** The rerank contract returns one
  rank per input candidate and near-duplicate triage is an advertised use,
  so collapsing entries would silently drop caller-requested rows. Equal
  texts tie on the pre-score, keep input order, and the judge still
  assigns each its own `relevance_score`. Find dedupes exact duplicates
  only (first kept) because its contract returns a single winner.
- **No second stage without a selection.** A null/abstained pick records
  every requirement as missing (signal null, supported null), which
  abstains ("no option selected") and ESCALATEs via `decide_no_selection`.
  Evaluating requirements with nothing selected would be uninterpretable.
- **Policy versions unchanged (all four stay `1.0.0`).** Thresholds,
  reason codes, and the ALLOW/ESCALATE contracts are untouched — only
  signal sourcing changed (which candidates the judge saw; which winner
  the requirements evaluate). Hence NO version bump, by the same rule P1
  used for additive signal work.

## 7. Breaking changes

None. Justification per slice:

- New parameters are optional with legacy defaults (see §6); default
  calls build byte-identical question sets (pinned by "defaults =
  legacy" unit checks and the green old batteries).
- New output keys are additive only: `pruned` + `pruning:{kept, dropped,
  method}` (find, rerank), `truncated`/`dropped` now also accurate on
  paths that already carried them, `start`/`end` on regex extract results
  (entity results already had them), `pruning` mirror on
  `evidence.metadata` (signals untouched). No existing key changed shape
  or meaning; `candidateCount` semantics preserved (real pre-pruning N
  for find; post-filter shown count for extract, matching the "candidates
  the judge saw" definition).
- Evidence/decision/abstention shapes and all four `*@1.0.0` policies are
  byte-identical in behavior (policy diff is a comment; engine untouched).
- Decide still returns `{selected, distribution, winner_probability,
  requirements, decision, latency_ms, evidence, abstention}` — with
  requirements present the values are now scoped to the resolved winner,
  which is the documented purpose of the slice (dependency tests pin the
  old blind behavior as wrong, not as contract).

## 8. T7 findings (empirically verified against `dist/`, carried into this log)

1. **One candidate never resolves (find).** A single candidate with a
   firm 0.9 share ALWAYS ESCALATEs: 0.9 <= 1/1 on the weak-winner
   baseline, so a lone candidate can never clear its own baseline.
   Documented behavior, not a bug (NONE/ABSTAIN over forced winners).
2. **Unknown judge ids pass through verbatim (find, decide).** Find echoes
   an unknown judge id as winner + ALLOW (no id allow-list); decide
   forwards an unknown winner id into stage 2 verbatim (id injected, no
   description to give). Ids are not validated — recorded as an honest
   limitation.
3. **No tie-abstention in extract/rerank (unlike find).** Tied entity
   shares resolve to the stated choice + ALLOW; exact 0.5/0.5 rerank ties
   keep input order + ALLOW. Only find treats exact ties as ambiguous ->
   ESCALATE. Each behavior is pinned by test as by-design.
4. **No empty-text guards anywhere.** Empty find query (all-zero
   pre-scores, first-in-order kept), empty decide string, and empty-text
   rerank candidates all resolve through the normal path — the judge
   decides. Recorded as observed behavior, not endorsed as ideal.
5. **Long texts slice at documented display widths.** Find criteria and
   decide descriptions slice to 240 chars; regex-extract `m{n}` criteria
   to 240; entity criteria to 200 (with `[start:end]` offsets preserved).
   A 6000-char find query has no length guard and passes through on the
   legacy path.
6. **Hard ceilings verified end to end.** 65 extract fields ->
   `input_too_large` (limit 64); 0 decide options rejected (minimum 2);
   7 decide options rejected while the 6-option ceiling resolves e2e;
   rerank cap checked BEFORE pruning (65-pool rejects even with top_k=2).

## 9. Non-facts (explicitly did not happen)

Calibration (no harness exists — all scores stay raw and uncalibrated);
any change to the Policy Engine, thresholds, or policy versions (all four
stay `1.0.0`); any change to P0 robustness, `py/`, checkpoints, routing
rules, or the `routing` audit block; model downloads or lifted inference
servers (all Fase 4 tests are server-less with stub/fake judges;
live-model behavior was never exercised); test deletions or weakenings
(101 checks added, 0 removed, 0 weakened); any claim that pruning improves
quality or latency on live models (benchmarks are absolute pipeline
overheads with a zero-latency stub — shapes, not machines).
