"""base-v4 solidity checker: schema + overlap (0-tolerance) + balance + ES share.

Overlap precedent: ft/gen_gate_v3.py / ft/gen_anchors_v2.py (ids + exact +
token-3-gram Jaccard, refuse any pair >= 0.5; denylist from gen_gate_v3).
Universes: ft/base-v4/eval-universe.json (220 ids+texts) + prior-mix texts
(644 reusable rows, referenced by path, never copied).
Exit 0 = all green; exit 2 = overlap/balance failure (missing list to stdout).
"""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))
sys.path.insert(0, os.path.join(REPO, "ft"))
from build import DENY  # noqa: E402  (single source for the denylist)

FILES = ["gate-fever.jsonl", "gate-nli-es.jsonl", "gate-nli-en.jsonl",
         "screen-deepset.jsonl", "screen-bipia.jsonl"]
GATE = {"SUPPORTED", "CONTRADICTED", "ABSTAIN"}
SCREEN = {"benign", "suspicious", "malicious"}


def norm(s):
    return re.sub(r"\s+", " ", s.strip().lower())


def trigrams(s):
    toks = norm(s).split()
    if len(toks) < 3:
        return {" ".join(toks)}
    return {" ".join(toks[i:i + 3]) for i in range(len(toks) - 2)}


