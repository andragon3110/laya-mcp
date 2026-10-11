# improve-all-functions — que cada laya_* haga bien su trabajo, sin humo

## Why
Análisis 2026-10-10: plumbing MCP correcto (contrato minor-aditivo, 14 tools,
policy 14×1.0.0, limits, degrade, 487+57 checks, stub 98/98), pero precisión
real desigual:
- Laya track pausado: gate 0.222, screen 0.444, decide 0.429, review 0.429 (v4 live).
- GLiClass r3i activo: compuesto 56/60 decisión + 56/60 tarea, pero gate 10/12,
  screen 10/12, y en v2 gate task 0/22 y screen task 0/32 tras r3f/r3g/r3h/r3i.
- Thresholds preservados pre-P1, no calibrados. Revisions unpinned, tokenizer
  unknown. Compare sin bench. Sin comparación ±Laya live.

Objetivo: mejorar todo lo mejorable por función, con evidencia versionada,
sin vender probabilidades ni mejoras donde no las hay.

Principios sin-humo (heredados del repo, no negociables):
1. Ninguna salida es probabilidad. ECE/Brier no aplican hasta que exista
   calibración medida. Taus son reporting slices, nunca cutoffs de producción.
2. Stub 1.000 = conservación de harness, nunca calidad de backend.
3. Live-vs-stub en oracle-stub = divergencia, no regresión. Solo el slice
   independiente (`gold_source: independent`) juzga backends.
4. S6 NO sin ≥10 independientes por primitiva con separación no-overlapping
   + corte actual fuera del gap. Fittear con n=2 es noise-fitting, prohibido.
5. Training: STOP DEFINITIVO a rondas same-dose. Solo mecanismo nuevo
   (abstention-aware objective o datos duros) reabre entrenamiento.

Investigación usada (2026-10-11):
- Calibración jueces LLM: reliability diagrams + ECE solo válidos si la señal
  pretende ser probabilidad; jueces puntuales comprimen arriba (top-compression),
  threshold por intuición falla; linear probes ~10x más baratos y mejor
  calibrados; UniCR = calibration head + temperature scaling + refusal con
  error budget; Judge/Retrieve-or-Abstain con garantías de riesgo.
- Abstención en training: Deep Abstaining Classifier (pérdida con opción de
  abstención durante training), Controlled Abstention Networks (pérdida IDK
  para clasificación/regresión), Selective Prediction + error regularization
  (mejora confidence sin dañar accuracy), SOLA para outputs estructurados.
- PII: GLiNER2-PII 300M SOTA open (42 tipos, multilingüe, supera Privacy Filter
  y NVIDIA-PII), NVIDIA gliner-pii 55+ categorías con caveat de threshold por
  dominio, streaming-span variants para costo.
- Rerank: cross-encoders difíciles de distinguir en-domain, mejor OOD según
  modelo; pointwise LLM scoring descalibrado y lento; listwise consistente pero
  solo para listas chicas; receta sana = cheap recall → cross-encoder top 50-100
  → LLM listwise solo top-few si hace falta.

## Scope
IN: las 14 tools, policy/thresholds, limits, eval corpus, docs honestas, pins.
OUT: push/PR/merge (decisión del usuario), re-entrenar sin mecanismo nuevo,
     revisor RDD nativo (cadena pausada), CUA/ejecución (fuera del MCP).

## T1 — Corpus independiente ≥10 por primitiva (desbloquea todo)
- Agregar `gold_source: independent` con verdad humana fijada desde el input,
  antes de elegir stub signals: classify/screen/gate primero (consecuencia
  directa), luego decide/verify/extract/review/compare/pii.
- Forma: mismo shape que los 10 actuales (ver EVALUATION §7.6). Nunca editar
  v1-v4. Nuevo `--save` → v21+.
- Acceptance: `node evals/run.mjs` 98+N/N, `manifest.gold_corpus` censa
  independientes vs oracle-stub, stub baseline sigue 1.000 por construcción.

## T2 — Screen: de asistivo a confiable
- Hoy: gap 0.456 pero decisiones 0/2 Laya; r3i 10/12 τ=0.2 (580 held-out, nunca r1).
- Mejoras: (a) corpus T1 con inyecciones ES+EN, override+exfiltración, benignos
  ops; (b) medir gap con n≥10 antes de mover cortes; (c) hacer que `relevance`
  deje de ser display-only o documentar por qué no branchea; (d) blind-spot
  test + instruction-hierarchy test como golds, no solo narrativa.
- No hacer: mover 0.75/0.25 con n=2. Prohibido por S6.
- Acceptance: decisión screen en independientes ≥8/10 con abstención honesta,
  o veredicto "sigue asistivo" con evidencia.

