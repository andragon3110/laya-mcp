"""Regulus-v1 SFT continuation train script (WS-A F0 infra, recovered from phase2 recipes).

Recipe source: odd/tasks/phase2-r3f-train.md + phase2-r3i-distill.md
  (mix shape, LR 2e-5 x2 epochs, ABORT 0.3, eval-ids excluded, weight 1)
  + odd/tasks/spike-g3-backbones.md R3T5 (gliclass training module notes).

Lineage: continuation SFT from a LOCAL r3i checkpoint (never base/stock).
  model: regulus-v1, lineage: r3i. Run-dir: artifacts-ft/run-<stamp>-regulus-v1.

Safety: defaults to --dry-run (print config + exit, train nothing) and
REFUSES to train without an explicit --confirm flag. F0 never executes
the train path; WS-E (F3) owns the single approved run.

Prior-art note: ft/__pycache__/train_lora.*.pyc is a causal-LM LoRA script
(AutoModelForCausalLM, --batch/--lr/--seed/--eval-every CLI) from the Laya
lineage -- NOT reusable for GLiClass. This file is a rewrite against the
gliclass==0.1.20 training module API (verified in F0):
  gliclass.training.Trainer / TrainingArguments (+EWC fields),
  RLTrainer(reward_components=[...]) custom-reward hook for the F2
  IDK-loss spike, gliclass.loss_functions.focal_loss_with_logits,
  GLiClassDataset + DataCollatorWithPadding + AugmentationConfig.
  LoRA: load-only guard in gliclass/model.py (needs peft, NOT installed
  in py/.venv-ft) -- no LoRA training helper exists. Full SFT fp32.

Mix row schema (jsonl, one object per line):
  {"id": str, "text": str, "labels": [str, ...], "source": "batch4|replay|anchor"}
ABSTAIN-by-construction rows (gate silences) carry "labels": [] -- the
lineage convention: no positive label teaches low scores, the handler
abstains. Eval-ids file: txt (one id per line) or jsonl with {"id"} rows.

WS-E regulus-v1 resolved path (2026-10-12, parent proceed-to-finish order):
- Init from cached gliclass-stock snapshot rev 0bd888b (r3i absent on this
  machine; recorded in manifest, never claimed as r3i).
- Mix = ft/batch4 SIGNED rows only (104: 20 classify-other + 20 gate-silence
  + 40 screen-filler + 24 d3-distill-construction-ABSTAIN); replay/anchors
  (~600, external worktree) ABSENT on disk -- recorded in MIX_README, no
  substitute invented. Eval-ids = 140 r1+v2 ids (0 overlap with batch-4).
- Lane-faithful text mapping (mirrors evals/lanes-r1.mjs construction):
  classify text=item text true=[other]; gate text="evidence || claim"
  true=[ABSTAIN] (argmax-ABSTAIN is the measured abstention path);
  screen text=input.text true=[suspicious] (REVIEW reachable only via
  suspicious-0.5; assessment 'irrelevant' needs the low-substance leg the
  lane pins at constant 0.9 -- structurally unreachable, recorded ceiling).
- Objective: CAN-style IDK loss (ft/idk_loss.py, focal base) with C
  re-selected on the batch-4 validation split (C=0.05, match 79/80) --
  plain cross-entropy forbidden as sole objective (proven exhausted).
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import random
import sys

# Repo-root on sys.path so `from ft.idk_loss import ...` works whether this
# script runs as `python ft/train_regulus_v1.py` (sys.path[0]=ft/) or as a
# module. Import-time side effects: none (stdlib only here).
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

RECIPE = {
    "model": "regulus-v1",
    "lineage": "r3i",
    "base_repo": "knowledgator/gliclass-multilang-mini",
    "lr": 2e-5,
    "epochs": 2,
    "abort_bar": 0.3,
    "weight": 1,
    "seed": 1337,
    "batch_size": 8,
    "max_length": 1024,
}
FORBIDDEN = "weight>1, init-from-base/stock, eval-ids-in-mix, tuning-on-r1"


def utc_stamp() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_ids(path: str) -> set[str]:
    ids: set[str] = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("{"):
                try:
                    ids.add(str(json.loads(line)["id"]))
                    continue
                except (KeyError, ValueError):
                    pass
            ids.add(line)
    return ids


def load_rows(path: str) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError as e:
                raise SystemExit(f"bad jsonl {path}:{lineno}: {e}")
    return rows


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Regulus-v1 SFT continuation (dry-run by default).")
    p.add_argument("--checkpoint", default=None,
                   help="LOCAL r3i checkpoint dir (required to train, never base/stock).")
    p.add_argument("--mix", action="append", default=[],
                   help="jsonl mix file (repeatable: batch4 + replay + anchors).")
    p.add_argument("--eval-ids", default=None, help="eval-ids file (txt or jsonl) excluded from mix.")
    p.add_argument("--lr", type=float, default=RECIPE["lr"])
    p.add_argument("--epochs", type=int, default=RECIPE["epochs"])
    p.add_argument("--abort-bar", type=float, default=RECIPE["abort_bar"],
                   help="ABORT if eval_loss - baseline > bar (r3 lineage bar 0.3).")
    p.add_argument("--weight", type=float, default=RECIPE["weight"],
                   help="replay/anchor weight; must be <= 1 (recipe weight 1).")
    p.add_argument("--abstain-cost", default=None,
                   help="IDK abstention cost C (CLI > env REGULUS_ABSTAIN_COST > spike default 0.3). "
                        "WS-E passes the validation-selected C explicitly (0.05 on the focal base).")
    p.add_argument("--seed", type=int, default=RECIPE["seed"])
    p.add_argument("--batch-size", type=int, default=RECIPE["batch_size"])
    p.add_argument("--max-length", type=int, default=RECIPE["max_length"])
    p.add_argument("--run-dir", default=None, help="default: artifacts-ft/run-<stamp>-regulus-v1")
    p.add_argument("--dry-run", action=argparse.BooleanOptionalAction, default=True,
                   help="print resolved config + exit (default ON, trains nothing).")
    p.add_argument("--confirm", action="store_true", default=False,
                   help="explicit approval flag; train refuses to run without it.")
    return p


def resolve_config(args: argparse.Namespace) -> dict:
    run_dir = args.run_dir or os.path.join("artifacts-ft", f"run-{utc_stamp()}-regulus-v1")
    from ft.idk_loss import resolve_abstention_cost  # local: torch import costs seconds on dry-run
    return {
        **RECIPE,
        "objective": "idk-focal manual torch loop (AbstentionHead + ft.idk_loss.idk_loss base='focal'; "
                       "no transformers.Trainer: accelerate absent from py/.venv-ft, dependency install unauthorized)",
        "init_exception": "WS-E resolved path (parent 2026-10-12): init from cached gliclass-stock snapshot rev "
                           "0bd888b (r3i checkpoint absent on this machine); lineage tag stays r3i per naming decision",
        "abstention_cost": resolve_abstention_cost(args.abstain_cost),
        "lr": args.lr,
        "epochs": args.epochs,
        "abort_bar": args.abort_bar,
        "weight": args.weight,
        "seed": args.seed,
        "batch_size": args.batch_size,
        "max_length": args.max_length,
        "checkpoint": args.checkpoint,
        "mix": args.mix,
        "eval_ids": args.eval_ids,
        "run_dir": run_dir,
        "forbidden": FORBIDDEN,
        "dry_run": args.dry_run,
        "confirm": args.confirm,
    }


def refuse(msg: str) -> int:
    print(f"REFUSE: {msg}", file=sys.stderr)
    return 2


def run_train(cfg: dict) -> int:
    # Heavy imports ONLY on the confirmed train path (dry-run stays light).
    # NOTE (WS-E): transformers.Trainer is UNAVAILABLE (no `accelerate` in
    # py/.venv-ft; installing it would be unauthorized dependency mutation),
    # so the loop below is manual torch (AdamW + linear decay, same recipe
    # hyperparams) with mathematically identical per-row IDK math
    # (AbstentionHead + ft.idk_loss.idk_loss focal) -- no plain-SFT fallback.
    import time

    import numpy as np
    import torch
    from torch.utils.data import DataLoader
    from transformers import AutoTokenizer, set_seed
    from gliclass import GLiClassModel
    from gliclass.data_processing import (
        AugmentationConfig,
        DataCollatorWithPadding,
        DataAugmenter,  # noqa: F401 (re-exported for F2 spike use)
        GLiClassDataset,
    )
    from ft.idk_loss import AbstentionHead, idk_loss

    if not cfg["checkpoint"] or not os.path.isdir(cfg["checkpoint"]):
        return refuse(f"--checkpoint missing/not-a-dir: {cfg['checkpoint']!r} (init from LOCAL r3i only)")
    if not cfg["mix"]:
        return refuse("empty --mix (need batch4 + replay + anchors jsonl files)")
    if cfg["weight"] > 1:
        return refuse(f"--weight {cfg['weight']} > 1 forbidden (recipe weight 1)")

    eval_ids: set[str] = load_ids(cfg["eval_ids"]) if cfg["eval_ids"] else set()
    rows: list[dict] = []
    manifest = []
    for path in cfg["mix"]:
        file_rows = load_rows(path)
        kept = [r for r in file_rows if str(r.get("id")) not in eval_ids]
        manifest.append({"file": path, "sha256": sha256_file(path),
                         "rows": len(file_rows), "kept": len(kept),
                         "dropped_eval_ids": len(file_rows) - len(kept)})
        rows.extend(kept)
    if not rows:
        return refuse("mix empty after eval-id exclusion")

    # weight 1 = plain concatenation (no upsampling); anything else in (0,1]
    # subsamples replay/anchor sources deterministically under the fixed seed.
    if cfg["weight"] < 1:
        rng = random.Random(cfg["seed"])
        rows = [r for r in rows
                if r.get("source") == "batch4" or rng.random() < cfg["weight"]]

    set_seed(cfg["seed"])
    random.seed(cfg["seed"])
    np.random.seed(cfg["seed"])
    torch.manual_seed(cfg["seed"])
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(cfg["seed"])
        torch.cuda.reset_peak_memory_stats()
    wall_t0 = time.time()

    os.makedirs(cfg["run_dir"], exist_ok=True)
    with open(os.path.join(cfg["run_dir"], "config.json"), "w", encoding="utf-8") as f:
        json.dump({**cfg, "manifest": manifest, "mix_rows": len(rows)}, f, indent=2)

    # all_labels = union of per-row CANDIDATE sets (lane-faithful K); falls
    # back to true "labels" for mixes without candidates. (Union-of-trues
    # alone collapses K to {ABSTAIN, other, suspicious} and drops the lane
    # negatives -- found in the failed first attempt, fixed before any run.)
    label_set = sorted({lb for r in rows for lb in r.get("candidates", r.get("labels", []))})
    examples = [{"text": r["text"], "all_labels": list(label_set),
                 "true_labels": list(r.get("labels", [])),
                 "prompt": "", "examples": []} for r in rows]
    tokenizer = AutoTokenizer.from_pretrained(cfg["checkpoint"])
    dataset = GLiClassDataset(examples, tokenizer, AugmentationConfig(),
                              max_length=cfg["max_length"])
    model = GLiClassModel.from_pretrained(cfg["checkpoint"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).float()  # full-SFT fp32 (bf16 params + AdamW is unsound)
    print(f"train: dtype={next(model.parameters()).dtype} device={device} "
          f"K={len(label_set)} labels={label_set}", flush=True)
    head = AbstentionHead().to(device).float()

    collator = DataCollatorWithPadding(tokenizer)
    gen = torch.Generator().manual_seed(cfg["seed"])
    loader = DataLoader(dataset, batch_size=cfg["batch_size"], shuffle=True,
                        num_workers=0, collate_fn=collator, generator=gen)
    opt = torch.optim.AdamW(list(model.parameters()) + list(head.parameters()),
                            lr=cfg["lr"], weight_decay=0.0)
    steps_per_epoch = len(loader)
    total_steps = steps_per_epoch * cfg["epochs"]

    def to_device(batch: dict) -> dict:
        out = {}
        for k, v in batch.items():
            if k in ("labels_text", "input_texts"):
                continue
            out[k] = v.to(device) if isinstance(v, torch.Tensor) else v
        return out

    def batch_loss(batch: dict) -> torch.Tensor:
        b = to_device(batch)
        targets = b.pop("labels").float()
        k = int(b.pop("max_num_classes", 0) or targets.shape[-1])
        logits = model(input_ids=b["input_ids"],
                       attention_mask=b.get("attention_mask"),
                       max_num_classes=k).logits.float()
        loss, _ = idk_loss(logits, targets, head(logits.detach()),
                           cfg["abstention_cost"], "focal")
        return loss

    @torch.no_grad()
    def eval_loss() -> float:
        model.eval()
        tot, n = 0.0, 0
        ev_loader = DataLoader(dataset, batch_size=cfg["batch_size"], shuffle=False,
                               num_workers=0, collate_fn=collator)
        for batch in ev_loader:
            tot += float(batch_loss(batch)) * len(batch["input_ids"])
            n += len(batch["input_ids"])
        model.train()
        return tot / max(n, 1)

    print(f"objective: manual IDK loop, focal base, C={cfg['abstention_cost']} "
          f"({steps_per_epoch} steps/epoch x {cfg['epochs']} = {total_steps} steps)", flush=True)
    model.train()
    baseline = None
    history: list[dict] = []
    aborted = False
    step = 0
    for epoch in range(1, cfg["epochs"] + 1):
        for batch in loader:
            loss = batch_loss(batch)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            step += 1
            lr = cfg["lr"] * max(0.0, 1.0 - step / total_steps)  # linear decay, warmup 0
            for pg in opt.param_groups:
                pg["lr"] = lr
            if step % 10 == 0 or step == total_steps:
                print(f"epoch {epoch} step {step}/{total_steps} loss {float(loss):.4f} "
                      f"lr {lr:.2e}", flush=True)
        ev = eval_loss()
        if baseline is None:
            baseline = ev
        delta = ev - baseline
        history.append({"epoch": epoch, "eval_loss": ev, "delta_vs_baseline": delta})
        print(f"eval epoch {epoch}: loss {ev:.4f} delta {delta:+.4f} "
              f"(bar {cfg['abort_bar']})", flush=True)
        if delta > cfg["abort_bar"]:
            print(f"ABORT: eval_loss {ev:.4f} exceeds baseline {baseline:.4f} + "
                  f"bar {cfg['abort_bar']}", flush=True)
            aborted = True
            break

    ckpt = os.path.join(cfg["run_dir"], "checkpoint")
    model.save_pretrained(ckpt)
    tokenizer.save_pretrained(ckpt)
    torch.save(head.state_dict(), os.path.join(cfg["run_dir"], "idk_head.pt"))
    stats = {
        "wall_seconds": round(time.time() - wall_t0, 1),
        "vram_peak_gb": round(torch.cuda.max_memory_allocated() / (1 << 30), 3)
        if torch.cuda.is_available() else None,
        "vram_reserved_peak_gb": round(torch.cuda.max_memory_reserved() / (1 << 30), 3)
        if torch.cuda.is_available() else None,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
        "eval_baseline": baseline,
        "eval_history": history,
        "aborted": aborted,
        "abstention_cost": cfg["abstention_cost"],
        "objective": "idk-focal manual torch loop (AbstentionHead + idk_loss focal; no accelerate in venv-ft)",
    }
    with open(os.path.join(cfg["run_dir"], "train_stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)
    print(json.dumps(stats, indent=2), flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_args().parse_args(argv)
    cfg = resolve_config(args)
    if args.dry_run:
        mix_counts = []
        if cfg["mix"]:
            eval_ids: set[str] = load_ids(cfg["eval_ids"]) if cfg["eval_ids"] else set()
            for path in cfg["mix"]:
                try:
                    file_rows = load_rows(path)
                except (OSError, SystemExit) as e:
                    mix_counts.append({"file": path, "error": str(e)})
                    continue
                kept = [r for r in file_rows if str(r.get("id")) not in eval_ids]
                mix_counts.append({"file": path, "rows": len(file_rows), "kept": len(kept),
                                   "dropped_eval_ids": len(file_rows) - len(kept)})
            cfg["mix_counts"] = mix_counts
            cfg["mix_rows_kept"] = sum(m.get("kept", 0) for m in mix_counts)
        print(json.dumps(cfg, indent=2))
        print("dry-run: config printed, nothing trained.")
        return 0
    if not args.confirm:
        return refuse("train requires explicit --confirm (default is --dry-run).")
    return run_train(cfg)


if __name__ == "__main__":
    raise SystemExit(main())
