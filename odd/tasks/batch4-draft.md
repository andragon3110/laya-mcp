# Batch-4 SIGNED (WS-B F1, Regulus) — HUMAN SIGN-OFF 2026-10-12

Status: **SIGNED (human 2026-10-12). User order "procede con los demas
puntos hasta finalizar" = signed as-is, all 104 rows incl. the 13 flagged
borderlines as drafted.** Mechanical promotion DRAFT → SIGNED done
(checker SIGNED-mode green, 0 DRAFT leftovers). Validation split built at
`evals/corpus-batch4/` (80 cases); d3 rows train-only, never corpus.
r3i baseline: **BLOCKED** (r3i absent on this machine, evidence in
`evals/results/v24-batch4-baseline/BLOCKED.json`) — no live numbers, no
substitute checkpoint. Rule zero held: no training ran; r1 untouched.

## Per-file counts (checker-verified, SIGNED 2026-10-12)

| File | Total | EN | ES | Gap shape |
|---|---|---|---|---|
| `ft/batch4/classify-other.jsonl` | 20 | 10 | 10 | Gap-1 `other` negatives |
| `ft/batch4/gate-silence.jsonl` | 20 | 10 | 10 | Gap-2 dissimilarity-silence ABSTAINs |
| `ft/batch4/screen-filler.jsonl` | 40 | 20 (15 plain + 5 near-inject) | 20 (15 + 5) | Gap-3 fillers, incl. quoted-payload |
| `ft/batch4/d3-distill-candidates.jsonl` | 24 | 12 | 12 | construction-ABSTAIN, 2nd distill pass |
| **Total** | **104** | **52** | **52** | unique ids 104/104, 208 SIGNED replacements, 0 DRAFT |

Row keys: `id, kind, lang, class, gold_source, input, oracle, gold`
(all oracles `DRAFT`-prefixed; `gold_source: independent` throughout).

## Coverage table (row ranges → targeted misses)

| Rows | Targets |
|---|---|
| `v2d-classify-en/es-other-01..10` | v2-classify 22/26 + other-negatives 7/10 miss. Topics varied (SSO, webhooks, rate-limits, GDPR-export, trial, nonprofit-discount, notifications, custom-domain, audit-log, backups / MFA, cancelación, facturación, asientos, zona-horaria, notificaciones, almacenamiento, enterprise-trial, calendario, changelog) — zero support-hours clones per variety guard. Borderlines flagged in-oracle: en-08, es-04, es-09 (reviewer confirms not feature requests). |
| `v2d-gate-en/es-abstention-01..10` | r1 2× ABSTAIN→SUPPORTED + v2 gate task 0/22. New subjects unused in batches 1-3 (disk, SEO, GDPR-compliance, offline, encryption-at-rest, failover, audit-completeness, deliverability, argon2, residency / compresión, contraste-modo-oscuro, ISO-27001, cadencia-backups, TLS-1.3, rate-limit, retención-logs, zona-horaria, firma-webhooks, fidelidad-PDF). All claims plausible-to-a-careless-reviewer, evidence silent by construction. |
| `v2d-screen-en/es-filler-01..15` | r1 screen misses + v2 screen task 0/32 (plain-chrome breadth: loading, ads, page-actions, availability, JS-notice, paywall-meter, feedback, related-links, search-meta, timeout, autosave, print-header, TOC, skip-link, chat-offline — none reused from batches 1-3). |
| `v2d-screen-en/es-nearinject-01..05` | r1 confident 0.949 es-filler failure mode: quoted-payload strings (root-access, abuse-sample address, destructive command, phishing quote, synthetic fraud) that must stay REVIEW, never DENY/pass. All 10 marked borderline-by-design in-oracle. |
| `dist-b4-en/es-01..12` | 2nd d3-distillation pass (R3T5 precedent: agreement 19/24). NEW subjects unused in batches 1-3 AND unused in batch-4 gate rows above (support-volume, signups, SOC-2, task-time, churn, conversion, export-scale, open-rates, pipeline-parsing, adoption, insurer-questionnaire, response-time / soporte-25%, misclicks, rebote, conciliación, ventas, URLs, auditoría-sync, entrega-eventos, multi-tenant, e-invoicing, activación-7d, Excel-compat). Truth ABSTAIN by construction; kept for training only iff d3 verdicts ABSTAIN (agreement rate = quality metric, WS-C/E). NOT corpus, NO firma. |

## Validation split (built 2026-10-12, WS-B)

Signed Gap-1/2/3 rows (80) live in the NEW split `evals/corpus-batch4/`
(`classify.mjs` 20 + `gate.mjs` 20 + `screen.mjs` 40, 40 EN/40 ES, all
`gold_source: independent`, corpus-v2 file shape, loads green);
d3-kept rows stay train-only, never corpus. `evals/corpus-r1` and
`evals/corpus-v2` untouched; `node evals/run.mjs` stays 122/122.

## r3i baseline (BLOCKED 2026-10-12, pre-train)

- r3i champion `run-20261010T210220Z-r3i` is ABSENT on this machine
  (`:8770` refused curl exit 7; no `run-*-r3i*` dirs; no `artifacts-ft/`;
  OPERATOR Linux path nonexistent; HF cache has stock only) — full evidence
  in `evals/results/v24-batch4-baseline/BLOCKED.json`. No live numbers, no
  substitute checkpoint measured (stock NOT used as stand-in).
- Rerun when r3i servable: boot sidecar with the checkpoint, run
  `validate-v2`-style lanes over `evals/corpus-batch4/` into
  `evals/results/v24-batch4-baseline/` (per-lane decision/task, EN/ES
  slices, latency; v1-v23 untouched).
- Lanes queued: `laya_classify` x20, `laya_gate` x20, `laya_screen` x40
  (plain vs near-inject split), d3 labeling x24 → agreement rate vs
  ≈19/24 precedent (WS-C/E).

## Sign-off record

Human signed 2026-10-12 via proceed order covering all 104 rows as-is
(13 borderlines kept as drafted). Promotion proof: 208 SIGNED replacements,
0 DRAFT leftovers, checker SIGNED-mode green. WS-C ready: 24 d3 candidates
await labeling (kept-iff-ABSTAIN, agreement rate to record).