## T3 — Gate + Verify: el agujero grande
- Hoy: support/refute overlap (0.9096 vs 0.8575), gate task 0/22, routing OFF.
- Mejoras: (a) lane NLI/Decide real en el harness (hoy construcción S5 fuera
  del harness) para medir transfer vs nativo; (b) `evidence` requerido cuando
  `claims` non-empty (hoy opcional, fuente de ruido); (c) cross-claim check
  (INT-04 pinea que no existe); (d) si overlap replica en n≥10 → es pregunta
  de reemplazo de juez, no de threshold.
- Acceptance: gate independientes con SUPPORTED vs CONTRADICTED separados, o
  decisión documentada "cambiar juez".

## T4 — Find + Rerank: consolidar lo que sí anda
- Hoy: find Laya 2/2 + Qwen 2/2, rerank Qwen 2/2 gaps ≥0.986, Laya ES flippea
  por 0.0004; r3a rerank 12/12 owns rerank; find qwen parked.
- Mejoras: (a) decidir promoción find-qwen con criterio escrito (costo/latencia
  vs Laya); (b) paged N>64 como path por defecto testeado, no solo opt-in;
  (c) tie/silence/rogue-id golds ya existen — mantenerlos como regresión;
  (d) no comparar scores cross-call (contrato) — auditar que ningún consumer
  interno lo haga.
- Acceptance: rerank/find independientes 10/10 en EN+ES, latencias warm
  versionadas.

## T5 — Classify + Decide + Compare
- Classify: r3f fix `other` funcionó (11/12→12/12). Siguiente: hard negatives
  + error regularization (mejora confidence sin dañar accuracy) + 26 v2 batch
  como regresión (hoy 22/26 r3i).
- Decide: two-stage correcto pero caro (2 calls) y sin `ask_user` real (0 hits
  en src). Implementar escape por margen (near-tie → ESCALATE con reason
  `decide_low_margin`) o quitar `ask_user` de la policy doc. Validar 2-6 en
  código (ya existe) + test.
- Compare: agregar fila bench + re-record vN + update de batería que pinea
  10 filas. Normalizar keys de aspectos (colisión `replace(/\W/g)` ya existe,
  testear duplicados).
- Acceptance: classify v2 ≥22/26 sin regresión r1; decide con escape testeado;
  bench 11 filas versionado.

## T6 — Extract + Review
- Extract: invariante grounded correcto. Siguiente: (a) tuning
  `min_gliner_score` con curva P/R en independientes, no a ojo; (b) confirmar
  que regex inválida es error loud (V-05 cerrado) con test; (c) documentar
  `top_k/max_candidates` defaults = legacy 20.
- Review: `tests` aceptado por schema pero infra-usado en judging. Cablear
  `tests` al prompt `safe_to_apply` + oráculos de score-agreement futuros
  (hoy golds solo decisiones). Sin esto, auto-merge advice descansa en un noul.
- Acceptance: extract con P/R por `min_gliner_score`; review con tests
  efectivamente enviados (captura de questions en test).

## T7 — PII + Redact (GLiNER propone, Laya dispone, Policy decide)
- Hoy: policy count-based 3 secret types, juez informativo, sin floor.
- Mejoras: (a) evaluar GLiNER2-PII 300M (42 tipos) vs sidecar actual en
  corpus ES+EN con P/R por tipo; (b) floors por tipo + conteo para DENY,
  medidos en smoke ES primero; (c) ampliar secretTypes con lista cerrada
  (`private_key, secret, credential` ya categorizados como credential pero
  no secret — decidir con datos); (d) redact ya correcto, solo agregar
  bench de throughput en textos largos.
- No hacer: marcar findings como confirmados. `finding_status: candidate`
  se queda.
- Acceptance: PII independientes con P/R por tipo + DENY solo con
  secretos sobre floor.

## T8 — Calibración honesta (sin vender humo)
- Hoy: nada calibrado, correctamente declarado.
- Camino permitido: (a) reliability diagrams por primitiva en independientes;
  (b) si hay miscalibración sistemática → temperature scaling head liviana
  (UniCR-style) + refusal con error budget, versionada como policy minor;
  (c) linear probe como alternativa barata al re-entrenamiento full;
  (d) ECE solo después de (b), nunca antes.
- Prohibido: promover taus 0.70/0.80/0.90/0.95 a cutoffs sin validación en
  tráfico real.
- Acceptance: diagrama + ECE por primitiva, o "no calibrable con este juez"
  (caso Decide argmax-only: calibración inmedible por API).

## T9 — Training solo con mecanismo nuevo
- STOP a same-dose LR 2e-5 × 2 epochs. Reapertura solo con: (a) pérdida
  abstention-aware (DAC/CAN) con costo de abstención elegido por usuario;
  (b) o datos duros nuevos (silencios construidos estilo d3-distill, ya
  probado en r3i) con agreement medido y disagreements dropeados.
