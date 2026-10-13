# Regulus Knowledge-Base Spec (exact, v1.0 — 2026-10-13, parent)

How the pros build decision-model KBs (verified sources), mapped lane-by-lane
to what Regulus must contain. No training starts from this doc; the build
worker pulls exactly these sources, caps, and licenses.

## What the best builders actually use

- GLiClass paper §2.2 (arxiv 2508.07662): 1.2M pre-train (classification +
  sentiment + NLI) → mid-train subset with RL trainer → post-train
  logic/NLI stream (CommonsenseQA + 2000 synthetic formal-logic) +
  pattern-focused stream (length buckets 0–1024, GPT-4o 50 true/50 false
  labels per text, 2000 texts, label-density duplication) + MultiNLI.
  Losses: focal + PPO/RL; LoRA post-train; layer LRs (encoder 1e-5, head 3e-5).
- NLI ladder (difficulty-ordered): MNLI 392k EN → XNLI 15 langs (ES incl.) →
  ANLI 3 rounds human-and-model-in-the-loop (cc-by-nc-4.0 — NC blocks
  commercial redistribution, internal training use documented as-is) →
  WANLI 108k (GPT-3 pockets + human labels).
- Verification ladder: FEVER 185k (SUP/REF/NEI) → VitaminC `tals/vitaminc`
  (contrastive edits: same evidence, flipped verdict — the SUP+CON pair
  shape) → SciFact (domain) → FaVIQ (`tasksource/faviq`, info-seeking
  questions) → FoolMeTwice (`tasksource/fool-me-twice`, ~13k game-hardened).
- Agent/screen: BIPIA (microsoft, indirect injection, email/table/code/QA) +
  deepset/prompt-injections (binary real texts) + NotInject-style benign
  look-alikes (must be mined, not assumed).
- Abstention literature (DAC / CAN / SelectiveNet 1901.09192): abstention
  must be TRAINED (loss-level), never thresholded post-hoc — matches our
  IDK-head line; KB must therefore contain first-class ABSTAIN rows.

## The exact Regulus KB (7 blocks, ~5200 rows, ES ≥ 40%)

| Block | Sources (exact ids) | Rows | Langs | Lane targets |
|---|---|---|---|---|
| B1 NLI core | `facebook/xnli` ES+EN sample + MNLI-train sample | 900 (300/300/300 E/N/C) | ES 450/EN 450 | gate entail, classify reasoning |
| B2 NLI adversarial | `facebook/anli` r1-r3 EN + ES-mirror post-edit | 600 | EN 400/ES 200 | gate hard, verify refute |
| B3 Verify contrastive | `tals/vitaminc` + `tasksource/fool-me-twice` + `tasksource/faviq` sample | 700 (SUP/CON pairs + NEI) | EN 450/ES 250 | gate SUP+CON pairs, verify |
| B4 Verify scale | `fever/fever` balanced SUP/REF/NEI | 900 | EN 600/ES 300* | gate volume, anchors |
| B5 Screen agents | `deepset/prompt-injections` + BIPIA + mined benign look-alikes + batch4 fillers | 800 (attack/benign 50/50) | EN 450/ES 350 | screen, laya_screen |
| B6 Classify/other | XNLI-neutral pairs + batch4 other-neg + repo-domain bug/feature | 600 | EN 300/ES 300 | classify, other lane |
| B7 Regulus lineage | batch-4 104 + v2-anchors 570 + v3-50 + d3-24 + ABSTAIN-silence bank | 850 | 50/50 | floor hold + abstention |

* ES via post-edit of EN verdict rows (verdict-preserving translation
  protocol: translate evidence+claim, re-verify verdict by second pass;
  rows failing re-verification are dropped, never fixed silently).

Totals: ~5350 rows, ES ~43%, SUP/CON/NEI balanced ±10% inside B3+B4,
ABSTAIN first-class (B2-neutral + B3-NEI + silence bank, never thresholded).

## Shape mapping (GLiClass rows {text, all_labels, true_labels})
- gate SUP/CON: text = evidence + " || " + claim; labels = [supported,
  contradicted, unverifiable]; ABSTAIN rows = true_labels [] (empty).
- screen: text = message/document; labels = [benign, suspicious,
  malicious]; REVIEW golds = suspicious (never a pass, never a block).
- classify: text = item; labels = lane catalog + other (other = real
  negatives, never filler).
- rerank/find: query-as-text vs candidate labels (relevance pairs from
  FEVER evidence links + B6 topic pairs).

## Build rules (worker-enforced, checker-verified)
1. License recorded per row at pull time (ANLI cc-by-nc-4.0 flagged NC;
   FEVER/VitaminC CC-BY-SA typical — verify at download, never assume).
2. 0 overlap vs eval universes (ids + exact + Jaccard + denylist).
3. Verdict-preserving ES protocol for every translated row.
4. Eval-held-out stays held out (r1-60 + v2-80 + batch4-80 never train).
5. v2-pinned separation re-run: new blocks must show v2 wrong-rate above
   chance before they enter the mix (hardness proof, v4 precedent).

## Next step
- User approves this spec → build worker pulls B1–B7 → solidity re-check →
  v6 train (init v2-pinned, IDK, same recipe/bar discipline).
