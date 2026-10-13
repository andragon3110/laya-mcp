"""V4 hang diagnosis probe: time each post-config stage with flushed prints.

Stages: rows load -> examples build -> tokenizer -> dataset init (aug ON/OFF)
-> model load -> first batch fetch (aug ON vs OFF) -> forward -> loss.
Run: py/.venv-ft/Scripts/python -u artifacts-ft/mix-regulus-v4/diag_probe.py
(no tail pipe; tail buffers to EOF and hides progress).
"""
import json
import sys
import time

t0 = time.time()


def log(stage):
    print(f"[probe t={time.time()-t0:7.1f}s] {stage}", flush=True)


log("start")
rows = []
import glob
for path in sorted(glob.glob("artifacts-ft/mix-regulus-v4/*.jsonl")):
    for line in open(path, encoding="utf-8"):
        if line.strip():
            rows.append(json.loads(line))
log(f"rows loaded: {len(rows)}")


def _all(r):
    v = r.get("candidates", r.get("all_labels", r.get("labels", [])))
    return list(v) if v is not None else []


def _true(r):
    v = r.get("labels", r.get("true_labels", []))
    return list(v) if v is not None else []


examples = [{"text": r["text"], "all_labels": _all(r), "true_labels": _true(r),
             "prompt": "", "examples": []} for r in rows]
log(f"examples built: {len(examples)}")

from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained("artifacts-ft/regulus-v2-pinned/checkpoint")
log("tokenizer loaded")

from gliclass.data_processing import (
    AugmentationConfig, DataCollatorWithPadding, GLiClassDataset)

ds_on = GLiClassDataset(examples, tok, AugmentationConfig(), max_length=1024)
log("dataset init aug=ON done (lazy, expect fast)")
ds_off = GLiClassDataset(examples, tok, AugmentationConfig(enabled=False),
                         max_length=1024, shuffle_labels=False)
log("dataset init aug=OFF done (lazy, expect fast)")

import torch
from torch.utils.data import DataLoader
collator = DataCollatorWithPadding(tok)

# single getitem timing per schema type (aug ON)
for idx, tag in [(0, "first"), (600, "mid-fever"), (1500, "mid-xnli"), (2400, "last")]:
    s = time.time()
    item = ds_on[idx]
    log(f"getitem[{idx}] ({tag}) aug=ON: {time.time()-s:.1f}s keys={sorted(item.keys())} "
        f"input_ids_len={len(item['input_ids'])} labels={item['labels'].tolist()}")
    del item

# single getitem aug OFF
s = time.time()
item = ds_off[600]
log(f"getitem[600] aug=OFF: {time.time()-s:.1f}s input_ids_len={len(item['input_ids'])}")
del item

# full-epoch getitem sweep aug ON (time the whole pass, no model)
s = time.time()
n = len(ds_on)
for i in range(n):
    ds_on[i]
log(f"full sweep {n} getitems aug=ON: {time.time()-s:.1f}s")

# batch fetch via DataLoader aug ON
loader = DataLoader(ds_on, batch_size=8, shuffle=False, num_workers=0,
                    collate_fn=collator)
s = time.time()
batch = next(iter(loader))
log(f"first DataLoader batch aug=ON: {time.time()-s:.1f}s "
    f"input_ids={tuple(batch['input_ids'].shape)} labels={tuple(batch['labels'].shape)}")

# model load + forward
from gliclass import GLiClassModel
s = time.time()
model = GLiClassModel.from_pretrained("artifacts-ft/regulus-v2-pinned/checkpoint")
log(f"model from_pretrained CPU: {time.time()-s:.1f}s")
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model.to(device).float()
log(f"model to {device}: done")

b = {k: (v.to(device) if isinstance(v, torch.Tensor) else v)
     for k, v in batch.items() if k not in ("labels_text", "input_texts")}
targets = b.pop("labels").float()
k = int(b.pop("max_num_classes", 0) or targets.shape[-1])
s = time.time()
with torch.no_grad():
    logits = model(input_ids=b["input_ids"], attention_mask=b.get("attention_mask"),
                   max_num_classes=k).logits.float()
if device.type == "cuda":
    torch.cuda.synchronize()
log(f"first forward {tuple(b['input_ids'].shape)} K={k}: {time.time()-s:.1f}s "
    f"logits={tuple(logits.shape)}")

from ft.idk_loss import AbstentionHead, idk_loss
head = AbstentionHead(bias_init=-2.2).to(device).float()
s = time.time()
loss, info = idk_loss(logits, targets, head(logits.detach()), 0.05, "focal")
if device.type == "cuda":
    torch.cuda.synchronize()
log(f"idk_loss: {time.time()-s:.1f}s loss={float(loss):.4f}")
log("PROBE COMPLETE")
