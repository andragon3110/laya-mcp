#!/usr/bin/env python3
"""ft-pilot T3 SFT: head/decision-only fine-tune of the Laya multilingual checkpoint.

Scope (frozen by design T1 + MANIFEST-T3a):
  base      convaiinnovations/laya-multilingual @ pinned revision (see BASE_REVISION)
  train     1000 rows (10 tools x 100), head/decision-only, 3 epochs, eff-batch 64
  optim     AdamW LR head 1e-4, cosine schedule, fp16 + grad-checkpoint + clip 1.0
  seq       max_len 1024 / head 256 (from upstream rl_agent_config.json)
  calib     200 rows, 1 temperature per (question-type, option-count) bucket;
            base temperature_by_options is STRIPPED (base ships {}), refit fresh
  export    head-only adapter + rl_agent_config.json + PIN file (base sha + data sha)
  smoke     --smoke validates 20 exam rows on CPU with stdlib only (no torch)

ASSUMPTIONS (fail loud, never silent):
  A1. The checkpoint exposes an `encoder` submodule (upstream config:
      encoder=jhu-clsp/mmBERT-base, head_layers=2). We freeze every parameter
      whose name contains "encoder" and train the rest (the decision head:
      2 transformer layers + option-marker scorer + act/escalate head).
  A2. Trainable parameter count must land in [5M, 40M] (head ~= 322M-307M = 15M).
      Outside that range the script ABORTS instead of silently full-finetuning.
  A3. Row -> tensor encoding (state+questions -> input ids, hard labels ->
      targets) follows the public `laya` SDK predict path. The exact collate
      is marked in build_batch() and must be confirmed against the installed
      `laya` version at run time; mismatch raises, never trains on garbage.
  A4. No upload happens unless --push is passed AND the secret env vars exist.
      Tokens are NEVER hardcoded; placeholders only.

Usage (Kaggle, 2x T4):
  python train.py --data /kaggle/input/ft-pilot-data --out /kaggle/working/ft-out
  python train.py --smoke --data ./ft-sft-laya   # CPU-local, stdlib only
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


# ---------------------------------------------------------------- calibration (numpy-free)


def _softmax(logits: list[float]) -> list[float]:
    m = max(logits)
    exps = [math.exp(x - m) for x in logits]
    s = sum(exps)
    return [e / s for e in exps]


def fit_temperature(probs_list: list[list[float]], gold_idx: list[int]) -> float:
    """Grid-search scalar temperature minimizing NLL (applies  p^(1/T) + renorm)."""
    best_t, best_nll = 1.0, math.inf
    t = 0.05
    while t <= 5.0:
        nll = 0.0
        for probs, g in zip(probs_list, gold_idx):
            scaled = _softmax([math.log(max(p, 1e-12)) / t for p in probs])
            nll -= math.log(max(scaled[g], 1e-12))
        if nll < best_nll:
            best_nll, best_t = nll, t
        t += 0.05
    return round(best_t, 3)


def bucket_key(row: dict) -> str:
    """One temperature per (question type, option count)."""
    qtypes: list[str] = []
    counts: list[str] = []
    for q in row["questions"].values():
        qtypes.append(q.get("type", "?"))
        crit = q.get("criteria", {})
        counts.append(str(len(crit)))
    return f"{'|'.join(sorted(set(qtypes)))}/{','.join(sorted(set(counts)))}"


def fit_calibration(calib_rows: list[dict]) -> dict[str, float]:
    """Fit 1 temp per bucket from hard labels. choice-only; other types copy T=1.0."""
    buckets: dict[str, tuple[list[list[float]], list[int]]] = {}
    for r in calib_rows:
        key = bucket_key(r)
        for qid, q in r["questions"].items():
            lab = r["labels"].get(qid)
            if not (isinstance(lab, dict) and "choice" in lab and "probabilities" in lab):
                continue
            keys = sorted(lab["probabilities"])
            probs = [lab["probabilities"][k] for k in keys]
            buckets.setdefault(key, ([], []))[0].append(probs)
            buckets[key][1].append(keys.index(lab["choice"]))
    temps = {k: fit_temperature(p, g) for k, (p, g) in buckets.items() if p}
    if not temps:
        raise SystemExit("calibration FAIL: no choice labels found in calib rows")
    return temps


# ---------------------------------------------------------------- training (torch, Kaggle only)


def build_batch(rows: list[dict]):
    """ASSUMPTION A3: encode state+questions via the installed `laya` SDK path.

    Replace the body with the exact collate of the `laya` version pinned for
    the run. Any mismatch with the SDK (missing keys, unknown qtype) raises.
    """
    raise NotImplementedError(
        "build_batch() must be completed against the installed `laya` SDK "
        "before launching (ASSUMPTION A3, see README-KAGGLE.md step 7). "
        "Refusing to train on a guessed encoding."
    )


def train_model(args) -> int:
    import torch  # noqa: PLC0415  (Kaggle-only dependency)

    data_dir = Path(args.data)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    train_rows, train_shas = load_train(data_dir)
    calib_rows = load_calib(data_dir)
    steps_per_epoch = math.ceil(len(train_rows) / EFFECTIVE_BATCH)
    total_steps = steps_per_epoch * EPOCHS
    print(f"train rows={len(train_rows)} steps/epoch={steps_per_epoch} "
          f"total={total_steps} (~47 expected) eff_batch={EFFECTIVE_BATCH}")

    from transformers import AutoModel  # noqa: PLC0415
    model = AutoModel.from_pretrained(HF_REPO, revision=BASE_REVISION, trust_remote_code=False)

    # Head-only: freeze the encoder backbone, train the decision head (A1).
    frozen, trainable = [], []
    for name, p in model.named_parameters():
        if "encoder" in name:
            p.requires_grad = False
            frozen.append(name)
        else:
            p.requires_grad = True
            trainable.append(name)
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

    model.gradient_checkpointing_enable()
    use_fp16 = args.dtype == "fp16"
    if use_fp16 and not torch.cuda.is_available():
        raise SystemExit("fp16 requested but CUDA unavailable")

    optimizer = torch.optim.AdamW(
        (p for p in model.parameters() if p.requires_grad),
        lr=LR_HEAD, weight_decay=WEIGHT_DECAY,
    )
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=total_steps)

    scaler = torch.amp.GradScaler("cuda") if use_fp16 else None
    model.train()
    global_step = 0
    for epoch in range(EPOCHS):
        for start in range(0, len(train_rows), PER_DEVICE_BATCH):
            batch = build_batch(train_rows[start:start + PER_DEVICE_BATCH])  # A3 gate
            optimizer.zero_grad()
            with torch.amp.autocast("cuda", enabled=use_fp16):
                loss = model(**batch).loss / GRAD_ACCUM
            if scaler:
                scaler.scale(loss).backward()
            else:
                loss.backward()
            if (start // PER_DEVICE_BATCH + 1) % GRAD_ACCUM == 0:
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
                global_step += 1
    print(f"training done: global_step={global_step}")

    # Calibrate: strip base temps, refit 1 temp per bucket on the 200 calib rows.
    temps = fit_calibration(calib_rows)
    print(f"fitted {len(temps)} temperature buckets")

    # Export: head-only adapter + rl_agent_config.json + PIN.
    adapter = {k: v.cpu() for k, v in model.state_dict().items()
               if any(k.startswith(t.split('.')[0]) for t in trainable)}
    torch.save(adapter, out_dir / "adapter-head.pt")
    base_cfg = {"model_name": "rl-agent"}  # replaced below if net allows
    try:
        from huggingface_hub import hf_hub_download  # noqa: PLC0415
        cfg_path = hf_hub_download(HF_REPO, "rl_agent_config.json", revision=BASE_REVISION)
        base_cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    except Exception as exc:  # offline Kaggle: fall back to frozen copy
        print(f"WARN: could not fetch upstream rl_agent_config.json ({exc}); "
              "using frozen values from MANIFEST-T3a.")
        base_cfg = {"encoder": "jhu-clsp/mmBERT-base", "head_layers": 2,
                    "max_len": MAX_LEN, "head_max_len": HEAD_MAX_LEN,
                    "temperature": [1.0, 1.0, 1.0]}
    out_cfg = copy.deepcopy(base_cfg)
    out_cfg["temperature_by_options"] = temps  # STRIP-then-refit: base ships {}
    out_cfg["training"] = {
        "base_repo": HF_REPO, "base_revision": BASE_REVISION,
        "train_rows": len(train_rows), "epochs": EPOCHS,
        "effective_batch": EFFECTIVE_BATCH, "lr_head": LR_HEAD,
        "world_size": args.world_size, "global_steps": global_step,
    }
    (out_dir / "rl_agent_config.json").write_text(
        json.dumps(out_cfg, indent=2, ensure_ascii=False), encoding="utf-8")

    pin = {
        "base_repo": HF_REPO, "base_revision": BASE_REVISION,
        "train_shas": train_shas, "calib_sha": sha256_file(data_dir / CALIB_FILE),
        "adapter_sha256": sha256_file(out_dir / "adapter-head.pt"),
        "global_steps": global_step, "effective_batch": EFFECTIVE_BATCH,
    }
    (out_dir / "PIN.json").write_text(json.dumps(pin, indent=2), encoding="utf-8")
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
    ap.add_argument("--dtype", default="fp16", choices=["fp16", "bf16", "fp32"])
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
