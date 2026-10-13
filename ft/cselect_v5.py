"""Regulus-v5 C re-selection (finetune-r3j-complete v5 round, approved 2026-10-12).

Re-fits the IDK abstention cost C on the SILENCE-HEAVY validation split
(100 rows: 80 batch4 v2d + 20 v5 held-out silences, 40 silences = 40%),
using V2-PINNED logits (CPU fp32, deterministic, augmentation OFF, no label
shuffle so logits align to candidate order) + ft.idk_loss.compare_objectives
(focal base) — the exact v2/v3/v4 procedure, re-fit, never blindly reused.

Metric (v1-identical, extended to empty-true rows): per row, match =
(abstain-wins) == (init-argmax-currently-misses). Empty-true (ABSTAIN) rows
have no argmax hit possible (the init always commits to a label), so they
count as misses by construction: match = abstain-wins on exactly the rows
the v5 round must protect. If C drifts UP vs 0.05, that is the abstention
guard working (more silence mass prices abstention higher), recorded in the
manifest, not a hack.

Anchors + base + v5-train rows are NOT in the C-select population: C prices
abstention on the target distribution; confident-commit rows would inflate
matches uniformly without moving the pricing decision. Recorded, not hidden.

Writes artifacts-ft/mix-regulus-v5/cselect.json (v3-identical shape, re-fit
on the v5 init + heavy split).
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
V2PINNED = os.path.join(_ROOT, "artifacts-ft", "regulus-v2-pinned", "checkpoint")
MIX5 = os.path.join(_ROOT, "artifacts-ft", "mix-regulus-v5")


def _all(r: dict) -> list:
    return list(r.get("candidates", r.get("all_labels", [])))


def _true(r: dict) -> list:
    return list(r.get("labels", r.get("true_labels", [])))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Regulus-v5 C re-selection (heavy split).")
    ap.add_argument("--batch4", default=os.path.join(MIX5, "batch4-train.jsonl"))
    ap.add_argument("--heldout", default=os.path.join(MIX5, "v5-silence-heldout.jsonl"))
    ap.add_argument("--out", default=os.path.join(MIX5, "cselect.json"))
    ap.add_argument("--checkpoint", default=V2PINNED)
    args = ap.parse_args(argv)

    import torch
    from torch.utils.data import DataLoader
    from transformers import AutoTokenizer
    from gliclass import GLiClassModel
    from gliclass.data_processing import (
        AugmentationConfig, DataCollatorWithPadding, GLiClassDataset)
    from ft.idk_loss import compare_objectives

    rows = [json.loads(l) for l in open(args.batch4, encoding="utf-8") if l.strip()]
    val = [r for r in rows if r["id"].startswith("v2d-")]
    assert len(val) == 80, f"batch4 validation split must be 80, got {len(val)}"
    hold = [json.loads(l) for l in open(args.heldout, encoding="utf-8") if l.strip()]
    assert len(hold) == 20, f"v5 held-out must be 20, got {len(hold)}"
    assert all(_true(r) == [] for r in hold), "held-out silences must be empty-true"
    val = val + hold
    n_sil = sum(1 for r in val if _true(r) == [] or _true(r) == ["ABSTAIN"])
    print(f"heavy validation rows: {len(val)} (silences {n_sil})", flush=True)

    examples = [{"text": r["text"], "all_labels": _all(r), "true_labels": _true(r),
                 "prompt": "", "examples": []} for r in val]
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

    # Init-argmax misses. Empty-true rows cannot be hit by argmax (the init
    # always commits): they count as misses by construction, so match =
    # abstain-wins on exactly the silence rows under protection.
    true_idx = targets.argmax(dim=-1)
    pred_idx = logits.argmax(dim=-1)
    empty = [len(_true(r)) == 0 for r in val]
    misses = [(True if e else (bool(p != t)))
              for e, p, t in zip(empty, pred_idx.tolist(), true_idx.tolist())]
    print(f"empty-true rows: {sum(empty)} (all count as init-misses by construction)",
          flush=True)

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
        "note": ("match = abstain-wins == v2-pinned-argmax-currently-misses (focal base); "
                 "empty-true silences count as misses by construction (argmax cannot abstain); "
                 "tie-break toward spike prior 0.02; heavy-100 split only (anchors/base/train "
                 "excluded, recorded rationale); v2-pinned CPU-fp32 forwards, augmentation OFF, "
                 "shuffle OFF"),
        "rows": [
            {"id": r["id"],
             "lane": ("classify" if _all(r)[0] == "bug"
                      else "gate" if _all(r)[0] == "SUPPORTED" else "screen"),
             "true": (_true(r)[0] if _true(r) else "ABSTAIN(empty)"),
             "top": _all(r)[int(pred_idx[i])],
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
