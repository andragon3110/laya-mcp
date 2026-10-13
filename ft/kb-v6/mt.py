"""kb-v6 verdict-preserving ES protocol (spec footnote *).

Engine: Helsinki-NLP/opus-mt-en-es + opus-mt-es-en (public, apache-2.0),
run locally via transformers MarianMT (no external API, no credentials).
Protocol per row: EN -> ES (opus-mt-en-es), then second pass ES -> EN
(opus-mt-es-en back-translation). Row KEPT iff:
  1. back-translation token-3-gram Jaccard vs original EN >= 0.30
     (translation fidelity: the round trip preserves meaning), AND
  2. every digit-group of the EN appears in the ES (numbers are the
     verdict carriers in VitaminC/FEVER-style claims; never silently
     altered), AND
  3. length sanity: 0.4x <= len(ES)/len(EN) <= 2.5x.
Rows failing any leg are DROPPED (never fixed silently); drops recorded
with the failing leg. Batch-translated on GPU when available, else CPU.
"""
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
MT_DIR = os.path.join(BASE, "mt-models")

EN_ES = "Helsinki-NLP/opus-mt-en-es"
ES_EN = "Helsinki-NLP/opus-mt-es-en"

_models = {}


def _model(model_id, device):
    import warnings
    warnings.filterwarnings("ignore")
    from transformers import MarianMTModel, MarianTokenizer
    key = (model_id, device)
    if key not in _models:
        snap = os.path.join(MT_DIR, model_id.replace("/", "__"))
        src = snap if os.path.isdir(snap) else model_id
        tok = MarianTokenizer.from_pretrained(src)
        mdl = MarianMTModel.from_pretrained(src)
        mdl.eval()
        if device >= 0:
            mdl = mdl.to("cuda:%d" % device)
        _models[key] = (tok, mdl)
    return _models[key]


def detect_device():
    try:
        import torch
        return 0 if torch.cuda.is_available() else -1
    except Exception:
        return -1


def download_models():
    """Snapshot both opus models locally (one bounded pull). Returns {id: dir}."""
    import warnings
    warnings.filterwarnings("ignore")
    from huggingface_hub import snapshot_download
    os.makedirs(MT_DIR, exist_ok=True)
    out = {}
    for mid in (EN_ES, ES_EN):
        dest = os.path.join(MT_DIR, mid.replace("/", "__"))
        if not os.path.isdir(dest):
            snapshot_download(repo_id=mid, local_dir=dest)
        out[mid] = dest
    return out


def translate(texts, direction="en-es", device=None, show_progress=False, batch=32):
    """Translate a list of EN (or ES) strings. Returns list of str (same order)."""
    import warnings
    warnings.filterwarnings("ignore")
    import torch
    if device is None:
        device = detect_device()
    mid = EN_ES if direction == "en-es" else ES_EN
    tok, mdl = _model(mid, device)
    texts = [t if t and t.strip() else "." for t in texts]
    outs = []
    B = batch
    for i in range(0, len(texts), B):
        batch = texts[i:i + B]
        enc = tok(batch, return_tensors="pt", padding=True, truncation=True,
                  max_length=256)
        if device >= 0:
            enc = {k: v.to("cuda:%d" % device) for k, v in enc.items()}
        with torch.no_grad():
            gen = mdl.generate(**enc, max_length=512)
        outs.extend(tok.batch_decode(gen, skip_special_tokens=True))
        del enc, gen
        if device >= 0:
            import torch as _t
            _t.cuda.empty_cache()
        if show_progress:
            print("  mt %s %d/%d" % (direction, min(i + B, len(texts)), len(texts)),
                  flush=True)
    return outs


def verify_rows(en_texts, es_texts, back_texts, jacc_fn, thresh=0.30):
    """Second-pass verdict preservation check. Returns (keep_flags, drop_reasons)."""
    keeps, reasons = [], []
    for en, es, back in zip(en_texts, es_texts, back_texts):
        en_d = re.findall(r"\d+", en)
        es_d = re.findall(r"\d+", es)
        if any(d not in es_d for d in en_d):
            keeps.append(False); reasons.append("digits-lost"); continue
        lr = len(es) / max(len(en), 1)
        if not (0.4 <= lr <= 2.5):
            keeps.append(False); reasons.append("len-ratio:%.2f" % lr); continue
        j = jacc_fn(en, back)
        if j < thresh:
            keeps.append(False); reasons.append("back-jacc:%.3f" % j); continue
        keeps.append(True); reasons.append("ok")
    return keeps, reasons