def jacc(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def main():
    rows = []
    for fn in FILES:
        with open(os.path.join(BASE, fn), encoding="utf-8") as f:
            for ln, line in enumerate(f, 1):
                if line.strip():
                    r = json.loads(line)
                    r["_file"] = fn
                    rows.append(r)
    print(f"rows: {len(rows)}")
    errs = []

    # ---- schema ----
    ids = [r.get("id") for r in rows]
    if len(set(ids)) != len(ids):
        errs.append("duplicate ids")
    for r in rows:
        for k in ("id", "text", "all_labels", "true_labels", "source", "license", "lang"):
            if k not in r:
                errs.append(f"{r.get('id')} missing {k}")
        if r.get("lang") not in ("en", "es"):
            errs.append(f"{r.get('id')} bad lang")
        al, tl = set(r.get("all_labels", [])), set(r.get("true_labels", []))
        if not tl <= al:
            errs.append(f"{r['id']} true not subset of all")
        if al == GATE:
            if tl not in ({"SUPPORTED"}, {"CONTRADICTED"}, set()):
                errs.append(f"{r['id']} bad gate true {tl}")
        elif al == SCREEN:
            if tl not in ({"benign"}, {"malicious"}, {"suspicious"}, set()):
                errs.append(f"{r['id']} bad screen true {tl}")
        else:
            errs.append(f"{r['id']} unknown candidate set {sorted(al)}")
        if not r.get("text") or len(r["text"]) > 4000:
            errs.append(f"{r['id']} text length issue ({len(r.get('text', ''))})")
    print("schema:", "PASS" if not errs else f"FAIL {errs[:10]}")

    # ---- balance ----
    sup = sum(1 for r in rows if r["true_labels"] == ["SUPPORTED"])
    con = sum(1 for r in rows if r["true_labels"] == ["CONTRADICTED"])
    nei = sum(1 for r in rows if r["true_labels"] == [])
    mal = sum(1 for r in rows if r["true_labels"] == ["malicious"])
    ben = sum(1 for r in rows if r["true_labels"] == ["benign"])
    es = sum(1 for r in rows if r["lang"] == "es")
    print(f"gate SUP/CON/NEI = {sup}/{con}/{nei} | screen MAL/BEN = {mal}/{ben} | ES = {es}/{len(rows)} ({es / len(rows):.1%})")
    bal = {}
    for name, a, b in (("SUP-CON", sup, con), ("SUP-NEI", sup, nei), ("MAL-BEN", mal, ben)):
        dev = abs(a - b) / max(a + b, 1)
        bal[name] = round(dev, 4)
        print(f"  balance {name}: {a} vs {b} dev={dev:.2%} {'PASS' if dev <= 0.10 else 'FAIL'}")
    es_ok = es / len(rows) >= 0.40
    print(f"  ES share >=40%: {'PASS' if es_ok else 'FAIL'}")

    # ---- overlap vs eval universe ----
    ev = json.load(open(os.path.join(BASE, "eval-universe.json"), encoding="utf-8"))
    assert len(ev["ids"]) == 220 and len(ev["texts"]) == 220, "universe size drift"
    ev_ids = set(ev["ids"])
    ev_texts = {norm(t) for t in ev["texts"]}
    ev_tris = [(t, trigrams(t)) for t in ev["texts"]]
    id_over = sorted(set(ids) & ev_ids)
    exact_over = sorted({r["id"] for r in rows if norm(r["text"]) in ev_texts})
    deny = []
    for r in rows:
        t = norm(r["text"])
        for d in DENY:
            if (re.search(r"\b" + re.escape(d) + r"\b", t) if " " not in d else (d in t)):
                deny.append((r["id"], d))
                break
    worst = []
    for r in rows:
        rt = trigrams(r["text"])
        for et, ets in ev_tris:
            j = jacc(rt, ets)
            if j >= 0.3:
                worst.append((j, r["id"]))
    worst.sort(reverse=True)
    pairs_hi = [w for w in worst if w[0] >= 0.5]
    # global max (even below reporting floor) for an honest max-score report
    gj = 0.0
    for r in rows:
        rt = trigrams(r["text"])
        for _, ets in ev_tris:
            j = jacc(rt, ets)
            if j > gj:
                gj = j
    jmax = gj
    print(f"overlap-eval: ids={len(id_over)} exact={len(exact_over)} denylist={len(deny)} "
          f"maxJ3={jmax:.4f} pairs>=0.5={len(pairs_hi)}")
    for j, i in worst[:5]:
        print(f"  topJ {j:.4f} {i}")

    # ---- overlap vs prior-mix texts (reusable 644, by reference) ----
    mix_paths = ["artifacts-ft/mix-regulus-v2/anchors-train.jsonl",
                 "artifacts-ft/mix-regulus-v2/batch4-train.jsonl",
                 "artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl"]
    mix_texts = []
    for p in mix_paths:
        with open(os.path.join(REPO, p), encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    mix_texts.append(json.loads(line)["text"])
    print(f"prior-mix texts: {len(mix_texts)}")
    mix_norm = {norm(t) for t in mix_texts}
    mix_tris = [trigrams(t) for t in mix_texts]
    exact_mix = sorted({r["id"] for r in rows if norm(r["text"]) in mix_norm})
    jmax_mix, top_mix = 0.0, []
    for r in rows:
        rt = trigrams(r["text"])
        for mt in mix_tris:
            j = jacc(rt, mt)
            if j > jmax_mix:
                jmax_mix = j
                top_mix = [(j, r["id"])]
    pairs_mix = jmax_mix >= 0.5
    print(f"overlap-mix: exact={len(exact_mix)} maxJ3={jmax_mix:.4f} pairs>=0.5={pairs_mix}")

    ok = (not errs and not id_over and not exact_over and not deny and not pairs_hi
          and not exact_mix and not pairs_mix and all(v <= 0.10 for v in bal.values()) and es_ok)
    report = {"n": len(rows), "schema_errors": errs[:20], "balance": {"sup": sup, "con": con,
              "nei": nei, "mal": mal, "ben": ben, "dev": bal, "es": es},
              "overlap_eval": {"ids": id_over, "exact": exact_over, "denylist": deny,
                               "maxJ3": round(jmax, 4), "pairs_ge_0.5": pairs_hi[:10],
                               "top5": [(round(j, 4), i) for j, i in worst[:5]]},
              "overlap_mix": {"exact": exact_mix, "maxJ3": round(jmax_mix, 4),
                              "top": [(round(j, 4), i) for j, i in top_mix]},
              "verdict": "PASS" if ok else "FAIL"}
    json.dump(report, open(os.path.join(BASE, "check-report.json"), "w", encoding="utf-8"), indent=1)
    print("CHECK:", report["verdict"])
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
