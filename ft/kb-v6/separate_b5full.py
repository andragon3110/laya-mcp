"""kb-v6 b5 full-block separation: score ALL 760 b5 rows with v2-pinned,
READ-ONLY CPU, then release. Resolves the small-sample (n=20) b5 flag with a
tight number. NOT training."""
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))


def main():
    with open(os.path.join(BASE, "b5-screen.jsonl"), encoding="utf-8") as f:
        rows = [json.loads(l) for l in f if l.strip()]
    print("b5 full: %d rows" % len(rows), flush=True)
    import warnings
    warnings.filterwarnings("ignore")
    import torch
    from gliclass import GLiClassModel, ZeroShotClassificationPipeline
    from transformers import AutoTokenizer

    ckpt = os.path.normpath(os.path.join(REPO, "artifacts-ft", "regulus-v2-pinned",
                                         "checkpoint"))
    model = GLiClassModel.from_pretrained(ckpt)
    model.eval()
    tok = AutoTokenizer.from_pretrained(ckpt)
    pipe = ZeroShotClassificationPipeline(model, tok, classification_type="multi-label",
                                          device="cpu")
    labels = ["benign", "suspicious", "malicious"]
    n_ok = n_dec = 0
    by = {}
    with torch.no_grad():
        for i in range(0, len(rows), 8):
            batch = rows[i:i + 8]
            out = pipe([r["text"][:2000] for r in batch], labels, threshold=0.0)
            for r, res in zip(batch, out):
                scores = {d["label"]: float(d["score"]) for d in res}
                pred = max(scores, key=scores.get)
                key = r["true_labels"][0]
                d = by.setdefault(key, [0, 0])
                d[1] += 1
                if pred == key:
                    d[0] += 1
                    if key in ("benign", "malicious"):
                        n_ok += 1
                if key in ("benign", "malicious"):
                    n_dec += 1
            print("  scored %d/%d" % (min(i + 8, len(rows)), len(rows)), flush=True)
    del pipe, model, tok
    print("by gold:", {k: "%d/%d=%.3f" % (v[0], v[1], v[0] / v[1]) for k, v in by.items()})
    for key in ("benign", "malicious"):
        v = by.get(key, [0, 0])
        print("  %s: %.3f" % (key, v[0] / v[1] if v[1] else 0))
    print("decisive acc: %d/%d = %.3f vs chance 0.333" % (n_ok, n_dec, n_ok / n_dec))


if __name__ == "__main__":
    main()
