# redact v2 — auto-detect mode (PROPUESTA, sin construir)

## Problema
`laya_redact` hoy exige `findings` del caller (spans en code points). Para
redactar, el agente debe llamar primero a `laya_pii`/`laya_extract`, mapear
offsets y recién llamar a redact. Tres llamadas donde una alcanzaría.

## Propuesta (v2, aditivo, sin romper v1)
- Nuevo input opcional `detect: { source: "pii" | "entities", extra_types? }`.
- Con `detect` presente y sin `findings`: el handler corre la detección
  internamente (mismo productor GLiNER, mismos offsets code points) y
  redacta en el mismo call. Sin `detect`: comportamiento v1 idéntico.
- Output suma `detection: {spans_found, producer}` (additive key —
  verificar compat con el test old-client de T6 antes de cerrar forma).
- Sin backend (pii/gliner) caído: `detect` falla isError con el diagnóstico
  (igual que `laya_pii`); `findings` manual sigue funcionando (diseño actual).
- Contract + tests: T6 gaps (vocabulario), round-trip con detect, regresión
  v1 (estrategias, overlaps, unicode), doc CONTRACT + runbook.

## No decidido (requiere tu scope antes de construir)
- ¿`detect.source: "auto"` (elige pii vs entities según backends vivos)?
- ¿Límites (máx chars, timeout propio) distintos de pii?
- Nombre final del modo y claves del output.

## Estado
Propuesta en firme para aprobación. Construir = feature con test-first
(detect+redact tienen runner determinista offline con stub GLiNER si se
provee; si no, test-first parcial + live tapado por diseño).

## RDD 73335f4e (2026-10-10)
- Inspect: monolith + scope doc, start offered
  (lineage `review-1dab041082c8a8df`). Human DECLINED (candidate-scoped).
- No review invoked, no authority created.

## Construido (2026-10-10)
Scope cerrado: auto + límites pii + metadata. Test-first (RED observado,
GREEN 15/15: validación, conflicto, down-path, mapping, positivos con ctx
simulado, v1 sin detection). Archivos: src/tools/redact.ts,
tests/redact.mjs, MCP_CONTRACT §3. Detect vive solo con sidecar GLiNER.

## RDD a5839b48 (2026-10-10)
- Inspect: slice-sized candidate (4 files), start offered
  (lineage `review-3c1604161ad03b5c`). Human granted; START ok
  (reviewing, 1 lens reliability, 235 lines).
- Collect: forecast 1 run pi_host_relay; ack run →
  `pi-host-relay-transport-failure` (no model for review-reliability).
  Fresh STATUS reoffers the identical slot; deterministic config failure,
  no relaunch. Lineage OPEN, awaiting decision (abandon vs other host).

## RDD 24f9025a (2026-10-10)
- Inspect: slice-sized candidate (5 files, redact v2 + README vs
  origin/main), start offered (lineage `review-cf3c2c2efb3503ef`).
  Human granted; START ok (reviewing, reliability, 269 lines).
- Collect: forecast 1 run; ack run → transport failure (no model for
  review-reliability). Fresh STATUS reoffers identical slot;
  deterministic, no relaunch. Lineage OPEN, awaiting decision.