- Cada run: eval-loss deltas + live CPU en r1 lanes + v2, bit-identical check
  en lanes no tocados, sha256 + run-dir en manifest. Promoción solo si
  strictly-no-worse + ganancias v2.
- Acceptance: run con deltas negativos, sin ABORT, con decisión adopt/no-adopt
  escrita.

## T10 — Reproducibilidad + docs + CI
- Pinear `LAYA_MODEL_REVISION`/`GLINER_MODEL_REVISION` o registrar revisión
  backend en `--save --live`. Tokenizer: mantener `unknown` honesto hasta
  que el checkpoint lo exponga.
- Corregir 2 líneas README stale (calibrated probs, tools vacíos) — una línea
  cada una, sin batería (docs-only) + readback.
- `>=` → `==` verificados con `pip check` en red. `/health` legacy, preferir
  `/live`+`/ready`. Bash CI + lint mínimo para retirar skips permanentes.
- Comparación ±Laya live con operador externo (5 requisitos), ambos brazos
  versionados, nunca sobrescribir v1.
- Acceptance: `npm test` verde + `node evals/run.mjs` + `--corpus r1` +
  doctor flags con veredicto ambiental conocido.

## Acceptance global
- `npm test` exit 0, stub 98+N, r1 158/158 (o N nuevo), baterías fase4-7 verdes.
- Ningún número nuevo sin `evals/results/vN/` + commit + fecha + device.
- Cada tool con al menos 2 independientes nuevos salvo pii/rerank/find ya
  cubiertos (extender igual a 10).
- Cero claims de probabilidad. Cero "mejora" sin baseline pareado.
- No push/PR/merge. Commits work-unit en feature branch.

## Applicable checks
- Test-first donde haya behavior determinista con RED claro (corpus, policy,
  limits, redact, escalations). Excepción documentada para docs pasivas,
  training (eval-loss + live son la verificación) y calibración (diagramas).
- Native review solo bajo RDD del usuario, por work-unit commit, nunca por
  checkbox TODO ni por branch acumulado.

## Riesgos
- Retunear sin corpus replica arbitrariedad. Corpus T1 primero.
- Retry sin breaker amplifica carga — gating primero (ya existe, no romper).
- PII floors cambian block rate — medir en ES antes de shippear.
- Revision pins congelan weights que hoy driftan — coordinar con operadores.
- Doc drift recurre — check de contrato a nivel lectura por cada cambio de
  behavior.

## Anexo — mapa exacto de superficies (scout gentle-ai-explore, sin edits)
- Shared: `src/policy/thresholds.ts:80-85` cuts v1 no calibrados +
  `RISK_CUT_DELTA 0.05`; `src/policy/engine.ts:26-33` abstain→ESCALATE;
  `src/limits.ts:38-54` fail-fast espejo de py; `LAYA_MAX_INFLIGHT=3`,
  `GLINER_MAX_INFLIGHT=4`.
- screen `src/tools/screen.ts:94-99`, cuts thresholds 80-82; relevance se
  computa y nunca branchea.
- verify `src/tools/verify.ts:84-86` 32 claims=64q; `verify.ts:163-164`
  refute>=0.8 + support<0.8 → CONTRADICTED; both-firm → INSUFFICIENT.
- gate `src/tools/gate.ts:124-126` 30 claims (3+2×30=63); `gate.ts:231-232`;
  safe_to_apply + claims conflados.
- review `src/tools/review.ts:73-78` diff 20k; single noul safe_to_apply decide,
  4 scores advisory.
- decide `src/tools/decide.ts:18-36` 2-6 opts + 32 reqs; 2-stage
  `decide.ts:213-240` dobla latencia; null pick saltea stage2 → ESCALATE.
- compare `src/tools/compare.ts:76-78` 32 aspectos sin check de transitividad.
- classify `src/tools/classify.ts:77-79` 64 items=64q fan-out.
- find `src/tools/find.ts:181-183,244-246` 250 + slice 240; top_k/min_score
  cuentan `dropped`, nunca silencioso.
- rerank `src/tools/rerank.ts:170-172` 64 + trunc 2000ch; scores
  incomparables cross-call.
- extract `src/tools/extract.ts:264-266` 64 fields; `196-198` top_k default
  min(20,env); `403` fuerza typed-decisions en entities; `376,390` fallback regex.
- pii `src/tools/pii.ts:352` secretSet de thresholds; `PII_LABELS` 6 fijas +
  extra_types≤32; judge advisory-only; count-based bloquea con FP.
- redact/capabilities/escalations `buildQuestions()=>({})`; redact es
  string-replace sin verificación; escalations `slice(0,limit)`.
- `py/laya_server.py:predict` routing con passthrough model/task/lang;
  caller-forced model bypasea auto-detect.
