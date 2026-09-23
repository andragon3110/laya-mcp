# ODD Feature: fase-3-p1-semantica-policy

## Objective
Separar Perception→Evidence→Policy→Decision: semántica honesta (sin "confidence" sin calibrar), ABSTAIN de primera clase, estructuras de evidencia explícitas, Policy Engine determinista versionado sin LLM, policies declarativas, y rework review/gate/verify/screen/pii (resto de tools cableadas al engine) + P1_IMPLEMENTATION.md.

## Problem
Todo valor numérico es señal sin calibrar etiquetada como confidence/probability; cada handler decide Model→Action inline (action auto, verdicts, selected, winner); thresholds literales dispersos solo en código; sin abstención (veredicto forzado); sin policy (grep 0 hits); screen-pass usable como autoridad. Fuente: código > AUDIT.md/P0_IMPLEMENTATION.md > prompt.

## Why
Fase 3 lo exige; P0 dejó robustez (probes, retry/circuit, límites 413) reutilizable sin redefinir.

## Scope
- `src/evidence.*` + `src/policy/*` nuevos; `src/tools/*.ts` (11) rework outputs; `src/tool.ts`, `src/index.ts` cableado mínimo; `py/*` solo lo estrictamente necesario (Pydantic de evidencia si el servidor la produce; el engine vive en TS junto al MCP).
- `tests/` nuevos + actualización (NO borrado) de tests P0 que aserten formas viejas (documentar cada uno).
- Docs relacionadas + propiedad de seguridad + `P1_IMPLEMENTATION.md`.
- Rama: `odd/fase-3-p1-policy` apilada sobre `odd/fase-2-p0-backend` @ 519d3f0 (P0 sin merge; herencia feature-branch-chain).

## Constraints
- Laya/GLiNER nunca autoridad; probabilidad ≠ autorización; ningún `Model → Action`.
- Engine determinista, sin LLM; policies declarativas versionadas (name+version en cada decisión).
- Thresholds v1 = comportamiento actual preservado (screen 0.75/0.25/substance 0.4; verify/gate 0.8/0.4; review/gate auto 0.85/review 0.5; pii por conteo), documentados como NO calibrados. No copiar ejemplo del prompt.
- Sin calibración real (no hay harness); renombrar con honestidad en vez de calibrar.
- Tests con comportamiento real; no mockear toda la lógica; no retocar thresholds para green.

## Authorized scope
Lectura total + escritura en Scope. Prohibido: calibración, shadow mode, eval harness, CUA, cambiar robustez P0 (probes/retry/límites) salvo línea necesaria, push/PR/merge.

## Acceptance criteria
- [ ] Ningún output MCP usa `confidence`/`probability` para señal sin calibrar (nombres honestos + doc).
- [ ] ABSTAIN/INSUFFICIENT_EVIDENCE de primera clase donde el prompt lo exige (verify/find/extract/review/decide/gate).
- [ ] Evidencia explícita con source/score/candidate/span/detector/model/revision/metadata según tool.
- [ ] Policy Engine determinista + policies versionadas; decisión {ALLOW/REVIEW/DENY/ESCALATE + reason_codes + policy{name,version}}.
- [ ] review produce evidencia (no AUTO directo); gate consume evidence+policy+context+risk; verify con SUPPORTED/CONTRADICTED/INSUFFICIENT/ABSTAIN; screen separa injection/substance/relevance con PASS/REVIEW/BLOCK; pii pipeline GLiNER→spans→Laya→risk→Policy.
- [ ] Propiedad "screen-pass ≠ autoridad" documentada y testeada adversarialmente.
- [ ] Tests unit/integration/policy/semantic/adversarial; no-regression vs Fase 2; P1_IMPLEMENTATION.md.

## Applicable checks
- `npm run typecheck`, `npm run build`, unittests py (9+14+11+8 existentes), `node tests/t6_limits.mjs`, `LAYA_SKIP=1 python tests/smoke.py`, `doctor --no-live`, batería nueva.
- TDD: no-strict (sin config ni elección). Fuente: ninguna. Runner: `python -m unittest` + scripts repo.

## Delivery strategy
- `ask-on-risk` + `feature-branch-chain` heredada (elegida Fase 2, apilada). Cambios breaking esperados (vocabularios MCP) → slices por work-unit, boundaries registradas. Push/PR/merge a decisión del usuario.

