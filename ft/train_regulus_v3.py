"""Regulus-v3 SFT continuation train script (finetune-r3j-complete v3 round, approved 2026-10-12).

Copied from ft/train_regulus_v2.py (which stays byte-intact for provenance) with
the v3-round changes ONLY:
- RECIPE model regulus-v3, NEW seed 20261013 (recorded; v2 used 20261012).
- Mix = v2 mix (104+570, byte copies) + 50 gate-gap rows (44 SUP + 6 other)
  per artifacts-ft/mix-regulus-v3/MIX_README.md; train-time --eval-ids is the
  140-id file (batch-4 + v3 stay in the mix; r1/v2 stay out).
- Per-row candidate sets: each row trains against its OWN candidates as all_labels
  (K=3 lane rows, K=2 relevance rows) with an exact per-row IDK-loss loop sliced
  to each row's true K (no global-union K, no padded-slot loss).
- Warm-start IDK head: --idk-bias-init (default -2.2 -> q ~= 0.1 at step 0;
  v2-identical; the v2-trained head state is inference-irrelevant evidence only).
- Eval-loss dataset runs augmentation OFF (deterministic ABORT signal);
  the train dataset keeps augmentation ON (v1 recipe parity).
- C re-selected on validation-80 for the v3 init (v2-pinned logits,
  ft/cselect_v3.py; value recorded in mix cselect.json).

Recipe preserved: LR 2e-5 x2 epochs, ABORT 0.3, weight 1, batch 8, ctx 1024.
Init: artifacts-ft/regulus-v2-pinned/checkpoint (continuation; r3i still absent).

Safety: defaults to --dry-run (print config + exit, train nothing) and
REFUSES to train without an explicit --confirm flag.
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
    "model": "regulus-v3",
    "lineage": "r3i",
    "base_repo": "knowledgator/gliclass-multilang-mini",
    "lr": 2e-5,
    "epochs": 2,
    "abort_bar": 0.3,
    "weight": 1,
    "seed": 20261013,
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
    p = argparse.ArgumentParser(description="Regulus-v3 SFT continuation (dry-run by default).")
    p.add_argument("--checkpoint", default=os.path.join("artifacts-ft", "regulus-v2-pinned", "checkpoint"),
                   help="LOCAL init checkpoint dir (default: v2-pinned; required to train, never base/stock).")
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
    p.add_argument("--idk-bias-init", type=float, default=-2.2,
                   help="AbstentionHead bias warm-start (default -2.2 -> q~=0.1 at step 0; "
                        "0.0 = v1 zero-init q=0.5).")
    p.add_argument("--seed", type=int, default=RECIPE["seed"])
    p.add_argument("--batch-size", type=int, default=RECIPE["batch_size"])
    p.add_argument("--max-length", type=int, default=RECIPE["max_length"])
    p.add_argument("--run-dir", default=None, help="default: artifacts-ft/run-<stamp>-regulus-v3")
    p.add_argument("--dry-run", action=argparse.BooleanOptionalAction, default=True,
                   help="print resolved config + exit (default ON, trains nothing).")
    p.add_argument("--confirm", action="store_true", default=False,
                   help="explicit approval flag; train refuses to run without it.")
    return p


def resolve_config(args: argparse.Namespace) -> dict:
    run_dir = args.run_dir or os.path.join("artifacts-ft", f"run-{utc_stamp()}-regulus-v3")
    from ft.idk_loss import resolve_abstention_cost  # local: torch import costs seconds on dry-run
    return {
        **RECIPE,
        "objective": "idk-focal manual torch loop (AbstentionHead + ft.idk_loss.idk_loss base='focal'; "
                       "no transformers.Trainer: accelerate absent from py/.venv-ft, dependency install unauthorized)",
        "init_exception": "WS-E v3 round (parent 2026-10-12, approved): init from v2-pinned checkpoint "
                           "(continuation; r3i still absent); lineage tag stays r3i per naming decision",
        "abstention_cost": resolve_abstention_cost(args.abstain_cost),
        "lr": args.lr,
        "epochs": args.epochs,
        "abort_bar": args.abort_bar,
        "weight": args.weight,
        "seed": args.seed,
        "batch_size": args.batch_size,
        "max_length": args.max_length,
        "checkpoint": args.checkpoint,
        "idk_bias_init": args.idk_bias_init,
        "idk_q_init": 1.0 / (1.0 + __import__("math").exp(-float(args.idk_bias_init))),
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
        return refuse(f"--checkpoint missing/not-a-dir: {cfg['checkpoint']!r} (init from a LOCAL checkpoint only)")
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

    # Per-row candidate sets (v2 K-fix extension): each row trains against its OWN
    # candidates as all_labels (K=3 lane rows, K=2 relevance rows). The exact per-row
    # loss loop below slices every row to its true K, so padded slots never enter
    # the loss. (v1 used the global union K=9; that would explode past context with
    # ~120 free-text relevance labels and dilute the lane gradients.)
    examples = [{"text": r["text"], "all_labels": list(r.get("candidates", r.get("labels", []))),
                 "true_labels": list(r.get("labels", [])),
                 "prompt": "", "examples": []} for r in rows]
    for r in rows:
        if not r.get("candidates"):
            return refuse(f"row {r.get('id')!r} carries no explicit candidates (K-fix: every row must)")
    k_dist: dict[int, int] = {}
    for r in rows:
        k_dist[len(r["candidates"])] = k_dist.get(len(r["candidates"]), 0) + 1
    tokenizer = AutoTokenizer.from_pretrained(cfg["checkpoint"])
    dataset = GLiClassDataset(examples, tokenizer, AugmentationConfig(),
                              max_length=cfg["max_length"])
    # Eval-loss dataset: augmentation OFF for a deterministic ABORT signal
    # (instrumentation choice; the train dataset keeps augmentation ON, v1 parity).
    eval_dataset = GLiClassDataset(examples, tokenizer, AugmentationConfig(enabled=False),
                                   max_length=cfg["max_length"], shuffle_labels=False)
    model = GLiClassModel.from_pretrained(cfg["checkpoint"])
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).float()  # full-SFT fp32 (bf16 params + AdamW is unsound)
    print(f"train: dtype={next(model.parameters()).dtype} device={device} "
          f"per-row K dist={k_dist}", flush=True)
    head = AbstentionHead(bias_init=cfg["idk_bias_init"]).to(device).float()
    with torch.no_grad():
        q0 = float(torch.sigmoid(head(torch.zeros(1, 3, device=device))).item())
    print(f"idk head warm-start: bias={cfg['idk_bias_init']} q_init={q0:.4f}", flush=True)

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
        # Exact per-row loop: slice each row to its TRUE K (from the unpadded
        # labels_text string lists) so collator-padded slots never enter the loss.
        # batch["labels_text"] is skipped by to_device (strings stay on host).
        true_ks = [len(lt) for lt in batch["labels_text"]]
        b = to_device(batch)
        targets = b.pop("labels").float()
        k = int(b.pop("max_num_classes", 0) or targets.shape[-1])
        logits = model(input_ids=b["input_ids"],
                       attention_mask=b.get("attention_mask"),
                       max_num_classes=k).logits.float()
        parts = []
        for i, ki in enumerate(true_ks):
            li = logits[i, :ki].unsqueeze(0)
            ti = targets[i, :ki].unsqueeze(0)
            loss_i, _ = idk_loss(li, ti, head(li.detach()),
                                  cfg["abstention_cost"], "focal")
            parts.append(loss_i)
        return torch.stack(parts).mean()

    @torch.no_grad()
    def eval_loss() -> float:
        model.eval()
        tot, n = 0.0, 0
        ev_loader = DataLoader(eval_dataset, batch_size=cfg["batch_size"], shuffle=False,
                               num_workers=0, collate_fn=collator)
        for batch in ev_loader:
            tot += float(batch_loss_nograd(batch)) * len(batch["input_ids"])
            n += len(batch["input_ids"])
        model.train()
        return tot / max(n, 1)

    @torch.no_grad()
    def batch_loss_nograd(batch: dict) -> torch.Tensor:
        return batch_loss(batch)

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
        "idk_bias_init": cfg["idk_bias_init"],
        "idk_q_init": cfg["idk_q_init"],
        "seed": cfg["seed"],
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
