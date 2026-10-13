"""kb-v6 separation proof: score a fixed sample of NEW hard rows with the
v2-pinned champion, READ-ONLY (no grads, no writes to the pinned dir), CPU,
then release. Inference only -- NOT training.

PASS criterion (parent spec): v2 accuracy on non-empty hard rows must beat
random (chance = mean 1/K = 1/3, K=3 everywhere); else the rows are noise and
must be regenerated. Empty (ABSTAIN) + suspicious rows are diagnostic only.
Per-block breakdown included (weak blocks regenerate).
"""
import json
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))
SEED = 777002


def load(fn):
    with open(os.path.join(BASE, fn), encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def pick(rows, pred, n, tag):
    pool = [dict(r, _block=tag) for r in rows if pred(r)]
    random.Random(SEED).shuffle(pool)
    return pool[:n]


def main():
    b1 = load("b1-nli-core.jsonl")
    b2 = load("b2-anli.jsonl")
    b3 = load("b3-verify-contrast.jsonl")
    b4 = load("b4-fever.jsonl")
    b5 = load("b5-screen.jsonl")
    b6 = load("b6-classify.jsonl")
    b7 = load("b7-silence.jsonl")

    S = lambda r: r["true_labels"] == ["SUPPORTED"]
    C = lambda r: r["true_labels"] == ["CONTRADICTED"]
    E = lambda r: r["true_labels"] == []
    EN = lambda r: r["lang"] == "en"
    ES = lambda r: r["lang"] == "es"
    sample = []
    for tag, rows in (("b1", b1), ("b2", b2)):
        sample += pick(rows, lambda r: S(r) and EN(r), 5, tag)
        sample += pick(rows, lambda r: S(r) and ES(r), 5, tag)
        sample += pick(rows, lambda r: C(r) and EN(r), 5, tag)
        sample += pick(rows, lambda r: C(r) and ES(r), 5, tag)
        sample += pick(rows, lambda r: E(r) and EN(r), 5, tag)
        sample += pick(rows, lambda r: E(r) and ES(r), 5, tag)
    for tag, rows in (("b3", b3), ("b4", b4)):
        sample += pick(rows, lambda r: S(r), 10, tag)
        sample += pick(rows, lambda r: C(r), 10, tag)
        sample += pick(rows, lambda r: E(r), 10, tag)
    sample += pick(b5, lambda r: r["true_labels"] == ["malicious"], 10, "b5")
    sample += pick(b5, lambda r: r["true_labels"] == ["benign"], 10, "b5")
    sample += pick(b5, lambda r: r["true_labels"] == ["suspicious"], 10, "b5s")
    sample += pick(b6, lambda r: r["true_labels"] == ["bug"], 10, "b6")
    sample += pick(b6, lambda r: r["true_labels"] == ["feature"], 10, "b6")
    sample += pick(b6, lambda r: r["true_labels"] == ["other"], 10, "b6")
    sample += pick(b7, E, 12, "b7")
    print("sample: %d rows" % len(sample), flush=True)

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
    groups = {}
    for r in sample:
        groups.setdefault(tuple(r["all_labels"]), []).append(r)
    results = []
    with torch.no_grad():
        for labels, grp in groups.items():
            labels = list(labels)
            for i in range(0, len(grp), 8):
                batch = grp[i:i + 8]
                out = pipe([r["text"][:2000] for r in batch], labels, threshold=0.0)
                for r, res in zip(batch, out):
                    scores = {d["label"]: float(d["score"]) for d in res}
                    pred = max(scores, key=scores.get)
                    results.append({"id": r["id"], "block": r["_block"],
                                    "true": r["true_labels"], "pred": pred,
                                    "max_prob": round(max(scores.values()), 4)})
    del pipe, model, tok

    nonempty = [x for x in results if x["true"] and x["block"] != "b5s"]
    empty = [x for x in results if not x["true"]]
    sus = [x for x in results if x["block"] == "b5s"]
    acc = sum(1 for x in nonempty if x["pred"] in x["true"]) / len(nonempty)
    wrong = 1 - acc
    abst = sum(1 for x in empty if x["max_prob"] < 0.5) / len(empty)
    meanmp = sum(x["max_prob"] for x in empty) / len(empty)
    sus_rate = sum(1 for x in sus if x["pred"] == "suspicious") / len(sus)
    chance = 1 / 3
    verdict = "PASS" if acc > chance else "FAIL(re-generate)"
    print("non-empty: n=%d acc=%.3f wrong=%.3f vs chance=%.3f -> %s"
          % (len(nonempty), acc, wrong, chance, verdict))
    print("empty(ABSTAIN): n=%d abstain-rate@0.5=%.3f mean-maxprob=%.3f"
          % (len(empty), abst, meanmp))
    print("suspicious(REVIEW): n=%d pred-suspicious-rate=%.3f" % (len(sus), sus_rate))
    by_block = {}
    for x in results:
        d = by_block.setdefault(x["block"], {"n": 0, "ok": 0})
        d["n"] += 1
        if x["true"] and x["block"] != "b5s" and x["pred"] in x["true"]:
            d["ok"] += 1
        if x["block"] == "b5s" and x["pred"] == "suspicious":
            d["ok"] += 1
        if not x["true"] and x["max_prob"] < 0.5:
            d["ok"] += 1
    for k, v in sorted(by_block.items()):
        print("  %s: %d/%d = %.3f" % (k, v["ok"], v["n"], v["ok"] / v["n"]))
    json.dump({"n": len(results), "acc_nonempty": round(acc, 4),
               "wrong_rate": round(wrong, 4), "chance": round(chance, 4),
               "abstain_rate_empty": round(abst, 4),
               "mean_maxprob_empty": round(meanmp, 4),
               "suspicious_rate": round(sus_rate, 4),
               "by_block": by_block, "verdict": verdict, "rows": results},
              open(os.path.join(BASE, "separate-report.json"), "w", encoding="utf-8"),
              indent=1)
    print("SEPARATION:", verdict)


if __name__ == "__main__":
    main()