## Tasks
- [x] T1 (delegated, mapping): mapa semántico actual — DONE (36 hits src + 15 py; 11 outputs con decisión directa; thresholds literales; allow/pass divergen; policy no-existe; puntos de inserción tool.ts/index.ts).
- [x] T2 (inline): feature doc + mirror + rama odd/fase-3-p1-policy apilada sobre 519d3f0 — DONE.
- [x] T3 (writer W1): evidence+abstain aditivos — DONE (commit 6c1407e +736/-6; src/evidence.ts final; 11 handlers con evidence+abstention; decisiones byte-idénticas 38/38; tests viejos intactos 42/42+16/16; bugfix -Infinity documentado).
- Slice P1-1 (cerrado): T3 6c1407e.
- [x] T4 (writer W2): Policy Engine + 14 policies @1.0.0 + 49 checks — DONE (commit 83a080b; reutilizado 100% trabajo parcial previo tras readback; engine puro sin callers; thresholds v1 compartidos; batería vieja intacta 42/42+16/16).
- Slice P1-2 (cerrado): T4 83a080b.
- [ ] T5 (writer W3): review/gate/verify por engine (reshape rompedor) — IN PROGRESS (W3).
- [x] T5 (writer W3): review/gate/verify por engine — DONE (commit 3516efe +437/-65; rubric/decision/SUPPORTED/INSUFFICIENT/ABSTAIN; thresholds vía tabla compartida; tests/t5_review_gate_verify.mjs 19/19; viejos intactos 42/42+16/16+49/49; ningún test viejo asertaba formas viejas).
- Slice P1-3 (cerrado): T5 3516efe.
- [ ] T6 (writer W4): screen/pii + resto tools por engine + propiedad seguridad — IN PROGRESS (W4).
- [x] T6 (writer W4): screen/pii + resto por engine + propiedad — DONE (commit 10f55f8 +897/-89; 8 handlers + decision engine; renombres honestos; pii pipeline con laya_judged:false explícito; README propiedad; tests/t6_screen_pii_rest.mjs 25/25; mcp_smoke actualizado 1 assert documentado; viejos intactos).
- Slice P1-4 (cerrado): T6 10f55f8.
- [ ] T7 (writer W5): tests unit/integration/policy/semantic/adversarial restantes — IN PROGRESS (W5).
- [x] T7 (writer W5): tests restantes — DONE (commit 94bd216 +398; tests/t7_semantic_adversarial.mjs 17/17; batería total 42py + 16+49+19+25+17 mjs GREEN; cero código funcional; blind spots pineados honestamente).
- Slice P1-5 (cerrado): T7 94bd216.
- [x] T8 (writer W6): no-regresión+docs — DONE (commit 10cb870 +333/-0 docs-only; 1-a-1 vs Fase 2 todo igual; P0 intacto por diff; P1_IMPLEMENTATION.md 310 líneas 10 secciones + README +23; ningún test borrado).
- Slice P1-6 (cerrado): T8 10cb870.
- [ ] T9 (inline): readback + spot-check + verificación + reporte — IN PROGRESS.
- [ ] T8 (writer W6): no-regresión + docs + P1_IMPLEMENTATION.md. Commit 6.
- [x] T9 (inline): readback + spot-check + verificación + reporte — DONE. Spot-check parent: policy_engine 49/49. P1_IMPLEMENTATION.md: 10/10 secciones. Assess REHUSADO (untracked-declaration; precedente Fase 2: runtime no elegible) → tier high → self-verify por slice + independent verifier: PASS (typecheck/build 0, py 42/42, mjs 16+49+19+25+17, smoke ok, doctor exit 2 ambiental). Outcome nativo: unavailable.
- Cadena P1 (feature-branch-chain, slices P1-1..6): 6c1407e T3, 83a080b T4, 3516efe T5, 10f55f8 T6, 94bd216 T7, 10cb870 T8. Push/PR/merge: decisión del usuario.

## Progress
- En odd/fase-2-p0-backend @ 519d3f0. Decisión de diseño (basada en código, no arbitraria): thresholds v1 preservan comportamiento actual.

## Verification evidence
- (pendiente por work-unit)

## Next step
- Cerrar T2, crear rama, lanzar W1.

## TDD resolution
- no-strict. Fuente: ninguna. Runner: unittest + scripts repo.

## Commits
- (pendiente; Conventional en odd/fase-3-p1-policy)