- `py/gliner_server.py:/pii_scan` `setdefault(extra,extra)` diluye heads
  zero-shot; sort por offset esconde overlaps.

## Progress T1 (2026-10-11) — independent corpus ≥10 per primitive (classify/screen/gate)
- Files: `evals/suites/classify.mjs`, `evals/suites/screen.mjs`, `evals/suites/gate.mjs` (+24 cases, 8 per suite, ids `*-independent-03..10`).
- Counts: classify 10 independent (was 2), screen 10 independent (was 2), gate 10 independent (was 2); total corpus 98 → 122 (88 oracle-stub + 34 independent incl. rerank/find S4-spike 4).
- Classify new: 03 bug EN (500 after reset), 04 feature EN (PDF export), 05 other EN (opening hours), 06 bug ES (bloquea informe), 07 feature ES (CSV), 08 other ES (horario soporte), 09 bug EN (IndexOutOfBounds), 10 feature EN (weekly digests). All `gold_source: independent`, firm stub shares matching gold, ALLOW.
- Screen new: 03 benign ops EN ALLOW, 04 benign ops ES ALLOW, 05 override EN DENY, 06 override ES DENY, 07 exfil EN DENY, 08 exfil ES DENY, 09 ambiguous EN REVIEW, 10 ambiguous ES REVIEW. All `gold_source: independent`, stub injection signals on the correct side of the 0.75/0.25 cuts.
- Gate new: 03 SUPPORTED/ALLOW passing, 04 CONTRADICTED/ESCALATE failing, 05 SUPPORTED/ALLOW ES passing, 06 CONTRADICTED/ESCALATE ES failing, 07 ABSTAIN/ESCALATE dropped claim, 08 ABSTAIN/ESCALATE dropped refute, 09 SUPPORTED/ALLOW edge 0.82, 10 CONTRADICTED/ESCALATE low-safety. All `gold_source: independent`, claimVerified 0.8 + auto 0.85 respected.
- Verification: `node evals/run.mjs` → 122/122 exit 0; per-suite `classify` 18/18, `screen` 18/18, `gate` 18/18 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T2 (2026-10-11) — screen hardening, still assistive (no threshold moved)
- Read-only confirm: `src/policy/thresholds.ts` cuts untouched (screenInjectionBlock 0.75, screenInjectionReview 0.25, screenSubstanceSkip 0.4, RISK_CUT_DELTA 0.05); `src/tools/screen.ts` relevance still display-only (reported, never branched) and `authority_note` stays detector-only (SCREEN_AUTHORITY_NOTE, no authorization field).
- Files: `tests/t6_screen_pii_rest.mjs` (+3 checks, 25 → 28, append-only, no existing check weakened or deleted): (a) blind-spot miss stays pinned ALLOW with detector-only note as known limitation; (b) instruction-hierarchy override ALLOW carries detector-only note with no authorized/permission/allowed field and no "Safe to include" sentence; (c) relevance display-only — relevance 0.05 vs 0.95 decides identically (ALLOW/screen_pass).
- No threshold moved: S6 still blocked (n=2, no gap measured on n≥10), screen stays assistive, not confiable.
- Verification: `node tests/t6_screen_pii_rest.mjs` → 28 checks passed exit 0 (tail: 3 new T2 checks ok); `node evals/run.mjs screen` → 18/18 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T3 (2026-10-11) — gate plus verify hardening (no threshold moved, no breaking input change)
- Read-only confirm: `src/tools/verify.ts` plus `src/tools/gate.ts` keep the dual-probe contract (support probe plus separate positive-refutation probe; CONTRADICTED needs firm denial plus weak support; both-firm conflicting probes are INSUFFICIENT_EVIDENCE; missing probe is ABSTAIN) and caps intact (verify 32 claims = 64 questions, gate 30 claims = 3 plus 2x30 = 63 questions; `src/limits.ts` maxVerifyClaims 32, maxGateClaims 30, maxQuestions 64).
- Files: `tests/t3_refute_bands.mjs` (+5 checks, 20 → 25, append-only) plus `tests/t5_review_gate_verify.mjs` (+5 checks, 19 → 24, append-only); no existing check weakened or deleted; new checks carry no threshold literals (firm/weak/mid signals only, never cut values).
- Regression cover: (a) positive-refutation-only CONTRADICTED with per-claim isolation (SUPPORTED plus CONTRADICTED into DENY); (b) low support alone never CONTRADICTED (INSUFFICIENT, safety band decides); (c) both-firm conflicting probes stay INSUFFICIENT_EVIDENCE (never silent confirm, never contradict); (d) empty claims abstain structurally (no summary, ESCALATE via abstained_evidence); (e) evidence-missing claims resolve to REVIEW or ESCALATE via policy, never false SUPPORTED/ALLOW.
- No threshold moved: `src/policy/thresholds.ts` untouched, no schema change, previously valid inputs still accepted (only appended assertions).
- Verification: `node tests/t3_refute_bands.mjs` → 25 checks passed exit 0; `node tests/t5_review_gate_verify.mjs` → 24 checks passed exit 0; `node evals/run.mjs verify` → 8/8 exit 0; `node evals/run.mjs gate` → 18/18 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T4 (2026-10-11) — find plus rerank consolidation (no ranking-semantics change, no cap change)
- Read-only confirm: `src/tools/find.ts` keeps cap 250 with 240-char criterion slice, pruning reports `pruned` plus `pruning:{kept, dropped, method}` (`token-overlap+exact-dedup`), 1/N weak-winner baseline on the real pre-pruning count; `src/tools/rerank.ts` keeps cap 64 with 2000-char truncation, `relevance_score` rank-only within-call (never probability, never cross-call comparable), nulls sort last, pre-filter rank never leaks into scores.
- Files: `tests/fase4_find_primitives.mjs` (+7 checks, 26 → 33, append-only) plus `tests/fase4_rerank_primitives.mjs` (+4 checks, 26 → 30, append-only); no existing check weakened or deleted; `src/` untouched.
- Find cover: (a) exact tie → authoritative ESCALATE (`abstained_evidence`); (b) weak winner AT the uniform baseline (unique top == 1/N) → ESCALATE, never ALLOW; (c) silence as empty distribution → ESCALATE with `winner_probability` null; (d) silence as missing judge answer → none path → ESCALATE; (e) rogue id echoes verbatim per the no-allow-list contract (firm rogue token ALLOWs, but the token is outside the pool so callers must ground membership — never a false ALLOW for a real candidate; eval `find-adversarial-01` pinned); (f) rogue id with tied shares → authoritative ESCALATE; (g) pruning `kept + dropped == pool`, judge sent kept + none only, `pruning` mirror on `evidence.metadata`.
- Rerank cover: (a) several nulls sort last keeping input order (firm desc first, missing abstains to ESCALATE); (b) `truncated_ids` reported when any judged candidate was cut (judge state carries the 2000-char cut; clean pool → `truncated:false`, `truncated_ids:[]`); (c) pre-filter rank never leaks into `relevance_score` (judge order wins, scores are the judge noul verbatim, dropped rows contribute no signal); (d) `top_k` default preserves legacy (whole pool, input order, `preScore` 0, legacy `relevance_<i>_<id>` keys).
- Ranking semantics and caps unchanged: find 250 / slice 240, rerank 64 / trunc 2000 intact; `relevance_score` still rank-only within-call with nulls last and no cross-call comparison; no policy version bump (find/rerank stay 1.0.0); eval stub honesty untouched (find 10/10, rerank 10/10 oracle-stub, no retrieval-quality claim).
- Verification: `node tests/fase4_find_primitives.mjs` → 33 checks passed exit 0 (tail: 7 new T4-consolidation checks ok); `node tests/fase4_rerank_primitives.mjs` → 30 checks passed exit 0 (tail: 4 new T4-consolidation checks ok, eval table absolute-only); `node evals/run.mjs find` → 10/10 exit 0; `node evals/run.mjs rerank` → 10/10 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T5 (2026-10-11) — classify plus decide plus compare hardening (no threshold, schema, or cap change)
- Read-only confirm: `src/tools/decide.ts` keeps 2-6 options plus 32 requirements with two-stage selection then requirements-vs-winner (stage 2 scoped to the resolved winner id plus description, null pick skips stage 2); `src/tools/classify.ts` keeps 64 items with `other` default (plus `manual_review` suppressing it); `src/tools/compare.ts` keeps 32 aspects with the relation value never gating (same_fact, contradicts, different_facts all reportable).
- Files: `tests/fase4_decide_twostage.mjs` (+3 checks, 11 → 14, append-only) plus `tests/fase4_extract_primitives.mjs` (+9 checks, 22 → 31, append-only, closest existing primitives battery for classify plus compare display-shape regression; extract handler untouched, no extract assertion weakened or deleted); `src/` untouched.
- Decide cover: (a) abstained selection (non-string choice) skips stage 2 exactly like null selection — 1 call, requirements missing (signal/supported null), ESCALATE `abstained_evidence` with "no option selected"; (b) three-option flat distribution (top == 1/3) still runs stage 2 then abstains on the flat band with ESCALATE despite a met requirement; (c) empty distribution with a pick reports `winner_probability` null (never -Infinity) plus ESCALATE on the empty-distribution band.
- Classify cover: (a) 64 items build at the question budget, 65 items reject `input_too_large`, `other` default injected, `manual_review` suppressing it (frozen shape); (b) empty distribution → winner null plus ESCALATE on the empty-distribution band, missing answer → `other` plus null plus ESCALATE; (c) tied 0.5/0.5 distribution is NOT abstention → ALLOW (v1 has no tie band, pinned as contrast to decide flat-abstain).
- Compare cover: (a) relation value never gates — firm same_fact/contradicts/different_facts each ALLOW; (b) 32 aspects build, 33 reject; (c) duplicate aspect keys stay distinguishable at builder plus evidence level (`aspect_0_price` vs `aspect_1_price`, normalized `price` vs `price!` distinct, 3 evidence signals) with the single-`price` display key last-wins documented as freeze; (d) overall missing abstains (no relation, `winner_probability` null, ESCALATE) and missing aspect abstains while the firm overall stays reported; (e) `winner_probability` null on empty distribution with the firm choice still ALLOWing (empty, not missing, never abstains).
- No threshold or schema or cap changed: policy versions stay decide/classify/compare 1.0.0, cuts and limits byte-identical, no ranking semantic touched; compare bench row remains documented freeze (duplicate-aspect display collision pinned, not fixed, pending a schema-minor decision).
- Verification: `node tests/fase4_decide_twostage.mjs` → 14 checks passed exit 0 (tail: 3 new T5-hardening checks ok); `node tests/fase4_extract_primitives.mjs` → 31 checks passed exit 0 (tail: 9 new T5 classify/compare display-shape checks ok); `node evals/run.mjs decide` → 8/8 exit 0; `node evals/run.mjs classify` → 18/18 exit 0; `node evals/run.mjs compare` → 8/8 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T6 (2026-10-11) — extract plus review grounding (no threshold, schema, cap, judge-routing, or grounding-semantics change)
- Read-only confirm: `src/tools/extract.ts` keeps the grounded-value invariant (judge choice maps to an exact document span or to null/not_found, never synthesized; `isGrounded` re-checks every span), the entities path forces the typed-decisions judge, auto falls back to regex with a note, and over-cap/below-cut candidates are reported in `truncated`/`dropped`, never silent; `src/tools/review.ts` keeps rubric evidence-only (four 0-2 `{score}` objects plus `safe_to_apply` `{signal}`, never a probability, never an authorization) with the ALLOW/REVIEW/ESCALATE exit owned by review@1.0.0; `src/` untouched.
- Files: `tests/fase4_t7_gaps_benchmarks.mjs` (+6 checks, 16 → 22, append-only) plus `tests/t5_review_gate_verify.mjs` (+3 checks, 24 → 27, append-only); no existing check weakened or deleted; no threshold literal added (firm/weak/mid signals only, ceiling asserted via the live `LIMITS` value).
- Extract cover: (a) hallucinated choice key (m99) resolves to null/not_found with no offsets, firm ALLOW; (b) sidecar span/doc mismatch resolves to null/not_found with no offsets; (c) invalid regex is invalid-pattern abstain (`evidence.signals[0].metadata.invalid_pattern`, reason names the pattern) → ESCALATE `abstained_evidence`, never false extracted; (d) `top_k`/`max_candidates` above the ceiling reject `input_too_large` at builder plus handler; (e) entities path forces the typed-decisions judge (captured 4th predict arg) and auto-with-unreachable-sidecar falls back to regex with a `GLiNER sidecar unreachable` note; (f) truncation plus `min_gliner_score` filtering counted in `dropped` (25 matches → dropped 5; 0.3-confidence span filtered → dropped 1, surviving choice stays grounded).
- Review cover: (a) missing `safe_to_apply` abstains (`signal` null, `missing safe_to_apply signal`) → ESCALATE `abstained_evidence`; (b) mid-band safe flows to REVIEW via policy (`review_needs_review`, no abstention), never forced ESCALATE by evidence; (c) rubric scores stay audit-only (correctness 0 vs 2 decide identically at the same band) with no authorization vocabulary and no legacy shape.
- Grounding and judge routing are unchanged: choice→exact-span-or-null, entity typed-decisions forcing, regex fallback note, dropped counting, and evidence-only review with the safe_to_apply signal all pinned as-is; policy versions stay extract/review 1.0.0.
- Verification: `node tests/fase4_t7_gaps_benchmarks.mjs` → 22 checks passed exit 0 (tail: 6 new T6-extract checks ok, benchmarks table printed, absolutes only); `node tests/t5_review_gate_verify.mjs` → 27 checks passed exit 0 (tail: 3 new T6-review checks ok); `node evals/run.mjs extract` → 8/8 exit 0; `node evals/run.mjs review` → 8/8 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T7 (2026-10-11) — PII plus redact hardening (no policy change, evaluation-only upgrade path)
- Read-only confirm: `src/tools/pii.ts` keeps the count-based secret policy with secretTypes api_key/token_secreto/password, finding_status candidate always, and the judge advisory-only with BackendUnavailableError-only null degrade (any other throw propagates, outage never fails the scan); `src/tools/redact.ts` keeps Unicode code-point offsets with earliest-wins longest-wins-ties overlap resolution plus label/placeholder strategies (missing entity_type under label falls back to the placeholder marker); `src/` untouched.
- Files: `tests/t6_screen_pii_rest.mjs` (+5 checks, 28 → 33, append-only) plus `tests/redact.mjs` (+6 checks, 15 → 21, append-only, new Part D); no existing check weakened or deleted; no threshold literal added on the PII side (secret-membership branching asserted via handler decisions, never cut values).
- PII cover: (a) policy branches only on secret membership — same finding_count=1, api_key DENYs (pii_secret_block) while private_key/credential, passport/identifier, email/pii, starship_class/unknown each abstain (never DENY, category display-only); (b) weak-type-only mix (credential+identifier+pii, no secret) abstains to ESCALATE abstained_evidence with every finding_status candidate; (c) judge doubt advisory-only — noul 0.05 on a secret still DENYs with laya_judged:true; (d) judge outage (BackendUnavailableError) degrades to all-null laya_signal with laya_judged:false plus an unavailable/degrade note, secret scan still DENYs; (e) judge outage on weak-only still abstains to ESCALATE (null never invents ALLOW), all findings stay candidate.
- Redact cover: (a) 3-span overlap chain kept 1/dropped 2 with kept+dropped==3 and exact marker output; (b) same-start tie longest-wins kept 1/dropped 1; (c) label without entity_type (missing or blank) falls back to [REDACTED]; (d) astral emoji code-point exactness (a😀b😀c single-emoji redact plus earliest-wins overlap over emoji, dropped counted); (e) missing/null/empty findings without detect reject invalid_argument (redactText empty direct included); (f) placeholder overlap kept 1/dropped 1 with no detection key on the v1 path, plus entities+findings mutual exclusion rejects invalid_argument.
- secretTypes and thresholds are UNCHANGED: `src/policy/thresholds.ts` THRESHOLDS_V1 secretTypes still ["api_key", "token_secreto", "password"], all numeric cuts byte-identical, no schema or sidecar model pin touched; this task makes no policy change in code.
- GLiNER2-PII upgrade path (evaluation-only, task file only, no code change): candidate model fastino/gliner2-privacy-filter-PII-multi (300M, 42 types); reported SPY F1 0.471 with recall 0.722, legal 0.681, medical precision 0.354; before ANY secretTypes change, measure per-type precision/recall in ES plus EN on the T1 independent corpus (floors plus secret-list expansion only with that data, DENY still only over floor). Upgrade stays an evaluation plan until those numbers exist.
- Verification: `node tests/redact.mjs` → 21 checks passed exit 0 (tail: 6 new T7 checks ok); `node tests/t6_screen_pii_rest.mjs` → 33 checks passed exit 0 (tail: 5 new pii T7 checks ok); `node evals/run.mjs pii` → 8/8 exit 0; `npm run typecheck` → exit 0 (tsc clean).

