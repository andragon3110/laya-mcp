"""kb-v6 B2 NLI adversarial: facebook/anli r1-r3 EN 400 + ES-mirror 200 (MT + re-verify).

License cc-by-nc-4.0 flagged NC per spec (blocks commercial redistribution;
internal training use documented as-is). Seed 606102.
ES mirror: stratified 200 from the EN 400 (verdict-balanced), premise and
hypothesis translated separately, back-translation second pass (mt.verify_rows:
back-Jaccard>=0.30 + digits preserved + length sanity); failures DROPPED with
leg recorded, topped up from the remaining EN pool. ES rows also denylist-hit
filtered (Spanish deny phrases) with top-up.
"""
import json
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from kb_util import GATE_CANDS, denied, trigrams, jacc, write_jsonl
from mt import translate, verify_rows, detect_device

SEED = 606102
LIC = "cc-by-nc-4.0 (NC: no commercial redistribution; internal training use documented as-is)"
X2G = {0: ["SUPPORTED"], 1: [], 2: ["CONTRADICTED"]}
TAG = {0: "ent", 1: "neu", 2: "con"}
WANT_ROUND = {"train_r1": 134, "train_r2": 133, "train_r3": 133}


def main():
    import warnings
    warnings.filterwarnings("ignore")
    from datasets import load_dataset
    rng = random.Random(SEED)
    stats = {"drops": [], "seed": SEED, "license": LIC}
    en_rows, pool_extra = [], []

    for split, want in WANT_ROUND.items():
        ds = load_dataset("facebook/anli", "plain_text", split=split)
        print("ANLI %s: n=%d" % (split, len(ds)), flush=True)
        idx = list(range(len(ds)))
        rng.shuffle(idx)
        got, extra = 0, []
        for i in idx:
            r = ds[i]
            lab = int(r["label"])
            text = "%s || %s" % (r["premise"], r["hypothesis"])
            d = denied(text)
            if d:
                stats["drops"].append({"id": "anli-%s" % r["uid"], "reason": "denylist:" + d})
                continue
            row = {"premise": r["premise"], "hypothesis": r["hypothesis"], "lab": lab,
                   "uid": r["uid"], "split": split}
            if got < want:
                en_rows.append(row); got += 1
            else:
                extra.append(row)
        pool_extra.extend(extra)
        print("  kept %s: %d (+%d spare)" % (split, got, len(extra)), flush=True)
    rng.shuffle(pool_extra)
    assert len(en_rows) == 400, "B2-EN short: %d" % len(en_rows)

    out_en = []
    for k, r in enumerate(en_rows, 1):
        out_en.append({"id": "b2-gate-en-%s-%03d" % (TAG[r["lab"]], k),
                       "text": "%s || %s" % (r["premise"], r["hypothesis"]),
                       "all_labels": GATE_CANDS, "true_labels": X2G[r["lab"]],
                       "source": "facebook/anli:%s" % r["split"], "license": LIC,
                       "lang": "en", "orig_id": "anli-%s" % r["uid"]})

    # ---- ES mirror: stratified 200 from EN rows ----
    by_lab = {0: [], 1: [], 2: []}
    for r in en_rows:
        by_lab[r["lab"]].append(r)
    want_lab = {0: 67, 1: 66, 2: 67}
    mirror, spare = [], []
    for lab, w in want_lab.items():
        rng.shuffle(by_lab[lab])
        mirror.extend(by_lab[lab][:w])
        spare.extend(by_lab[lab][w:])
    rng.shuffle(spare)
    spare.extend(pool_extra)

    device = detect_device()
    print("MT device:", device, flush=True)
    es_rows, used_uids = [], set()
    candidates = list(mirror)
    while len(es_rows) < 200 and candidates:
        batch = candidates[:100]
        candidates = candidates[100:]
        ps = [r["premise"] for r in batch]
        hs = [r["hypothesis"] for r in batch]
        es_p = translate(ps, "en-es", device)
        es_h = translate(hs, "en-es", device)
        bk_p = translate(es_p, "es-en", device)
        bk_h = translate(es_h, "es-en", device)
        en_j = ["%s || %s" % (p, h) for p, h in zip(ps, hs)]
        bk_j = ["%s || %s" % (p, h) for p, h in zip(bk_p, bk_h)]
        es_j = ["%s || %s" % (p, h) for p, h in zip(es_p, es_h)]
        keeps, reasons = verify_rows(en_j, es_j, bk_j,
                                     lambda a, b: jacc(trigrams(a), trigrams(b)))
        for r, esp, esh, keep, why in zip(batch, es_p, es_h, keeps, reasons):
            if not keep:
                stats["drops"].append({"id": "anli-%s-es" % r["uid"],
                                      "reason": "mt-reverify:" + why})
                continue
            text = "%s || %s" % (esp, esh)
            d = denied(text)
            if d:
                stats["drops"].append({"id": "anli-%s-es" % r["uid"],
                                      "reason": "denylist:" + d})
                continue
            es_rows.append({"row": r, "text": text})
        if len(es_rows) < 200 and not candidates and spare:
            take = min(len(spare), 100)
            candidates = spare[:take]
            spare = spare[take:]
            print("  top-up: %d more candidates (%d ES so far)" % (take, len(es_rows)),
                  flush=True)

    if len(es_rows) > 200:
        stats["over_quota_unused"] = len(es_rows) - 200
        es_rows = es_rows[:200]
    assert len(es_rows) == 200, "B2-ES short: %d" % len(es_rows)
    out_es = []
    for k, e in enumerate(es_rows, 1):
        r = e["row"]
        out_es.append({"id": "b2-gate-es-%s-%03d" % (TAG[r["lab"]], k),
                       "text": e["text"], "all_labels": GATE_CANDS,
                       "true_labels": X2G[r["lab"]],
                       "source": "facebook/anli:%s:es-mirror-mt" % r["split"],
                       "license": LIC, "lang": "es",
                       "orig_id": "anli-%s#es" % r["uid"]})

    write_jsonl(os.path.join(BASE, "b2-anli.jsonl"), out_en + out_es)
    stats["total"] = len(out_en) + len(out_es)
    stats["en"] = len(out_en)
    stats["es"] = len(out_es)
    json.dump(stats, open(os.path.join(BASE, "b2-stats.json"), "w"), indent=1)
    print("B2 TOTAL: %d EN + %d ES" % (len(out_en), len(out_es)))


if __name__ == "__main__":
    main()
