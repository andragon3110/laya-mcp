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