## Progress T8 (2026-10-11) — calibration honesty (no calibration invented)
- Read-only confirm: `evals/calibration.md` verdict holds (no numeric output is a probability; Brier/ECE documented, never calculated); `evals/metrics.mjs` honesty rules intact (`WRONG_CONFIDENT_TAUS` [0.7, 0.8, 0.9, 0.95] reporting slices only, `wrongConfident` counts `excluded` with joint rate plus conditional rate per slice); `evals/score.mjs` rerank `wrong_confident` stays `{ status: "no aplica", ... }` with the within-call-only justification and `judgments: []`; `src/tools/decide.ts` argmax-only API (null selection → `winner_probability` null, excluded as `null_signal`).
- Files: `tests/fase7_t4_metrics.mjs` (+5 checks, 10 → 15, append-only, no existing check weakened or deleted): (a) joint rate vs conditional rate denominators explicit with exclusions counted (threw/abstained/null_signal); (b) custom taus never mutate `WRONG_CONFIDENT_TAUS` (promotion to prod cutoff stays a documented category error); (c) Brier/ECE exports absent by verdict, not omission; (d) Decide null-signal selections excluded, never zero-scored; (e) empty judgments (rerank shape) yield null rates, never numbers.
- Docs: `evals/calibration.md` (+1 section, append-only): T8 pin restating the six guarantees with no calibration math added anywhere.
- No calibration invented: no ECE, no Brier, no temperature scaling, no reliability diagram computed; taus 0.70/0.80/0.90/0.95 remain reporting-only descriptive slices, never production cutoffs.
- Verification: `node tests/fase7_t4_metrics.mjs` → 15 checks passed exit 0 (tail: 5 new T8 checks ok); `node evals/score.mjs` → exit 0 (11 suites stub ceiling 1.000, rerank wc n/a, saved untracked `artifacts/evals-t4-metrics.json`); `npm run typecheck` → exit 0 (tsc clean).

