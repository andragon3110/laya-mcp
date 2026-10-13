"""kb-v6 B1 NLI core: facebook/xnli ES+EN, 900 rows (300/300/300 E/N/C), ES 450/EN 450.

MNLI-train sample per spec = XNLI-en-train (documented lineage, v4 precedent:
XNLI trains ARE MNLI translations; en is the untranslated original; a second
nyu-mll/glue pull would duplicate the corpus and its train split is absent
from the mirror). Seed 606101 (fresh vs v4 424242).
"""
import json
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from kb_util import GATE_CANDS, denied, write_jsonl

SEED = 606101
XNLI_LIC = "unlisted-on-mirror (upstream XNLI Conneau et al. 2018; verify before commercial use)"
X2G = {0: ["SUPPORTED"], 1: [], 2: ["CONTRADICTED"]}
TAG = {0: "ent", 1: "neu", 2: "con"}
VERDICT = {0: "E", 1: "N", 2: "C"}


def main():
    import warnings
    warnings.filterwarnings("ignore")
    from datasets import load_dataset
    rng = random.Random(SEED)
    stats = {"drops": [], "seed": SEED}
    all_rows = []

    for cfg, lang, per in (("es", "es", 150), ("en", "en", 150)):
        ds = load_dataset("facebook/xnli", cfg, split="train")
        print("XNLI %s: n=%d" % (cfg, len(ds)), flush=True)
        buckets = {0: [], 1: [], 2: []}
        for i, lab in enumerate(ds["label"]):
            buckets[int(lab)].append(i)
        for lab in (0, 1, 2):
            rng.shuffle(buckets[lab])
            got = 0
            for i in buckets[lab]:
                if got >= per:
                    break
                text = "%s || %s" % (ds[i]["premise"], ds[i]["hypothesis"])
                d = denied(text)
                if d:
                    stats["drops"].append({"id": "xnli-%s-%d" % (cfg, i),
                                          "reason": "denylist:" + d})
                    continue
                got += 1
                all_rows.append({
                    "id": "b1-gate-%s-%s-%03d" % (lang, TAG[lab], got),
                    "text": text, "all_labels": GATE_CANDS,
                    "true_labels": X2G[lab],
                    "source": "facebook/xnli:%s-train" % cfg,
                    "license": XNLI_LIC, "lang": lang,
                    "orig_id": "xnli-%s-%d" % (cfg, i)})
        print("  kept %s: %d" % (cfg, sum(1 for r in all_rows if r["lang"] == lang)),
              flush=True)

    assert len(all_rows) == 900, "B1 short: %d" % len(all_rows)
    write_jsonl(os.path.join(BASE, "b1-nli-core.jsonl"), all_rows)
    stats["total"] = len(all_rows)
    json.dump(stats, open(os.path.join(BASE, "b1-stats.json"), "w"), indent=1)
    print("B1 TOTAL:", len(all_rows))


if __name__ == "__main__":
    main()
