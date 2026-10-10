# consolidate-main — todo lo hecho a `main`, borrar el resto, verificar

## Why
El trabajo real está disperso en 7 ramas `odd/*` + 10 `review/*` sintéticas.
`main` está 22 commits atrás. El usuario pidió: todo a `main`, borrar las
demás, probar en `main`, y después evaluar qué mejorar.

## Scope decisions (frozen)
- `main` FF hasta `odd/phase2-validation` (22 commits, incluye código + docs 14 tools).
- Rescatar solo archivos únicos de ramas laterales (no re-merges completos):
  - `odd/tasks/rerank-promo.md` desde `odd/rerank-promo`
  - `odd/tasks/phase2-data-templates.md` + `odd/tasks/phase2-draft-cases.md` desde `odd/classify-other-lane`
    (el cambio de código `d629ab9` ya está como `ea6634f`, idéntico — se omite)
  - `odd/tasks/readme-refresh.md` + `EVALUATION.md` §13 + banner README desde `odd/readme-refresh`,
    con conteo corregido a 14 tools (la rama lateral decía 12, quedó vieja)
- Stash `env-bump-ts-node26-pre-consolidation` (package.json/tsconfig) se re-aplica
  solo si el build pasa con él; si rompe, se descarta y se reporta.
- `review/*`: sintéticas content-identical, se borran sin merge.
- `odd/finetune-gliclass`: NO se borra (worktree activo con untracked work en
  `/home/andragon/Documents/GitHub/laya-mcp-finetune-gliclass`).
- Remotos (`origin/*`): no se tocan. Solo ramas locales. No push sin el usuario.

## Acceptance criteria
- `main` contiene: código r3a + 14 tools + corpus-v2 + §13 + 4 docs rescatados.
- `npm run build` + `npm run typecheck` verdes en `main`.
- Suites offline verdes: `tests/fase5_t*.mjs`, `tests/redact.mjs`,
  `tests/escalations.mjs`, `tests/mcp_smoke.mjs`, stub 98/98 + r1 158/158 intactos.
- `git branch` final: solo `main` + `odd/finetune-gliclass` (+ `odd/spike-gliner-qwen3` si se decide conservar por espejo de origin).
- Reporte de verificación + lista de lo evaluado para mejora.

## Applicable checks
- No test-first (consolidación, no behavior nuevo). Verificación = build +
  typecheck + suites offline + conteo de tools servables (14).
- Live (sidecars/GPU) fuera de alcance: se reporta como no corrido.

## Review outcome (RDD preflight, post-close)
- `gentle_review inspect` → target `sha256:af60eb37…`, action `start`
  (80 files, base `a2ce4f1` → candidate, committed-only).
- Human granted review start via relay (2026-10-10).
- `gentle_review start` → BLOCKED in preflight:
  `lens_context_budget_exceeded` — no authority created, nothing to
  abandon/repair, retrying this exact candidate cannot succeed.
- Standing disposition (slice-based review, never accumulated monolith)
  confirmed by the provider bound: split into a chained sequence of
  smaller reviewable candidates, or leave unreviewed / disable switch.
