"""kb-v6 solidity checker: schema + provenance + overlap (0-tolerance) +
balance + ES share. Precedent: ft/base-v4/check.py (ids + exact +
token-3-gram Jaccard>=0.5 refuse + denylist from gen_gate_v3 single source).

Universes: fresh 220 (eval-universe.json) + mix-v2 244 ids / 337 texts
(EXTENDED exclusion: batch4-train ids included). Exit 0 = SOLID-pass,
exit 2 = NOT-SOLID (missing list to stdout).
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))
sys.path.insert(0, BASE)
from kb_util import norm, denied, trigrams, jacc

FILES = ["b1-nli-core.jsonl", "b2-anli.jsonl", "b3-verify-contrast.jsonl",
         "b4-fever.jsonl", "b5-screen.jsonl", "b6-classify.jsonl", "b7-silence.jsonl"]
GATE = {"SUPPORTED", "CONTRADICTED", "ABSTAIN"}
SCREEN = {"benign", "suspicious", "malicious"}
CLASSIFY = {"bug", "feature", "other"}


def main():
    rows = []
    per_file = {}
    for fn in FILES:
        fr = []
        with open(os.path.join(BASE, fn), encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    r["_file"] = fn
                    rows.append(r)
                    fr.append(r)
        per_file[fn] = len(fr)
    print("rows: %d %s" % (len(rows), per_file))
    errs = []

    ids = [r.get("id") for r in rows]
    if len(set(ids)) != len(ids):
        errs.append("duplicate ids")
    for r in rows:
        for k in ("id", "text", "all_labels", "true_labels", "source", "license",
                  "lang", "orig_id"):
            if k not in r:
                errs.append("%s missing %s" % (r.get("id"), k))
        if r.get("lang") not in ("en", "es"):
            errs.append("%s bad lang" % r.get("id"))
        al, tl = set(r.get("all_labels", [])), set(r.get("true_labels", []))
        if not tl <= al:
            errs.append("%s true not subset of all" % r["id"])
        if al == GATE:
            if tl not in ({"SUPPORTED"}, {"CONTRADICTED"}, set()):
                errs.append("%s bad gate true %s" % (r["id"], tl))
        elif al == SCREEN:
            if tl not in ({"benign"}, {"malicious"}, {"suspicious"}, set()):
                errs.append("%s bad screen true %s" % (r["id"], tl))
        elif al == CLASSIFY:
            if tl not in ({"bug"}, {"feature"}, {"other"}):
                errs.append("%s bad classify true %s" % (r["id"], tl))
        else:
            errs.append("%s unknown candidate set" % r["id"])
        if not r.get("text") or len(r["text"]) > 4000:
            errs.append("%s text length %d" % (r["id"], len(r.get("text", ""))))
        if not r.get("source") or not r.get("license"):
            errs.append("%s provenance gap" % r["id"])
    print("schema+provenance:", "PASS" if not errs else "FAIL %s" % errs[:10])

    # ---- balance ----
    sup = sum(1 for r in rows if r["true_labels"] == ["SUPPORTED"])
    con = sum(1 for r in rows if r["true_labels"] == ["CONTRADICTED"])
    abst = sum(1 for r in rows if set(r["all_labels"]) == GATE and r["true_labels"] == [])
    mal = sum(1 for r in rows if r["true_labels"] == ["malicious"])
    ben = sum(1 for r in rows if r["true_labels"] == ["benign"])
    sus = sum(1 for r in rows if r["true_labels"] == ["suspicious"])
    es = sum(1 for r in rows if r["lang"] == "es")
    print("gate SUP/CON/ABSTAIN=%d/%d/%d | screen MAL/BEN/SUS=%d/%d/%d | ES=%d/%d (%.1f%%)"
          % (sup, con, abst, mal, ben, sus, es, len(rows), 100.0 * es / len(rows)))
    # B3+B4 gate balance (spec locus)
    b34 = [r for r in rows if r["_file"] in ("b3-verify-contrast.jsonl", "b4-fever.jsonl")]
    s3 = sum(1 for r in b34 if r["true_labels"] == ["SUPPORTED"])
    c3 = sum(1 for r in b34 if r["true_labels"] == ["CONTRADICTED"])
    n3 = sum(1 for r in b34 if r["true_labels"] == [])
    print("B3+B4 SUP/CON/NEI=%d/%d/%d" % (s3, c3, n3))
    bal = {}
    for name, a, b in (("B1-2-3-4-7 SUP-CON", sup, con),
                       ("B3+B4 SUP-CON", s3, c3),
                       ("B3+B4 SUP-NEI", s3, n3),
                       ("B3+B4 CON-NEI", c3, n3),
                       ("B5 MAL-BEN", mal, ben)):
        dev = abs(a - b) / max(a + b, 1)
        bal[name] = round(dev, 4)
        print("  balance %s: %d vs %d dev=%.2f%% %s"
              % (name, a, b, 100 * dev, "PASS" if dev <= 0.10 else "FAIL"))
    es_ok = es / len(rows) >= 0.40
    print("  ES share >=40%%: %s" % ("PASS" if es_ok else "FAIL"))

    # ---- overlap vs EXTENDED universe ----
    ev = json.load(open(os.path.join(BASE, "eval-universe.json"), encoding="utf-8"))
    mx = json.load(open(os.path.join(REPO, "artifacts-ft", "mix-regulus-v2",
                                     "eval-texts.json"), encoding="utf-8"))
    mix_ids = [l.strip() for l in open(os.path.join(
        REPO, "artifacts-ft", "mix-regulus-v2", "eval-ids.txt"), encoding="utf-8")
        if l.strip()]
    uni_ids = set(ev["ids"]) | set(mix_ids)
    uni_texts = list(ev["texts"]) + list(mx["texts"])
    print("universe: %d ids, %d texts" % (len(uni_ids), len(uni_texts)))
    ev_texts = {norm(t) for t in uni_texts}
    ev_tris = [(t, trigrams(t)) for t in uni_texts]
    id_over = sorted(set(ids) & uni_ids)
    exact_over = sorted({r["id"] for r in rows if norm(r["text"]) in ev_texts})
    deny = []
    for r in rows:
        d = denied(r["text"])
        if d:
            deny.append((r["id"], d))
    worst = []
    for r in rows:
        rt = trigrams(r["text"])
        for _, ets in ev_tris:
            j = jacc(rt, ets)
            if j >= 0.3:
                worst.append((j, r["id"]))
    worst.sort(reverse=True)
    pairs_hi = [w for w in worst if w[0] >= 0.5]
    gj = 0.0
    for r in rows:
        rt = trigrams(r["text"])
        for _, ets in ev_tris:
            j = jacc(rt, ets)
            if j > gj:
                gj = j
    print("overlap-eval: ids=%d exact=%d denylist=%d maxJ3=%.4f pairs>=0.5=%d"
          % (len(id_over), len(exact_over), len(deny), gj, len(pairs_hi)))
    for j, i in worst[:5]:
        print("  topJ %.4f %s" % (j, i))

    ok = (not errs and not id_over and not exact_over and not deny and not pairs_hi
          and all(v <= 0.10 for v in bal.values()) and es_ok)
    report = {"n": len(rows), "per_file": per_file,
              "schema_errors": errs[:20],
              "balance": {"sup": sup, "con": con, "abstain_gate": abst,
                          "mal": mal, "ben": ben, "sus": sus,
                          "b34": {"sup": s3, "con": c3, "nei": n3},
                          "dev": bal, "es": es},
              "overlap_eval": {"universe_ids": len(uni_ids),
                               "universe_texts": len(uni_texts),
                               "ids": id_over, "exact": exact_over,
                               "denylist": deny, "maxJ3": round(gj, 4),
                               "pairs_ge_0.5": pairs_hi[:10],
                               "top5": [(round(j, 4), i) for j, i in worst[:5]]},
              "verdict": "PASS" if ok else "FAIL"}
    json.dump(report, open(os.path.join(BASE, "check-report.json"), "w",
                           encoding="utf-8"), indent=1)
    print("CHECK:", report["verdict"])
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
