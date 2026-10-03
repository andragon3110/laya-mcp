#!/usr/bin/env python3
"""ft-pilot T3 SFT: head/decision-only fine-tune of the Laya multilingual checkpoint.

Scope (frozen by design T1 + MANIFEST-T3a):
  base      convaiinnovations/laya-multilingual @ pinned revision (see BASE_REVISION)
  train     1000 rows (10 tools x 100), head/decision-only, 3 epochs, eff-batch 64
  optim     AdamW LR head 1e-4, cosine schedule, bf16 + grad-checkpoint + clip 1.0
  seq       max_len 1024 / head 256 (from upstream rl_agent_config.json)
  calib     200 rows, 1 temperature per SDK temp_bucket(qtype, k);
            base temperature_by_options is STRIPPED (base ships {}), refit fresh
  export    head-only adapter + rl_agent_config.json + PIN file (base sha + data sha)
  smoke     --smoke validates 20 exam rows on CPU with stdlib only (no torch)

T3b-ii LOCAL ADAPTATION (2026-10-03, MANIFEST-T3b; design hyperparams unchanged):
  A3 RESOLVED against installed `laya==0.3.23` (repo-pinned in py/requirements.txt,
    installed offline from local wheel, zero network): build_batch() encodes rows
    with the SDK's own Agent._to_internal + build_sequence + collate_items, and the
    model is the SDK's DecisionModel loaded via laya.agent.Agent pinned to
    BASE_REVISION (laya.common.build_model; strict load_state_dict). The Kaggle
    draft's `AutoModel.from_pretrained(..., trust_remote_code=False)` can NEVER work
    here (no root config.json; verified ValueError) and raised NotImplementedError.
  Precision: bf16 (checkpoint amp_dtype=bf16; RTX 5060 Ti sm_120 has native bf16;
    upstream trains bf16). No GradScaler under bf16 (fp16 path retains it).
  Freeze: `encoder*` (backbone) AND `act_head*` (act/escalate has NO supervision
    signal in T2 rows; leaving it trainable would let AdamW weight-decay corrupt
    it). Trainable = head + scorer + type_emb = 14,770,945 params (A2 PASS).
  Targets: choice -> one-hot at criteria-key index; score -> one-hot at level;
    noul scalar s -> [1-s, s]. Skipped (never trained): null labels (None or
    {"k": None} = abstention silence) and choice golds outside the rendered
    options (negative/adversarial rows with unrepresentable targets).
  Calib: temperatures are fit from the TRAINED model's own logits on the 200
    calib rows (NLL grid search, clamped to SDK [0.5, 5.0]) keyed by the SDK's
    temp_bucket(qtype, k) so _decode_answers actually applies them. The Kaggle
    draft's label-only fit (no model outputs, non-SDK bucket keys) is replaced.
  Batching is by ROW (1000 rows, empties included): micro-batch --per-device rows,
    --grad-accum micro-batches per optimizer step. 8x8x1 GPU = eff-batch 64.

ASSUMPTIONS (fail loud, never silent):
  A1. The checkpoint exposes an `encoder` submodule (upstream config:
      encoder=jhu-clsp/mmBERT-base, head_layers=2). We freeze every parameter
      whose name contains "encoder" AND the `act_head` (no act/escalate labels
      exist in T2 rows) and train the rest (2 transformer layers +
      option-marker scorer + type_emb = 14,770,945 params, A2 PASS 2026-10-03).
  A2. Trainable parameter count must land in [5M, 40M] (head ~= 322M-307M = 15M).
      Outside that range the script ABORTS instead of silently full-finetuning.
  A3. RESOLVED (T3b-ii): row -> tensor encoding uses the installed `laya` SDK
      predict path itself (Agent._to_internal + build_sequence + collate_items
      from laya==0.3.23); the model is the SDK DecisionModel. Any SDK/weight
      mismatch raises via _verify_compatibility / strict load_state_dict.
  A4. No upload happens unless --push is passed AND the secret env vars exist.
      Tokens are NEVER hardcoded; placeholders only.

Usage (Kaggle, 2x T4):
  python train.py --data /kaggle/input/ft-pilot-data --out /kaggle/working/ft-out
  python train.py --smoke --data ./ft-sft-laya   # CPU-local, stdlib only

Usage (local 1x GPU, T3b-ii):
  python train.py --data ./ft-sft-laya --out $env:TEMP\\ft-t3b-out `
    --world-size 1 --grad-accum 8 --dtype bf16 --log-file $env:TEMP\\ft-t3b-loss.log
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------- frozen config

HF_REPO = "convaiinnovations/laya-multilingual"
# Verified public 2026-10-03 via https://huggingface.co/api/models/<repo>
# (private=false, gated=false, apache-2.0). Re-verify by hand: model page
# "Files and versions" must list this commit on main; if main moved, pin the
# NEW sha here and record it in the PIN file (never train unpinned).
BASE_REVISION = "e4e9ddf21a7b1903b7acffd8814ad4307bf63a67"

EPOCHS = 3
PER_DEVICE_BATCH = 8
GRAD_ACCUM = 4
N_GPU_EXPECTED = 2            # 8 * 4 * 2 = 64 effective batch
EFFECTIVE_BATCH = PER_DEVICE_BATCH * GRAD_ACCUM * N_GPU_EXPECTED
LR_HEAD = 1e-4
WEIGHT_DECAY = 0.01
MAX_GRAD_NORM = 1.0
MAX_LEN = 1024                # from upstream rl_agent_config.json
HEAD_MAX_LEN = 256            # from upstream rl_agent_config.json

TRAIN_FILES = [
    "train-screen.jsonl", "train-verify.jsonl",
    "train-classify.jsonl", "train-decide.jsonl", "train-extract.jsonl",
    "train-find.jsonl", "train-rerank.jsonl", "train-review.jsonl",
    "train-gate.jsonl", "train-compare.jsonl",
]
CALIB_FILE = "calib.jsonl"
EXAM_GLOB = "exam-*.jsonl"

REQUIRED_ROW_KEYS = {
    "id", "lang", "primitive", "kind", "state",
    "questions", "labels", "decision", "source", "seed", "notes",
}

# ---------------------------------------------------------------- data helpers


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"bad JSON {path}:{lineno}: {exc}") from exc
    return rows


def check_schema(rows: list[dict], path: Path) -> None:
    ids: set[str] = set()
    for r in rows:
        missing = REQUIRED_ROW_KEYS - set(r)
        if missing:
            raise SystemExit(f"schema error {path}: row {r.get('id')} missing {sorted(missing)}")
        if r["id"] in ids:
            raise SystemExit(f"schema error {path}: duplicate id {r['id']}")
        ids.add(r["id"])
        if r["labels"] is None:
            raise SystemExit(f"schema error {path}: row {r['id']} has null labels")


def load_train(data_dir: Path) -> tuple[list[dict], dict[str, str]]:
    all_rows: list[dict] = []
    shas: dict[str, str] = {}
    for name in TRAIN_FILES:
        p = data_dir / name
        if not p.exists():
            raise SystemExit(f"missing train file: {p}")
        rows = load_jsonl(p)
        check_schema(rows, p)
        all_rows.extend(rows)
        shas[name] = sha256_file(p)
    if len(all_rows) != 1000:
        raise SystemExit(f"expected 1000 train rows, found {len(all_rows)} (see MANIFEST-T3a)")
    return all_rows, shas


def load_calib(data_dir: Path) -> list[dict]:
    p = data_dir / CALIB_FILE
    if not p.exists():
        raise SystemExit(f"missing calib file: {p}")
    rows = load_jsonl(p)
    check_schema(rows, p)
    nulls = [r["id"] for r in rows if any(v is None for v in _walk(r["labels"]))]
    if nulls:
        raise SystemExit(f"calib must carry zero null labels, found in: {nulls[:5]}")
    if len(rows) != 200:
        raise SystemExit(f"expected 200 calib rows, found {len(rows)}")
    return rows


def _walk(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)
    else:
        yield obj


# ---------------------------------------------------------------- smoke (CPU, stdlib only)


def run_smoke(data_dir: Path, n: int = 20) -> int:
    """Validate the first N exam rows: schema + well-formed labels/questions.

    This is the LOCAL pre-Kaggle gate (no torch, no GPU, no training).
    The full smoke (forward pass through base+adapter) runs in-Kaggle at the
    end of train.py and is a separate function below.
    """
    exam_files = sorted(data_dir.glob(EXAM_GLOB))
    if not exam_files:
        raise SystemExit(f"no exam files in {data_dir}")
    rows: list[dict] = []
    for p in exam_files:
        for r in load_jsonl(p):
            rows.append(r)
            if len(rows) >= n:
                break
        if len(rows) >= n:
            break
    if len(rows) < n:
        raise SystemExit(f"smoke needs {n} exam rows, found {len(rows)}")
    check_schema(rows, Path(f"<smoke {n} exam rows>"))
    for r in rows:
        if not r["questions"] or not r["labels"]:
            raise SystemExit(f"smoke FAIL: row {r['id']} has empty questions/labels")
    print(f"smoke OK: {len(rows)} exam rows, schema valid, labels present, 0 null-label rows")
    print("exam ids:", ", ".join(r["id"] for r in rows[:5]), "...")
    return 0


# ---------------------------------------------------------------- calibration
# T3b-ii: temperatures are fit from the TRAINED model's own logits on the calib
# rows (NLL grid search per SDK temp_bucket, clamped to the SDK [0.5, 5.0]
# range), so _decode_answers applies them. The Kaggle draft fit temperatures
# from teacher LABELS without ever running the model (degenerate for one-hot
# teachers) under non-SDK bucket keys the decoder would never match.


def _softmax(logits: list[float]) -> list[float]:
    m = max(logits)
    exps = [math.exp(x - m) for x in logits]
    s = sum(exps)
    return [e / s for e in exps]


def fit_calibration_from_logits(bucket_logits: dict[str, list[tuple[list[float], int]]]) -> dict[str, float]:
    """Grid-search 1 temperature per SDK bucket minimizing NLL vs gold labels."""
    from laya.common import TEMP_MAX, TEMP_MIN  # noqa: PLC0415 (SDK clamp range)

    temps: dict[str, float] = {}
    t = TEMP_MIN
    grid: list[float] = []
    while t <= TEMP_MAX + 1e-9:
        grid.append(round(t, 3))
        t += 0.05
    for bucket, pairs in sorted(bucket_logits.items()):
        best_t, best_nll = 1.0, math.inf
        for cand in grid:
            nll = 0.0
            for logits, gold in pairs:
                scaled = _softmax([x / cand for x in logits])
                nll -= math.log(max(scaled[gold], 1e-12))
            if nll < best_nll:
                best_nll, best_t = nll, cand
        temps[bucket] = round(best_t, 3)
    if not temps:
        raise SystemExit("calibration FAIL: no representable calib questions found")
    return temps


# ---------------------------------------------------------------- training (torch)
# T3b-ii: the model is the SDK DecisionModel (laya.agent.Agent, pinned to
# BASE_REVISION); encoding is the SDK predict path itself. No guessed collate.


def _is_null_label(lab) -> bool:
    return lab is None or (isinstance(lab, dict) and any(v is None for v in lab.values()))


def target_for_question(q: dict, lab: dict) -> list[float] | None:
    """Teacher target distribution over the SDK-rendered options.

    choice: one-hot at the criteria-key index; score: one-hot at the level;
    noul scalar s: [1-s, s] over [false, true]. Returns None when the gold is
    not representable over the rendered options (negative/adversarial rows):
    the question is SKIPPED, never trained on an invented target.
    """
    t = q["t"]
    if t == "choice":
        keys = list(q["crit"].keys())
        if lab.get("choice") not in keys:
            return None
        v = [0.0] * len(keys)
        v[keys.index(lab["choice"])] = 1.0
        return v
    if t == "score":
        k = len(q["crit"])
        level = int(lab["score"])
        if not 0 <= level < k:
            raise SystemExit(f"score label {level} out of range for {k} levels")
        v = [0.0] * k
        v[level] = 1.0
        return v
    if t == "noul":
        s = float(lab["noul"])
        if not 0.0 <= s <= 1.0:
            raise SystemExit(f"noul label {s} outside [0, 1]")
        return [1.0 - s, s]
    raise SystemExit(f"unknown question type {t!r}")


def encode_row(agent, row: dict) -> tuple[list[dict], dict[str, int]]:
    """Encode one T2 row to SDK items with teacher targets. Loud on mismatch."""
    from laya.common import QTYPES, build_sequence  # noqa: PLC0415

    max_len = agent.cfg.get("max_len", MAX_LEN)
    head_max_len = agent.cfg.get("head_max_len", HEAD_MAX_LEN)
    items: list[dict] = []
    skipped = {"null": 0, "gold": 0}
    for qid, qdef in row["questions"].items():
        lab = row["labels"].get(qid)
        if _is_null_label(lab):
            skipped["null"] += 1
            continue
        q = agent._to_internal(qdef)
        tgt = target_for_question(q, lab)
        if tgt is None:
            skipped["gold"] += 1
            continue
        ids, markers = build_sequence(agent.tok, row["state"], q, max_len, head_max_len)[:2]
        if len(markers) != len(tgt):
            raise SystemExit(
                f"encoding FAIL {row['id']}/{qid}: {len(markers)} markers vs {len(tgt)} targets")
        items.append({"ids": ids, "markers": markers, "qtype": QTYPES[q["t"]], "target": tgt,
                      "qid": qid, "qtype_name": q["t"]})
    return items, skipped


def build_batch(agent, rows: list[dict]):
    """Collate a micro-batch of rows via the SDK collate. Returns None if empty."""
    from laya.common import collate_items  # noqa: PLC0415

    groups = [items for items, _ in (encode_row(agent, r) for r in rows) if items]
    if not groups:
        return None
    return collate_items(groups, agent.tok.pad_token_id)


def _save_export(model, trainable_names: set[str], out_dir: Path, base_cfg: dict,
                 temps: dict[str, float], pin_extra: dict, calib_sha: str,
                 train_shas: dict[str, str], partial: bool) -> None:
    import torch  # noqa: PLC0415

    adapter = {k: v.cpu() for k, v in model.state_dict().items() if k in trainable_names}
    torch.save(adapter, out_dir / "adapter-head.pt")
    out_cfg = copy.deepcopy(base_cfg)
    out_cfg.pop("temperature_by_options", None)  # STRIP base map (ships {}), refit fresh
    out_cfg["temperature_by_options"] = temps
    out_cfg["training"] = {
        "base_repo": HF_REPO, "base_revision": BASE_REVISION,
        "train_rows": 1000, "epochs": EPOCHS,
        "effective_batch": pin_extra["effective_batch"], "lr_head": LR_HEAD,
        "dtype": pin_extra["dtype"], "world_size": pin_extra["world_size"],
        "global_steps": pin_extra["global_steps"], "partial": partial,
    }
    (out_dir / "rl_agent_config.json").write_text(
        json.dumps(out_cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    pin = {
        "base_repo": HF_REPO, "base_revision": BASE_REVISION,
        "train_shas": train_shas, "calib_sha": calib_sha,
        "adapter_sha256": sha256_file(out_dir / "adapter-head.pt"),
        "partial": partial,
        **pin_extra,
    }
    (out_dir / "PIN.json").write_text(json.dumps(pin, indent=2), encoding="utf-8")


ABORT_WALL_S = 90 * 60  # T3b-ii rule: >90 min wall -> STOP, save partial
ABORT_PATIENCE_STEPS = 10  # loss NaN, or no improvement over step-0 loss after 10 steps -> STOP


def train_model(args) -> int:
    import time  # noqa: PLC0415 (local dep, stdlib)
    import torch  # noqa: PLC0415
    from laya.agent import Agent  # noqa: PLC0415 (SDK predict path, A3)

    t0 = time.time()
    data_dir = Path(args.data)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_path = Path(args.log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    eff_batch = args.per_device_batch * args.grad_accum * args.world_size
    steps_per_epoch = math.ceil(1000 / eff_batch)
    total_steps = steps_per_epoch * EPOCHS
    print(f"train rows=1000 steps/epoch={steps_per_epoch} "
          f"total~{total_steps} eff_batch={eff_batch} dtype={args.dtype}")

    train_rows, train_shas = load_train(data_dir)
    calib_rows = load_calib(data_dir)

    # Pinned SDK load (offline once cached); strict weights verify architecture.
    agent = Agent(HF_REPO, revision=BASE_REVISION,
                  device="cuda" if torch.cuda.is_available() else "cpu")
    assert agent.revision == BASE_REVISION, f"unpinned load: {agent.revision}"
    model = agent.model
    device = next(model.parameters()).device

    # Head-only: freeze backbone AND act_head (no act labels in T2 rows; A1).
    for name, p in model.named_parameters():
        p.requires_grad = not ("encoder" in name or name.startswith("act_head"))
    trainable_names = {n for n, p in model.named_parameters() if p.requires_grad}
    n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)
    n_total = sum(p.numel() for p in model.parameters())
    print(f"params total={n_total} trainable={n_train} ({100.0 * n_train / n_total:.1f}%)")
    if not 5_000_000 <= n_train <= 40_000_000:  # A2: ~=15M head expected
        raise SystemExit(
            f"ABORT (A2): trainable={n_train} outside [5M, 40M]; "
            "the encoder/head split did not match this checkpoint. Refusing silent full-finetune."
        )
    if args.world_size != N_GPU_EXPECTED:
        print(f"WARN: world_size={args.world_size}, recipe tuned for {N_GPU_EXPECTED}xT4; "
              "effective batch differs — recorded in PIN file, KEEP rule still applies.")

    model.head_checkpointing = True  # SDK non-reentrant checkpointing (trains head on frozen input)
    if args.dtype in ("fp16", "bf16") and device.type != "cuda":
        raise SystemExit(f"{args.dtype} requested but CUDA unavailable")
    amp_dtype = {"fp16": torch.float16, "bf16": torch.bfloat16}.get(args.dtype)

    optimizer = torch.optim.AdamW(
        (p for p in model.parameters() if p.requires_grad),
        lr=LR_HEAD, weight_decay=WEIGHT_DECAY,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_steps)
    scaler = torch.amp.GradScaler("cuda") if args.dtype == "fp16" else None

    def abort_partial(reason: str, global_step: int, best: float) -> int:
        print(f"ABORT: {reason} — saving partial export (steps={global_step}, best={best:.4f})")
        _save_export(model, trainable_names, out_dir, agent.cfg, {"note": "PARTIAL " + reason},
                     {"effective_batch": eff_batch, "dtype": args.dtype,
                      "world_size": args.world_size, "global_steps": global_step,
                      "trainable_params": n_train, "abort_reason": reason},
                     sha256_file(data_dir / CALIB_FILE), train_shas, partial=True)
        return 2

    logf = open(log_path, "w", encoding="utf-8")
    logf.write(f"# T3b-ii loss log eff_batch={eff_batch} dtype={args.dtype} lr={LR_HEAD}\n")
    model.train()
    optimizer.zero_grad()
    global_step, accum, best, loss0 = 0, 0, math.inf, None
    aborted = 0
    for epoch in range(EPOCHS):
        for start in range(0, len(train_rows), args.per_device_batch):
            if time.time() - t0 > ABORT_WALL_S:
                aborted = abort_partial(">90min wall", global_step, best)
                break
            batch = build_batch(agent, train_rows[start:start + args.per_device_batch])
            if batch is None:  # all-empty micro-batch (abstention rows): no signal
                continue
            b = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in batch.items()}
            if amp_dtype:
                with torch.amp.autocast("cuda", dtype=amp_dtype):
                    logits, _ = model(b["input_ids"], b["attention_mask"], b["marker_pos"],
                                      b["marker_mask"], b["qtype"], detach_encoder=True)
                    logp = torch.log_softmax(logits.float(), -1)
                    loss = -(b["target"].to(torch.float32) * logp).sum(-1).mean() / args.grad_accum
            else:
                logits, _ = model(b["input_ids"], b["attention_mask"], b["marker_pos"],
                                  b["marker_mask"], b["qtype"], detach_encoder=True)
                logp = torch.log_softmax(logits.float(), -1)
                loss = -(b["target"].to(torch.float32) * logp).sum(-1).mean() / args.grad_accum
            if scaler:
                scaler.scale(loss).backward()
            else:
                loss.backward()
            accum += 1
            if accum % args.grad_accum == 0:
                if scaler:
                    scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(
                    (p for p in model.parameters() if p.requires_grad), MAX_GRAD_NORM)
                if scaler:
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    optimizer.step()
                scheduler.step()
                optimizer.zero_grad()
                accum = 0
                global_step += 1
                step_loss = float(loss.detach() * args.grad_accum)
                if not math.isfinite(step_loss):
                    logf.close()
                    return abort_partial(f"loss non-finite ({step_loss})", global_step, best)
                if loss0 is None:
                    loss0 = step_loss
                best = min(best, step_loss)
                logf.write(f"{global_step} {epoch} {step_loss:.6f}\n")
                logf.flush()
                print(f"step {global_step}/{total_steps} epoch={epoch} loss={step_loss:.4f}", flush=True)
                if global_step > ABORT_PATIENCE_STEPS and best >= loss0:
                    logf.close()
                    return abort_partial(
                        f"no improvement over initial {loss0:.4f} after {global_step} steps",
                        global_step, best)
        if aborted:
            logf.close()
            return aborted
    if accum:  # trailing partial accumulation at end of training
        torch.nn.utils.clip_grad_norm_(
            (p for p in model.parameters() if p.requires_grad), MAX_GRAD_NORM)
        optimizer.step()
        global_step += 1
    logf.close()
    wall = time.time() - t0
    print(f"training done: global_step={global_step} best={best:.4f} wall={wall:.1f}s")

    # Calibrate: run the TRAINED model over the 200 calib rows, fit 1 temp per
    # SDK bucket from its own logits vs gold labels.
    from laya.common import temp_bucket  # noqa: PLC0415

    bucket_logits: dict[str, list[tuple[list[float], int]]] = {}
    model.eval()
    with torch.no_grad():
        for r in calib_rows:
            items, _ = encode_row(agent, r)
            if not items:
                continue
            from laya.common import collate_items  # noqa: PLC0415
            b = collate_items([items], agent.tok.pad_token_id)
            b = {k: (v.to(device) if hasattr(v, "to") else v) for k, v in b.items()}
            if amp_dtype:
                with torch.amp.autocast("cuda", dtype=amp_dtype):
                    logits, _ = model(b["input_ids"], b["attention_mask"], b["marker_pos"],
                                      b["marker_mask"], b["qtype"])
            else:
                logits, _ = model(b["input_ids"], b["attention_mask"], b["marker_pos"],
                                  b["marker_mask"], b["qtype"])
            for j, it in enumerate(items):
                k = len(it["markers"])
                bucket = temp_bucket(it["qtype"], k)
                gold = it["target"].index(1.0) if 1.0 in it["target"] else max(
                    range(len(it["target"])), key=lambda i: it["target"][i])
                bucket_logits.setdefault(bucket, []).append(
                    (logits[j, :k].float().cpu().tolist(), gold))
    temps = fit_calibration_from_logits(bucket_logits)
    print(f"fitted {len(temps)} temperature buckets: {temps}")

    # Export: head-only adapter + rl_agent_config.json + PIN (weights NEVER in repo).
    _save_export(model, trainable_names, out_dir, agent.cfg, temps,
                 {"effective_batch": eff_batch, "dtype": args.dtype,
                  "world_size": args.world_size, "global_steps": global_step,
                  "trainable_params": n_train, "wall_s": round(wall, 1),
                  "loss_first": loss0, "loss_best": best},
                 sha256_file(data_dir / CALIB_FILE), train_shas, partial=False)
    print("export OK:", sorted(os.listdir(out_dir)))

    if args.push:
        token = os.getenv("HF_TOKEN", "TU_TOKEN_AQUI")
        if token == "TU_TOKEN_AQUI":
            raise SystemExit("ABORT: --push needs HF_TOKEN secret set (never hardcoded).")
        from huggingface_hub import HfApi  # noqa: PLC0415
        repo = args.push_repo or "TU_USUARIO_AQUI/ft-pilot-laya-sft"
        HfApi().create_repo(repo, private=True, exist_ok=True, token=token)
        HfApi().upload_folder(repo_id=repo, folder_path=str(out_dir), token=token)
        print(f"pushed adapter to private repo {repo}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="ft-pilot T3 SFT (head-only) + smoke")
    ap.add_argument("--data", default="/kaggle/input/ft-pilot-data",
                    help="dir with train-*.jsonl + calib.jsonl (+ exam-*.jsonl for smoke)")
    ap.add_argument("--out", default="/kaggle/working/ft-out", help="export dir")
    ap.add_argument("--smoke", action="store_true",
                    help="CPU-local validation of 20 exam rows (stdlib only)")
    ap.add_argument("--dtype", default="bf16", choices=["fp16", "bf16", "fp32"],
                    help="T3b-ii local default bf16 (checkpoint amp_dtype; sm_120 native)")
    ap.add_argument("--per-device-batch", type=int, default=PER_DEVICE_BATCH,
                    help="rows per micro-batch (recipe: 8)")
    ap.add_argument("--grad-accum", type=int, default=GRAD_ACCUM,
                    help="micro-batches per optimizer step (recipe Kaggle 2xGPU: 4; local 1xGPU: 8)")
    ap.add_argument("--log-file", default=os.path.join(os.getenv("TEMP", "."), "ft-t3b-loss.log"),
                    help="per-step loss log (outside the repo)")
    ap.add_argument("--world-size", type=int, default=N_GPU_EXPECTED)
    ap.add_argument("--push", action="store_true", help="upload adapter to private Hub repo")
    ap.add_argument("--push-repo", default="",
                    help="private Hub repo id (default placeholder, never a real id)")
    args = ap.parse_args(argv)
    if args.smoke:
        return run_smoke(Path(args.data))
    return train_model(args)


if __name__ == "__main__":
    sys.exit(main())