## Progress T9 (2026-10-11) — training gate docs (no training ran, STOP en vigor)
- No training ran: no model, checkpoint, or training-code touched; docs-only.
  STOP DEFINITIVO a SFT same-dose remains in force; r3i is the last adopted
  checkpoint with no r3j on the same recipe (confirmed read-only in
  `odd/tasks/phase2-r3i-distill.md` plus `odd/tasks/r3a-lanes.md`).
- Docs: `odd/tasks/phase2-train-prep.md` (+1 gated-reopening section,
  append-only): reopening only with abstention-aware objective (DAC/CAN IDK
  loss with user-chosen abstention cost, or selective prediction plus error
  regularization) or hard new d3-distill-style data with agreement measured
  and disagreements dropped; every run records eval-loss deltas plus live CPU
  on r1 lanes plus v2 with bit-identical check on untouched lanes plus run-dir
  path plus sha256 in manifest; promotion only when strictly-no-worse plus v2
  gains, otherwise NO new rounds.
- Verification: `npm run typecheck` → exit 0; `git status --short` plus
  `git diff --stat` show docs-only (2 files). No commit.

## Progress T10 (2026-10-11) — reproducibility docs, two stale claims fixed (docs-only, no commit)
- Docs-only: no functional change, no threshold/policy/limit/schema/training touched;
  `src/`, `py/`, `evals/` untouched. `npm run typecheck` → exit 0 (tsc clean, tail:
  `tsc --noEmit` with no errors); `git status --short` → exit 0 (`M MCP_CONTRACT.md`,
  `M README.md`); `git diff --stat` → exit 0 (2 files, 4 insertions, 3 deletions).
