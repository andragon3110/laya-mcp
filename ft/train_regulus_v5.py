"""Regulus-v5 SFT continuation train script (finetune-r3j-complete v5 round, approved 2026-10-12).

Copied from ft/train_regulus_v4.py (which stays byte-intact for provenance) with
the v5-round changes ONLY:
- RECIPE model regulus-v5, NEW seed 20261015 (recorded; v4 used 20261014).
- Mix = v5 correction mix (2244 train rows after 220-exclusion) per
  artifacts-ft/mix-regulus-v5/MIX_README.md: 24 d3 + 570 anchors (v2 byte
  copies) + 600 fever + 750 xnli-es + 200 xnli-en (base-v4 copies; prose
  screen rows DROPPED per v4 lesson, v3-50 NOT CARRIED per v3 lesson) +
  50 v5-silence + 50 v5-screen (new delta); 20 v5-silence-heldout NEVER
  in train (silence-heavy validation with batch4-80).
  train-time --eval-ids is the 220-id universe file (batch-4 80 + r1 60 +
  v2 80 all HELD OUT, v4 pattern; d3 train-only stays in).
- Dual-schema rows: all_labels = candidates/all_labels, true = labels/true_labels;
  empty positives (new ABSTAIN true_labels=[]) map to all-zero targets
  (abstain target, never a label id; GLiClassDataset-verified); legacy
  labels=["ABSTAIN"] still maps to ABSTAIN=1. K-fix: every row must carry
  explicit candidates/all_labels (refuse otherwise), empty true allowed.
- Per-row candidate sets: each row trains against its OWN set as all_labels
  (K=3 lane rows, K=2 relevance rows) with an exact per-row IDK-loss loop sliced
  to each row's true K (no global-union K, no padded-slot loss).
- Warm-start IDK head: --idk-bias-init (default -2.2 -> q ~= 0.1 at step 0;
  v2/v3-identical; the v2-trained head state is inference-irrelevant evidence only).
- Eval-loss dataset runs augmentation OFF (deterministic ABORT signal);
  the train dataset keeps augmentation ON (v1 recipe parity).
- C re-selected on heavy-100 validation for the v5 init (v2-pinned logits,
  artifacts-ft/mix-regulus-v5/cselect.json; value recorded in mix cselect.json).

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
import threading
import time

# Repo-root on sys.path so `from ft.idk_loss import ...` works whether this
# script runs as `python ft/train_regulus_v1.py` (sys.path[0]=ft/) or as a
# module. Import-time side effects: none (stdlib only here).
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

RECIPE = {
    "model": "regulus-v5",
    "lineage": "r3i",
    "base_repo": "knowledgator/gliclass-multilang-mini",
    "lr": 2e-5,
    "epochs": 2,
    "abort_bar": 0.3,
    "weight": 1,
    "seed": 20261015,
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


# Hang-hardening (v4 retry): timestamped logging + wall-clock watchdog.
# Every stage calls log(); the watchdog thread fails LOUD (exit 3 + reason
# + last stage) if no progress for --watchdog-secs, instead of hanging.
_WD = {"last": 0.0, "stage": "init", "secs": 1200, "armed": False}


def log(msg: str) -> None:
    _WD["last"] = time.time()
    _WD["stage"] = msg
    print(f"[{datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S')}] {msg}",
          flush=True)


def _watchdog_loop() -> None:
    while _WD["armed"]:
        time.sleep(15)
        if not _WD["armed"]:
            break
        idle = time.time() - _WD["last"]
        if idle > _WD["secs"]:
            print(f"WATCHDOG STALLED: no progress for {idle:.0f}s (limit {_WD['secs']}s) "
                  f"at stage: {_WD['stage']} -- failing LOUD instead of hanging",
                  file=sys.stderr, flush=True)
            sys.stdout.flush()
            os._exit(3)


def start_watchdog(secs: int) -> None:
    _WD["secs"] = secs
    _WD["last"] = time.time()
    _WD["armed"] = True
    threading.Thread(target=_watchdog_loop, name="train-watchdog",
                     daemon=True).start()


def stop_watchdog() -> None:
    _WD["armed"] = False


def build_args() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Regulus-v5 SFT continuation (dry-run by default).")
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
    p.add_argument("--micro-batch-size", type=int, default=None,
                   help="CUDA micro-batch (default: equals --batch-size, no accumulation). "
                        "v4 rows are ~5-12x longer than v1-v3 rows; micro 4 + accum 2 keeps the "
                        "recipe-effective batch 8 while halving activation VRAM. Effective batch "
                        "(= micro x accum) is what the recipe constrains.")
    p.add_argument("--max-length", type=int, default=RECIPE["max_length"])
    p.add_argument("--run-dir", default=None, help="default: artifacts-ft/run-<stamp>-regulus-v5")
    p.add_argument("--watchdog-secs", type=int, default=1200,
                   help="wall-clock stall limit with zero progress before LOUD exit(3) (default 1200s).")
    p.add_argument("--max-text-chars", type=int, default=8000,
                   help="rows with longer text are QUARANTINED by id with evidence (default 8000; "
                        "observed mix max is 2400, so this only catches malformed/huge rows).")
    p.add_argument("--smoke-only", action="store_true", default=False,
                   help="run the 8-row 2-step end-to-end smoke + ABSTAIN-empty probe, then exit 0 "
                        "without the full run (no run-dir writes).")
    p.add_argument("--dry-run", action=argparse.BooleanOptionalAction, default=True,
                   help="print resolved config + exit (default ON, trains nothing).")
    p.add_argument("--confirm", action="store_true", default=False,
                   help="explicit approval flag; train refuses to run without it.")
    return p


def resolve_config(args: argparse.Namespace) -> dict:
    run_dir = args.run_dir or os.path.join("artifacts-ft", f"run-{utc_stamp()}-regulus-v5")
    from ft.idk_loss import resolve_abstention_cost  # local: torch import costs seconds on dry-run
    return {
        **RECIPE,
        "objective": "idk-focal manual torch loop (AbstentionHead + ft.idk_loss.idk_loss base='focal'; "
                       "no transformers.Trainer: accelerate absent from py/.venv-ft, dependency install unauthorized)",
        "init_exception": "WS-E v5 round (parent 2026-10-12, approved): init from v2-pinned checkpoint "
                           "(continuation; r3i still absent); lineage tag stays r3i per naming decision",
        "abstention_cost": resolve_abstention_cost(args.abstain_cost),
        "lr": args.lr,
        "epochs": args.epochs,
        "abort_bar": args.abort_bar,
        "weight": args.weight,
        "seed": args.seed,
        "batch_size": args.batch_size,
        "micro_batch_size": args.micro_batch_size or args.batch_size,
        "max_length": args.max_length,
        "checkpoint": args.checkpoint,
        "watchdog_secs": args.watchdog_secs,
        "max_text_chars": args.max_text_chars,
        "smoke_only": args.smoke_only,
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

    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass
    start_watchdog(int(cfg.get("watchdog_secs", 1200)))
    log(f"v4 train start: mix files={len(cfg['mix'])} seed={cfg['seed']} "
        f"C={cfg['abstention_cost']} watchdog={cfg.get('watchdog_secs', 1200)}s "
        f"mode={'smoke-only' if cfg.get('smoke_only') else 'smoke-then-full'}")

    # Dual-schema accessors (v4-critical flag a): legacy reusable rows use
    # {candidates, labels}; new base-v4 rows use {all_labels, true_labels}
    # with ABSTAIN as true_labels=[] (empty positives).
    def _all(r: dict) -> list:
        v = r.get("candidates", r.get("all_labels", r.get("labels", [])))
        return list(v) if v is not None else []

    def _true(r: dict) -> list:
        v = r.get("labels", r.get("true_labels", []))
        return list(v) if v is not None else []

    eval_ids: set[str] = load_ids(cfg["eval_ids"]) if cfg["eval_ids"] else set()
    log(f"eval-ids loaded: {len(eval_ids)} held-out ids")
    rows: list[dict] = []
    manifest = []
    for path in cfg["mix"]:
        t0 = time.time()
        file_rows = load_rows(path)
        kept = [r for r in file_rows if str(r.get("id")) not in eval_ids]
        manifest.append({"file": path, "sha256": sha256_file(path),
                         "rows": len(file_rows), "kept": len(kept),
                         "dropped_eval_ids": len(file_rows) - len(kept)})
        rows.extend(kept)
        log(f"mix file {path}: rows={len(file_rows)} kept={len(kept)} "
            f"dropped_eval={len(file_rows) - len(kept)} ({time.time() - t0:.1f}s)")
    if not rows:
        return refuse("mix empty after eval-id exclusion")
    log(f"mix total after eval-id exclusion: {len(rows)} rows")

    # Row validation + QUARANTINE (v4 hang-fix): per-row audit with progress
    # every 500 rows. Malformed/huge rows are quarantined BY ID with evidence
    # (never silently dropped, never whole files).
    max_chars = int(cfg.get("max_text_chars", 8000))
    kept_rows: list[dict] = []
    quarantined: list[dict] = []
    max_len, tot_len = 0, 0
    for i, r in enumerate(rows):
        if (i + 1) % 500 == 0 or (i + 1) == len(rows):
            log(f"prep validate row {i + 1}/{len(rows)} kept={len(kept_rows)} "
                f"quarantined={len(quarantined)}")
        rid = str(r.get("id"))
        text = r.get("text")
        a, t = _all(r), _true(r)
        reason = None
        if not isinstance(text, str) or not text.strip():
            reason = "empty-text"
        elif len(text) > max_chars:
            reason = f"huge-text>{max_chars}"
        elif len(a) < 2 or len(a) > 10:
            reason = f"K-out-of-range({len(a)})"
        if reason is not None:
            quarantined.append({"id": rid, "reason": reason,
                                "text_len": len(text) if isinstance(text, str) else -1,
                                "K": len(a), "true": t})
        else:
            kept_rows.append(r)
            tot_len += len(text)
            max_len = max(max_len, len(text))
    rows = kept_rows
    log(f"validation done: kept={len(rows)} quarantined={len(quarantined)} "
        f"text_len avg={tot_len // max(len(rows), 1)} max={max_len}")
    for q in quarantined:
        log(f"QUARANTINE id={q['id']} reason={q['reason']} "
            f"text_len={q['text_len']} K={q['K']}")
    if not rows:
        return refuse("mix empty after quarantine (all rows quarantined; see log)")

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

    if not cfg.get("smoke_only"):
        os.makedirs(cfg["run_dir"], exist_ok=True)
        with open(os.path.join(cfg["run_dir"], "config.json"), "w", encoding="utf-8") as f:
            json.dump({**cfg, "manifest": manifest, "mix_rows": len(rows),
                       "quarantined": quarantined}, f, indent=2)
        if quarantined:
            with open(os.path.join(cfg["run_dir"], "quarantine.jsonl"), "w", encoding="utf-8") as f:
                for q in quarantined:
                    f.write(json.dumps(q) + "\n")
        log(f"config written: {cfg['run_dir']} mix_rows={len(rows)} "
            f"quarantined={len(quarantined)}")
    else:
        log("smoke-only: skipping run-dir/config writes")

    # Per-row candidate sets (v2 K-fix extension): each row trains against its OWN
    # candidates as all_labels (K=3 lane rows, K=2 relevance rows). The exact per-row
    # loss loop below slices every row to its true K, so padded slots never enter
    # the loss. (v1 used the global union K=9; that would explode past context with
    # ~120 free-text relevance labels and dilute the lane gradients.)
    # Empty true positives map to all-zero targets (abstain target, never a label
    # id; the ABSTAIN-EMPTY probe below re-verifies this on the new schema).
    # K-fix: every row must carry explicit candidates/all_labels (post-quarantine
    # rows all have K in [2,10], so this refuse is a second LOUD guard, not a hang).
    log(f"building {len(rows)} examples (progress per 500)")
    examples = []
    for i, r in enumerate(rows):
        examples.append({"text": r["text"], "all_labels": _all(r),
                         "true_labels": _true(r),
                         "prompt": "", "examples": []})
        if (i + 1) % 500 == 0 or (i + 1) == len(rows):
            log(f"prep examples {i + 1}/{len(rows)}")
    for r in rows:
        if not _all(r):
            return refuse(f"row {r.get('id')!r} carries no explicit candidates/all_labels (K-fix: every row must)")
    k_dist: dict[int, int] = {}
    for r in rows:
        k_dist[len(_all(r))] = k_dist.get(len(_all(r)), 0) + 1
    log(f"per-row K dist={k_dist}")
    t_stage = time.time()
    log(f"STAGE tokenizer load from {cfg['checkpoint']}")
    tokenizer = AutoTokenizer.from_pretrained(cfg["checkpoint"])
    log(f"STAGE tokenizer ready ({time.time() - t_stage:.1f}s)")
    collator = DataCollatorWithPadding(tokenizer)

    # ABSTAIN-EMPTY probe (v4-critical flag): the first new-schema row with
    # true_labels=[] must tokenize to all-zero targets (abstain target, never
    # a label id). LOUD refuse on violation, with observed evidence.
    probe_rows = [r for r in rows if "true_labels" in r and not (r.get("true_labels") or [])]
    if probe_rows:
        pr = probe_rows[0]
        probe_ds = GLiClassDataset(
            [{"text": pr["text"], "all_labels": _all(pr), "true_labels": [],
              "prompt": "", "examples": []}],
            tokenizer, AugmentationConfig(enabled=False),
            max_length=cfg["max_length"], shuffle_labels=False)
        item = probe_ds[0]
        lab = item.get("labels")
        lab_sum = float(torch.as_tensor(lab).float().sum()) if lab is not None else None
        log(f"ABSTAIN-EMPTY probe id={pr.get('id')} keys={sorted(item.keys())} "
            f"labels_sum={lab_sum} (expect 0.0)")
        if lab is None or lab_sum != 0.0:
            stop_watchdog()
            return refuse(f"ABSTAIN-EMPTY probe FAILED on {pr.get('id')}: "
                          f"keys={sorted(item.keys())} labels_sum={lab_sum}")
        log("ABSTAIN-EMPTY-OK: empty true_labels -> all-zero targets")
    else:
        log("ABSTAIN-EMPTY probe: no new-schema empty-true rows in mix (unexpected)")

    t_stage = time.time()
    log(f"STAGE model load from {cfg['checkpoint']}")
    model = GLiClassModel.from_pretrained(cfg["checkpoint"])
    log(f"STAGE model loaded ({time.time() - t_stage:.1f}s)")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    t_stage = time.time()
    log(f"STAGE model to {device} (fp32 full-SFT)")
    model.to(device).float()  # full-SFT fp32 (bf16 params + AdamW is unsound)
    log(f"train: dtype={next(model.parameters()).dtype} device={device} "
        f"per-row K dist={k_dist} (move took {time.time() - t_stage:.1f}s)")
    head = AbstentionHead(bias_init=cfg["idk_bias_init"]).to(device).float()
    with torch.no_grad():
        q0 = float(torch.sigmoid(head(torch.zeros(1, 3, device=device))).item())
    log(f"idk head warm-start: bias={cfg['idk_bias_init']} q_init={q0:.4f}")
    opt = torch.optim.AdamW(list(model.parameters()) + list(head.parameters()),
                            lr=cfg["lr"], weight_decay=0.0)

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
    def batch_loss_nograd(batch: dict) -> torch.Tensor:
        return batch_loss(batch)

    # SMOKE (hang-fix): 8-row end-to-end mini-batch, 2 optimizer steps, BEFORE
    # the full run. Exercises tokenize -> collate -> forward -> per-row IDK
    # loss -> backward -> step on the REAL model/head/opt. --smoke-only exits
    # 0 right after (no full run, no run-dir writes).
    log("STAGE smoke: 8 rows x 2 steps end-to-end")
    t_smoke = time.time()
    smoke_ds = GLiClassDataset(examples[:8], tokenizer, AugmentationConfig(enabled=False),
                               max_length=cfg["max_length"], shuffle_labels=False)
    smoke_loader = DataLoader(smoke_ds, batch_size=4, shuffle=False,
                              num_workers=0, collate_fn=collator)
    model.train()
    smoke_losses: list[float] = []
    sit = iter(smoke_loader)
    for s in range(1, 3):
        try:
            sb = next(sit)
        except StopIteration:
            sit = iter(smoke_loader)
            sb = next(sit)
        sloss = batch_loss(sb)
        opt.zero_grad(set_to_none=True)
        sloss.backward()
        opt.step()
        smoke_losses.append(float(sloss))
        log(f"SMOKE step {s}/2 loss {float(sloss):.4f} ({time.time() - t_smoke:.1f}s wall)")
    log(f"SMOKE OK: losses={[round(v, 4) for v in smoke_losses]} "
        f"({time.time() - t_smoke:.1f}s wall)")
    if cfg.get("smoke_only"):
        log("SMOKE-ONLY: exiting 0, no full run, no run-dir writes")
        stop_watchdog()
        return 0

    t_stage = time.time()
    log(f"STAGE full train dataset ({len(examples)} rows, augmentation ON)")
    dataset = GLiClassDataset(examples, tokenizer, AugmentationConfig(),
                              max_length=cfg["max_length"])
    log(f"STAGE train dataset ready ({time.time() - t_stage:.1f}s)")
    # Eval-loss dataset: augmentation OFF for a deterministic ABORT signal
    # (instrumentation choice; the train dataset keeps augmentation ON, v1 parity).
    t_stage = time.time()
    log("STAGE eval dataset (augmentation OFF, deterministic ABORT signal)")
    eval_dataset = GLiClassDataset(examples, tokenizer, AugmentationConfig(enabled=False),
                                   max_length=cfg["max_length"], shuffle_labels=False)
    log(f"STAGE eval dataset ready ({time.time() - t_stage:.1f}s)")
    gen = torch.Generator().manual_seed(cfg["seed"])
    micro = int(cfg.get("micro_batch_size") or cfg["batch_size"])
    if micro <= 0 or cfg["batch_size"] % micro != 0:
        stop_watchdog()
        return refuse(f"micro-batch {micro} must divide batch-size {cfg['batch_size']} "
                      f"(effective-batch recipe guard)")
    accum = cfg["batch_size"] // micro
    loader = DataLoader(dataset, batch_size=micro, shuffle=True,
                        num_workers=0, collate_fn=collator, generator=gen)
    steps_per_epoch = len(loader) // accum + (1 if len(loader) % accum else 0)
    total_steps = steps_per_epoch * cfg["epochs"]
    log(f"batching: micro={micro} accum={accum} effective={micro * accum} "
        f"({len(loader)} micro-batches/epoch -> ~{steps_per_epoch} optimizer steps/epoch, "
        f"total ~{total_steps})")

    @torch.no_grad()
    def eval_loss() -> float:
        log("eval pass start")
        t_ev = time.time()
        model.eval()
        tot, n = 0.0, 0
        ev_loader = DataLoader(eval_dataset, batch_size=micro, shuffle=False,
                               num_workers=0, collate_fn=collator)
        for bi, batch in enumerate(ev_loader):
            tot += float(batch_loss_nograd(batch)) * len(batch["input_ids"])
            n += len(batch["input_ids"])
            if (bi + 1) % 50 == 0:
                log(f"eval pass batch {bi + 1} ({n} rows, {time.time() - t_ev:.1f}s)")
        model.train()
        ev = tot / max(n, 1)
        log(f"eval pass done: {n} rows loss {ev:.4f} ({time.time() - t_ev:.1f}s)")
        return ev

    log(f"objective: manual IDK loop, focal base, C={cfg['abstention_cost']} "
        f"({steps_per_epoch} steps/epoch x {cfg['epochs']} = {total_steps} steps)")
    model.train()
    baseline = None
    history: list[dict] = []
    aborted = False
    oom_events = 0
    tail_steps = 0
    step = 0
    for epoch in range(1, cfg["epochs"] + 1):
        opt.zero_grad(set_to_none=True)
        pending = 0
        for batch in loader:
            try:
                loss = batch_loss(batch) / accum
            except RuntimeError as e:
                if "out of memory" not in str(e).lower():
                    raise
                oom_events += 1
                torch.cuda.empty_cache() if torch.cuda.is_available() else None
                log(f"OOM-LOUD: cuda OOM in epoch {epoch} (event {oom_events}); "
                    f"failing with exit 4 instead of hanging/paging. "
                    f"err={str(e)[:200]}")
                stop_watchdog()
                return 4
            loss.backward()
            pending += 1
            if pending == accum:
                opt.step()
                opt.zero_grad(set_to_none=True)
                pending = 0
                step += 1
                lr = cfg["lr"] * max(0.0, 1.0 - step / total_steps)  # linear decay, warmup 0
                for pg in opt.param_groups:
                    pg["lr"] = lr
                if step % 10 == 0 or step == total_steps:
                    print(f"epoch {epoch} step {step}/{total_steps} loss {float(loss) * accum:.4f} "
                          f"lr {lr:.2e}", flush=True)
                    _WD["last"] = time.time()
                    _WD["stage"] = f"epoch {epoch} step {step}/{total_steps}"
        if pending:
            # Tail micro-batches (611 = 2x305 + 1 per epoch): single smaller step.
            opt.step()
            opt.zero_grad(set_to_none=True)
            pending = 0
            step += 1
            tail_steps += 1
            lr = cfg["lr"] * max(0.0, 1.0 - step / total_steps)
            for pg in opt.param_groups:
                pg["lr"] = lr
            log(f"epoch {epoch} tail step {step}/{total_steps} (partial accum)")
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
        "smoke_losses_8rows_2steps": smoke_losses,
        "micro_batch_size": micro,
        "grad_accum": accum,
        "tail_steps": tail_steps,
        "oom_events": oom_events,
        "quarantined_rows": len(quarantined),
        "quarantine_detail": quarantined,
        "watchdog_secs": cfg.get("watchdog_secs", 1200),
        "idk_bias_init": cfg["idk_bias_init"],
        "idk_q_init": cfg["idk_q_init"],
        "seed": cfg["seed"],
        "objective": "idk-focal manual torch loop (AbstentionHead + idk_loss focal; no accelerate in venv-ft)",
    }
    with open(os.path.join(cfg["run_dir"], "train_stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2)
    print(json.dumps(stats, indent=2), flush=True)
    log(f"TRAIN DONE: wall {stats['wall_seconds']}s vram_peak {stats['vram_peak_gb']}GB "
        f"aborted={aborted}")
    stop_watchdog()
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
