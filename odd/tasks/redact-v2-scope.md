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