- Fix 1 (README.md, Laya bullet): the RLCD sentence claiming "honest probabilities
  are the only way to maximize reward" now reads "trained with RLCD; outputs are
  typed signals with explicit decisions, never calibrated probabilities
  (see `EVALUATION.md` §6)" — one claim, consistent with the `EVALUATION.md` §6
  verdict and the already-correct header (typed answers with deterministic policy
  decisions, never a calibrated probability). Readback of README "What is this"
  section confirms.
- Fix 2 (MCP_CONTRACT.md §7): the backend-down `tools/list` bullet claiming the list
  returns "only `laya_capabilities`" now reads "exactly `laya_capabilities`,
  `laya_escalations`, `laya_redact`" — one line, matching the shipped exemption
  (`src/index.ts` down-list returns all three; README "Optional by design" plus
  `--mcp` doctor flag already stated 3). Readback of §7 confirms.
- Honest gaps that REMAIN (no claim fixed here, documented as unmet): revision pins
  unpinned in practice (`model_revision` honest `null` with `revision_source:
  "unpinned"` unless the operator sets `LAYA_MODEL_REVISION`/`GLINER_MODEL_REVISION`
  or the backend supplies one); tokenizer explicitly `unknown` (neither `GET /models`
  nor `laya_capabilities` exposes one); the paired ±Laya live comparison stays a gated
  protocol only (`evals/integration.mjs --mode live` refuses) with its five live
  requirements unmet: (1) opencode-host session to run the 4 tasks twice,
  (2) gentle-orchestrator skills wired to the hook points, (3) reachable laya-server
  with real models, (4) pinned model revisions (no honest nulls in a live manifest),
  (5) LLM provider credentials for the agent loop behind both arms.
- Residuals outside this task's one-line budget / surfaces, flagged not fixed:
  MCP_CONTRACT.md §10.5 still says backend down yields "exactly `[laya_capabilities]`"
  (same staleness as §7 had); §9 is historic verdict kept verbatim by design;
  `examples/gentle-orchestrator-policy.md:51` ("Laya-backed outputs carry calibrated
  probabilities") sits outside the allowed edit surfaces.

## Progress fix-down-list (2026-10-11) — stale 1-tool down-list expectation fixed
- File: `tests/fase6_t5_security_discovery.mjs` live-DOWN observe/shadow/enforce branch only; the poll loop asserted `length === 1` plus sole `laya_capabilities`, but the shipped T5 exemption since escalations/redact went backend-independent is exactly `[laya_capabilities, laya_escalations, laya_redact]` (length 3, no backend needed), matching `tests/fase5_t5_capabilities.mjs` laya-down check plus `src/index.ts` down-list return. Updated only that assert to the 3-tool truth with exact names in order; no other behavior change.
- Verification: `node tests/fase6_t5_security_discovery.mjs` → 16 checks passed exit 0 (tail: 3 live-down mode checks ok); `npm run typecheck` → exit 0 (tsc clean).
