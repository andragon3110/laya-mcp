"""Regulus-v2 C re-selection (WS-E, run-approved 2026-10-12).

Re-fits the IDK abstention cost C on the batch-4 validation split (80 rows:
the v2d-* rows of batch4-train.jsonl; dist-b4-* d3 rows are train-only),
using STOCK logits (CPU fp32, deterministic, augmentation OFF, no label
shuffle so logits align to candidate order) + ft.idk_loss.compare_objectives
(focal base) — the exact v1 procedure, re-fit, never blindly reused.

Metric (v1-identical): per row, match = (abstain-wins) == (stock-argmax-
currently-misses); select the C with max matches over the grid
[0.005, 0.02, 0.03, 0.05, 0.1, 0.3]; tie-break toward the spike prior 0.02
(v1 rule; v1 selected 0.05 outright at 79/80).

Anchor rows are NOT in the C-select population: C prices abstention on the
target distribution (batch-4 validation); anchors are confident-commit rows
that would inflate matches uniformly without moving the pricing decision.
Recorded, not hidden.

Writes artifacts-ft/mix-regulus-v2/cselect.json (v1-identical shape).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

GRID = [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.3]
TIE_PRIOR = 0.02
STOCK = ("C:/Users/Andragon/.cache/huggingface/hub/models--knowledgator--"
         "gliclass-multilang-mini/snapshots/0bd888b6c3ef9fca5f0a9d407bddfbbc7623486b")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Regulus-v2 C re-selection.")
    ap.add_argument("--mix", default=os.path.join(
        _ROOT, "artifacts-ft", "mix-regulus-v2", "batch4-train.jsonl"))
    ap.add_argument("--out", default=os.path.join(
        _ROOT, "artifacts-ft", "mix-regulus-v2", "cselect.json"))
    ap.add_argument("--checkpoint", default=STOCK)
    args = ap.parse_args(argv)

    import torch
    from torch.utils.data import DataLoader
    from transformers import AutoTokenizer
    from gliclass import GLiClassModel
    from gliclass.data_processing import (
        AugmentationConfig, DataCollatorWithPadding, GLiClassDataset)
    from ft.idk_loss import compare_objectives

    rows = [json.loads(l) for l in open(args.mix, encoding="utf-8") if l.strip()]
    val = [r for r in rows if r["id"].startswith("v2d-")]
    assert len(val) == 80, f"validation split must be 80, got {len(val)}"
    print(f"validation rows: {len(val)}", flush=True)

    examples = [{"text": r["text"], "all_labels": list(r["candidates"]),
                 "true_labels": list(r["labels"]), "prompt": "", "examples": []}
                for r in val]
    tok = AutoTokenizer.from_pretrained(args.checkpoint)
    aug = AugmentationConfig(enabled=False)
    ds = GLiClassDataset(examples, tok, aug, max_length=1024, shuffle_labels=False)
    loader = DataLoader(ds, batch_size=8, shuffle=False, num_workers=0,
                        collate_fn=DataCollatorWithPadding(tok))
    model = GLiClassModel.from_pretrained(args.checkpoint).to("cpu").float()
    model.eval()
    all_logits, all_targets = [], []
    with torch.no_grad():
        for batch in loader:
            targets = batch.pop("labels").float()
            k = int(batch.pop("max_num_classes", 0) or targets.shape[-1])
            logits = model(input_ids=batch["input_ids"],
                           attention_mask=batch.get("attention_mask"),
                           max_num_classes=k).logits.float()
            all_logits.append(logits)
            all_targets.append(targets)
    logits = torch.cat(all_logits)
    targets = torch.cat(all_targets)
    print(f"logits {tuple(logits.shape)} (all K=3: {bool((targets.shape[-1] == 3))})",
          flush=True)

    # stock argmax misses (single-true-label rows)
    true_idx = targets.argmax(dim=-1)
    pred_idx = logits.argmax(dim=-1)
    misses = (pred_idx != true_idx).tolist()

    cands = {}
    for c in GRID:
        cmp_ = compare_objectives(logits, targets, c, base="focal")
        wins = [r["cheaper"] == "abstain" for r in cmp_["rows"]]
        match = sum(1 for w, m in zip(wins, misses) if w == m)
        cands[str(c)] = {"match": match, "match_rate": round(match / len(val), 4),
                         "force_mean": round(cmp_["force_mean"], 6)}
        print(f"C={c}: match {match}/{len(val)} force_mean {cmp_['force_mean']:.6f}",
              flush=True)
    best = max(GRID, key=lambda c: (cands[str(c)]["match"],
                                    -abs(c - TIE_PRIOR)))
    out = {
        "candidates": cands,
        "selected_C": best,
        "note": ("match = abstain-wins == stock-argmax-currently-misses (focal base); "
                 "tie-break toward spike prior 0.02; validation-80 only (anchors excluded, "
                 "recorded rationale); stock CPU-fp32 forwards, augmentation OFF, shuffle OFF"),
        "rows": [
            {"id": r["id"],
             "lane": ("classify" if r["candidates"][0] == "bug"
                      else "gate" if r["candidates"][0] == "SUPPORTED" else "screen"),
             "true": r["labels"][0],
             "top": r["candidates"][int(pred_idx[i])],
             "top_score": float(torch.sigmoid(logits[i])[int(pred_idx[i])]),
             "margin": float((torch.sigmoid(logits[i]).topk(2).values[0]
                              - torch.sigmoid(logits[i]).topk(2).values[1])),
             "miss": bool(misses[i])}
            for i, r in enumerate(val)
        ],
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print(f"selected C = {best} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
