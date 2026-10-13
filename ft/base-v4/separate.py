"""base-v4 separation proof: score a fixed sample of NEW hard rows with the
v2-pinned champion, READ-ONLY (no grads, no writes to the pinned dir), CPU,
then release. Inference only -- NOT training.

PASS criterion (parent spec): v2 accuracy on non-empty hard rows must beat
random (chance = mean 1/K = 1/3, K=3 everywhere); else the rows are noise and
must be regenerated. Empty (ABSTAIN) rows are diagnostic only (abstain-rate
at max_prob<0.5 + mean max_prob): they must show uncertainty, not collapse.
"""
import json
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
SEED = 777001
N_PER_CELL = 10


def load_rows(fn):
    with open(os.path.join(BASE, fn), encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def pick(rows, pred, n):
    pool = [r for r in rows if pred(r)]
    random.Random(SEED).shuffle(pool)
    return pool[:n]


def main():
    fever = load_rows("gate-fever.jsonl")
    es = load_rows("gate-nli-es.jsonl")
    en = load_rows("gate-nli-en.jsonl")
    ds = load_rows("screen-deepset.jsonl")
    bp = load_rows("screen-bipia.jsonl")

    sample = []
    sample += pick(fever, lambda r: r["true_labels"] == ["SUPPORTED"], 20)
    sample += pick(fever, lambda r: r["true_labels"] == ["CONTRADICTED"], 20)
    sample += pick(fever, lambda r: r["true_labels"] == [], 20)
    sample += pick(es, lambda r: r["true_labels"] == ["SUPPORTED"], 7)
    sample += pick(es, lambda r: r["true_labels"] == ["CONTRADICTED"], 7)
    sample += pick(es, lambda r: r["true_labels"] == [], 6)
    sample += pick(en, lambda r: r["true_labels"] == ["SUPPORTED"], 7)
    sample += pick(en, lambda r: r["true_labels"] == ["CONTRADICTED"], 7)
    sample += pick(en, lambda r: r["true_labels"] == [], 6)
    sample += pick(ds, lambda r: r["true_labels"] == ["malicious"], 10)
    sample += pick(ds, lambda r: r["true_labels"] == ["benign"], 10)
    atk = pick(bp, lambda r: r["true_labels"] == ["malicious"], 10)
    sample += atk
    atk_ids = {r["pair_id"] for r in atk}
    sample += [r for r in bp if r["true_labels"] == ["benign"] and r.get("pair_id") in atk_ids][:10]
    print(f"sample: {len(sample)} rows")

    sys.path.append(os.path.join(BASE, ".pylibs"))
    import warnings
    warnings.filterwarnings("ignore")
    import torch
    from gliclass import GLiClassModel, ZeroShotClassificationPipeline
    from transformers import AutoTokenizer

    ckpt = os.path.join(os.path.dirname(BASE), "..", "artifacts-ft",
                        "regulus-v2-pinned", "checkpoint")
    ckpt = os.path.normpath(ckpt)
    model = GLiClassModel.from_pretrained(ckpt)
    model.eval()
    tok = AutoTokenizer.from_pretrained(ckpt)
    pipe = ZeroShotClassificationPipeline(model, tok, classification_type="multi-label",
                                          device="cpu")
    # groups share candidate sets -> batchable
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
                    results.append({"id": r["id"], "true": r["true_labels"],
                                    "pred": pred, "max_prob": round(max(scores.values()), 4)})
    del pipe, model, tok

    nonempty = [x for x in results if x["true"]]
    empty = [x for x in results if not x["true"]]
    acc = sum(1 for x in nonempty if x["pred"] in x["true"]) / len(nonempty)
    wrong = 1 - acc
    abst = sum(1 for x in empty if x["max_prob"] < 0.5) / len(empty)
    meanmp = sum(x["max_prob"] for x in empty) / len(empty)
    chance = 1 / 3
    verdict = "PASS" if acc > chance else "FAIL(re-generate)"
    print(f"non-empty: n={len(nonempty)} acc={acc:.3f} wrong={wrong:.3f} vs chance={chance:.3f} -> {verdict}")
    print(f"empty(ABSTAIN): n={len(empty)} abstain-rate@0.5={abst:.3f} mean-maxprob={meanmp:.3f}")
    by_src = {}
    for x in results:
        src = x["id"].split("-")[0]
        d = by_src.setdefault(src, {"n": 0, "ok": 0})
        d["n"] += 1
        if x["true"] and x["pred"] in x["true"]:
            d["ok"] += 1
        if not x["true"] and x["max_prob"] < 0.5:
            d["ok"] += 1
    for k, v in sorted(by_src.items()):
        print(f"  {k}: {v['ok']}/{v['n']} = {v['ok'] / v['n']:.3f}")
    json.dump({"n": len(results), "acc_nonempty": round(acc, 4), "wrong_rate": round(wrong, 4),
               "chance": round(chance, 4), "abstain_rate_empty": round(abst, 4),
               "mean_maxprob_empty": round(meanmp, 4), "by_src": by_src,
               "verdict": verdict, "rows": results},
              open(os.path.join(BASE, "separate-report.json"), "w", encoding="utf-8"), indent=1)
    print("SEPARATION:", verdict)


if __name__ == "__main__":
    main()
