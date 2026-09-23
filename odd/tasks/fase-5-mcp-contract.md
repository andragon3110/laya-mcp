# ODD Feature: fase-5-mcp-contract

## Objective
Contrato MCP tipado sobre SDK 1.30.0 verificado (protocolo 2025-11-25): inputSchemas explícitos, outputSchema+structuredContent aditivos (texto-JSON compatible preservado), decision metadata completa, model_revision honesta, policy version registrada, `laya_capabilities`, schema_version + MCP_CONTRACT.md.

## Problem
Todo output es `content[0].text` JSON sin outputSchema/structuredContent (grep: ninguno en src/); ToolDefinition sin campo outputSchema; `tools/list` descarta todo salvo name/description/inputSchema; faltan decision_id/timestamp/schema_version/policy top-level/model_revision top-level; revision siempre null+unpinned sin resolución; sin capability discovery. Fuente: SDK 1.30.0 types + código > docs > prompt.

## Why
Fase 5 lo exige; P1/P0 dejaron evidence/decision/models-list reutilizables.

## Scope
- `src/tool.ts` (ToolDefinition + outputSchema), `src/index.ts` (list/call: structuredContent+_meta, capabilities), `src/tools/*.ts` (outputSchema por tool + metadata), `src/tools/capabilities.ts` nueva, `src/evidence.ts`/`src/policy/*` mínimo (metadata), `py/*` mínimo (revision configurable si resoluble sin red; si no, null honesto), `tests/` + docs + `MCP_CONTRACT.md`.
- Rama: `odd/fase-5-mcp-contract` apilada sobre `odd/fase-4-search` @ 1bbf684 (herencia feature-branch-chain).

## Constraints
- SDK-verificado, no memoria: outputSchema en types.d.ts:2381-2392, structuredContent en :2601, opcionalidad y $loose verificados.
- Aditivo y seguro: MISMO objeto en text y structuredContent; content no vacío (clientes 2024-10-07 compat); clientes viejos siguen leyendo text.
- No inventar revision hash (null + revision_source unpinned si no resoluble); configurable cuando sea posible.
- Toda decisión policy: policy_name+policy_version registrados (top-level + decision.policy).

## Authorized scope
Lectura total + escritura en Scope. Prohibido: cambiar semánticas de decisión, robustez P0, engine core, push/PR/merge.

## Acceptance criteria
- [ ] inputSchemas explícitos donde el SDK permite; inputs ambiguos eliminados o documentados.
- [ ] structuredContent+outputSchema en tools compatibles, con texto-JSON preservado (mismo objeto).
- [ ] decision metadata: decision_id/timestamp/model/model_revision/primitive/policy/policy_version/schema_version/latency_ms.
- [ ] model_revision registrada cuando resoluble, configurable, reproducible (o null honesto documentado).
- [ ] laya_capabilities con models/primitives/tools/policies/features/mode reales (nada inventado).
- [ ] schema_version definido; incompatibilidades identificadas/documentadas/versionadas; compat razonable.
- [ ] tests schema/contract/structured/back-compat/invalid/malformed; MCP_CONTRACT.md completo.

## Applicable checks
- typecheck, build, py 42/42, mjs (16+49+19+25+17+22+26+26+11+16=227) + nuevos, smoke LAYA_SKIP, doctor --no-live.
- TDD: no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Delivery strategy
- ask-on-risk + feature-branch-chain heredada. Slices por work-unit. Push/PR/merge usuario.

## Tasks
- [x] T1 (delegated, mapping): verificación SDK + mapa contrato — DONE (1.30.0, protocolo 2025-11-25, outputSchema/structuredContent soportados y aditivos; inserción capabilities localizada; revision honest-null).
- [x] T2 (inline): feature doc + mirror + rama odd/fase-5-mcp-contract apilada sobre 1bbf684 — DONE.
- [x] T3 (writer W1): typed inputs + outputSchema — DONE (commit a3bfae7 +1022/-11; ToolDefinition.outputSchema; 11 outputSchemas fieles; list publica schemas+annotations; enforcement: servidor NO valida, builders sí (verificado en server/index.js); 64 tests nuevos; CERO breakings).
- Slice M5-1 (cerrado): T3 a3bfae7.
- [x] T4 (writer W2): structuredContent + metadata + revision — DONE (commit c7d405c +732/-5; src/envelope.ts; mismo objeto en text+structured; decision_id/timestamp/model/revision/primitive/policy top-level/schema 1.0.0; env LAYA/GLINER_MODEL_REVISION; 23 tests; SIN breakings; descubrimiento: cliente SDK valida structuredContent -32602).
- Slice M5-2 (cerrado): T4 c7d405c.
- [x] T5 (writer W3): laya_capabilities + versionado — DONE (commit 1383c9e +1109/-46; tool 12 sondas vivas; metadata opcional en schemas; SCHEMA_VERSION_POLICY + clasificador; 14 tests; cambio documentado: list sin Laya = [laya_capabilities]).
- Slice M5-3 (cerrado): T5 1383c9e.
- [ ] T6 (writer W4): tests schema/contract/structured/back-compat/invalid/malformed — IN PROGRESS (W4).
- [x] T6 (writer W4): tests contrato — DONE (commit 34529ce +666 test-only; tests/fase5_t6_contract_gaps.mjs 50/50; mapeo §8 sin duplicar; test_tools_offline.sh expectación ya correcta desde T5, pendiente ejecución en host con bash).
- Slice M5-4 (cerrado): T6 34529ce.
- [ ] T7 (writer W5): no-regresión + MCP_CONTRACT.md — IN PROGRESS (W5).
- [x] T7 (writer W5): no-regresión + docs — DONE (commit 3de2592 docs-only +287/-4; 1-a-1 vs Fase 4 todo igual; offline.sh PENDIENTE-bash con expectación verificada por lectura+sonda; MCP_CONTRACT.md 271 líneas + README +18/-6; cero código).
- Slice M5-5 (cerrado): T7 3de2592.
- [ ] T8 (inline): readback + spot-check + verificación + reporte — IN PROGRESS.
- [x] T8 (inline): readback + spot-check + verificación + reporte — DONE. Spot-check parent: capabilities 14/14. MCP_CONTRACT.md: 9 secciones + 2 ejemplos. Assess REHUSADO → tier high → self-verify por slice + independent verifier: PASS 19/19 (typecheck/build 0, py 42/42, mjs 378, smoke ok, doctor exit 2 ambiental). Outcome nativo: unavailable.
- Cadena M5 (feature-branch-chain, slices M5-1..5): a3bfae7 T3, c7d405c T4, 1383c9e T5, 34529ce T6, 3de2592 T7. Push/PR/merge: decisión del usuario.

## Progress
- En odd/fase-4-search @ 1bbf684.

## Verification evidence
- (pendiente por work-unit)

## Next step
- Cerrar T2, crear rama, lanzar W1.

## TDD resolution
- no-strict. Fuente: ninguna. Runner: unittest + node mjs.

## Commits
- (pendiente; Conventional en odd/fase-5-mcp-contract)
