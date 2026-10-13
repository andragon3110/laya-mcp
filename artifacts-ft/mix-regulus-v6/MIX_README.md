# WS-E regulus-v6 mix (built 2026-10-13, sanctuary-KB round)

First KB-scale round: 7 KB blocks (4542 new rows, ES 41.2%) + 724 lineage
refs = **5266 unique physical rows** staged in this dir. (Task text cites
5290 = spec block-math 4542+748 where the 24 d3 rows are counted twice:
once inside batch4-104, once restated for their train-only role per
`ft/kb-v6/b7-lineage-refs.json`. Physical staged total is 5266; the
double-count is spec arithmetic, not extra rows. Recorded, not hidden.)

## Reuse choice (recorded per task: copies vs by-path)

**COPIES.** All 10 row files are byte copies with sha256 below; home dirs
(`ft/kb-v6/`, `artifacts-ft/mix-regulus-v2/`, `artifacts-ft/mix-regulus-v3/`)
stay read-only. Rationale: single-dir train `--mix` invocation, byte-pinned
provenance, identical to the v5 pattern.

## Files (byte copies with sha256)

- `kb-b1-nli-core.jsonl`: **900** (sha 9fbf8afd…; balanced E/N/C EN/ES,
  XNLI unlisted-on-mirror)
- `kb-b2-anli.jsonl`: **600** (sha fa0ce01d…; EN 400 natural ANLI dist +
  ES-mirror 200, cc-by-nc-4.0 NC-flagged — no commercial redistribution)
- `kb-b3-verify-contrast.jsonl`: **700** (sha e843c018…; SUP+CON pairs +
  NEI, VITC cc-by-sa-3.0 / FMT apache-2.0 / FaVIQ unknown-on-mirror)
- `kb-b4-fever.jsonl`: **900** (sha b89b6bc7…; balanced + 53 mined pairs,
  CC-BY-SA-3.0)
- `kb-b5-screen.jsonl`: **760** (sha 16eb36cc…; attack 380 / benign 380 /
  suspicious 40 REVIEW; deepset apache-2.0 / BIPIA-mirror cc-by-sa-4.0 /
  synthetic-kb-v6. CARRIED FLAG: full-block separation 0.335 ~ chance,
  malicious slice 0.266 — the screen lane gets extra scrutiny, not a pass.)
- `kb-b6-classify.jsonl`: **580** (sha 640eba32…; neutral-other 300 + bug
  100 / feature 100 / other 80, XNLI unlisted + synthetic-kb-v6)
- `kb-b7-silence.jsonl`: **102** (sha 432908de…; ABSTAIN silence bank,
  new-schema `true_labels: []`, synthetic-kb-v6)
- `batch4-train.jsonl`: **104** (sha 40413e7b…; byte copy of the v2 mix
  file: 80 v2d validation + 24 dist-b4 train-only d3)
- `anchors-train.jsonl`: **570** (sha 2efe240a…; byte copy of the v2 mix file)
- `gate-v3-train.jsonl`: **50** (sha e6ed5790…; byte copy of the v3 mix file)
- `eval-ids-train.txt`: **220 ids** (sha 5b9ff145…; r1-60 + v2-80 +
  batch4-80 — the train-time `--eval-ids`, v5 pattern)
- `eval-ids-extended.txt`: **244 ids** (sha 18187025…; ancestor exclusion
  ref, incl. batch4-train ids by design)
- `overlap-report.json`: partitioned 0-tolerance re-check (PASS)
- `cselect.json`: C re-selection on validation-80 with the v6 init
  (v2-pinned CPU-fp32 forwards, procedure v2/v3/v4/v5-identical)

## Composition (5186 train rows after 220-exclusion, weight 1)

Staged 5266 file rows → 80 v2d validation rows dropped at train time
(dry-run verified) → **5186 train rows**: 4542 KB + 24 d3 + 570 anchors +
50 v3. Per-row K: all KB rows K=3; anchors K=3 (510) / K=2 (60); v3 K=3;
batch4 d3 K=3. Train loop = v4-identical exact per-row IDK-loss loop +
dual-schema adapter (KB rows use `all_labels`/`true_labels`; empty
positives → all-zero abstain targets; legacy `labels`/`candidates` on
lineage rows). Init = v2-pinned checkpoint (continuation; head
re-warm-started at bias -2.2, q≈0.1).

## Mix recipe deviations (each with evidence or explicit flag)

Per `odd/tasks/kb-build-report.md`: MNLI≡XNLI-en lineage, fever.ai direct
for the script-based HF mirror, bipia mirror for nonexistent
microsoft/BIPIA, opus-MT ES with back-translation drops (failures dropped
with the leg recorded in `b*-stats.json`).

## Balance / ES (KB portion, from `ft/kb-v6/check-report.json`)

- Gate SUP/CON/ABSTAIN = 1013/1022/1167 (SUP-CON dev 0.44%).
- Screen MAL/BEN/SUS = 380/340/40 (decisive dev 5.56%).
- ES 1871/4542 = 41.2% (full physical mix ≈ 42.4% per build report).
- Max train text length 2400 chars (quarantine guard 8000; micro-batch 4 +
  accum 2 keeps recipe-effective batch 8, v4/v5 pattern for long rows).

## Licenses (training-internal; verify before commercial use)

B2 cc-by-nc-4.0 (NC); XNLI unlisted-on-mirror; FaVIQ unknown-on-mirror;
VITC cc-by-sa-3.0; FMT apache-2.0; FEVER CC-BY-SA-3.0; deepset apache-2.0;
BIPIA-mirror cc-by-sa-4.0; synthetic-kb-v6 originals. Full per-row
`{source, license, lang, orig_id}` in every KB row + `SOURCES.json`.
