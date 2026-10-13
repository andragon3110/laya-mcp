"""kb-v6 B3 verify contrastive: tals/vitaminc + tasksource/fool-me-twice +
tasksource/faviq, 700 rows (SUP/CON pairs + NEI), EN 450 / ES 250 (MT mirror).

- VitaminC: SUP+CON pairs share case_id (same evidence, flipped verdict);
  NEI rows are label == NOT ENOUGH INFO. License cc-by-sa-3.0.
- FoolMeTwice: SUP/REF with parsed gold_evidence. License apache-2.0.
- FaVIQ: SUP/REF with non-N/A evidence (positive for SUP, negative for REF
  where real, else whichever is real; both-N/A dropped). License unknown-on-mirror.
- ES 250: stratified MT mirror of the EN 450 (SUP 90 / CON 90 / NEI 70),
  same verdict-preserving protocol as B2. Seed 606103.
"""
import ast
import json
import os
import random
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from kb_util import GATE_CANDS, denied, trigrams, jacc, write_jsonl
from mt import translate, verify_rows, detect_device

SEED = 606103
LIC_VTC = "cc-by-sa-3.0"
LIC_FMT = "apache-2.0"
LIC_FQ = "unknown-on-mirror (no license:* tags; verify before commercial use)"
V2G = {"SUPPORTS": ["SUPPORTED"], "REFUTES": ["CONTRADICTED"], "NOT ENOUGH INFO": []}
CAP_EVI = 900

# Collection quotas (oversample: the ES mirror draws from the same pool,
# re-verify drops are topped up from it; the EN file is downselected to quota)
Q_VTC_PAIR = 105   # file keeps first 85 pairs (NEI-heavy rebalance)
Q_VTC_NEI = 190    # file keeps first 160
Q_FMT = 80         # file keeps first 60
Q_FQ = 80          # file keeps first 60
# EN file quotas (EN 450 = 170 pair-rows + 160 NEI + 60 FMT + 60 FaVIQ)
F_VTC_PAIR = 85
F_VTC_NEI = 160
F_FMT = 60
F_FQ = 60
# ES mirror quotas (from EN pool): SUP 80 / CON 80 / NEI 90 = 250.
# B3 file totals -> SUP 225 / CON 225 / NEI 250; with B4 300/300/300 the
# B3+B4 locus lands at 525/525/550 (dev <= 2.5%).
Q_ES = {"SUP": 80, "CON": 80, "NEI": 90}


def clean(s, cap=CAP_EVI):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s[:cap]


def parse_py(s):
    if isinstance(s, dict):
        return s
    if isinstance(s, list):
        return s
    try:
        return ast.literal_eval(s)
    except Exception:
        return None


def main():
    import warnings
    warnings.filterwarnings("ignore")
    from datasets import load_dataset
    rng = random.Random(SEED)
    stats = {"drops": [], "seed": SEED}
    en = []

    def drop(oid, why):
        stats["drops"].append({"id": oid, "reason": why})

    # ---------- VitaminC ----------
    vtc = load_dataset("tals/vitaminc", "default", split="train")
    print("VITC train: n=%d" % len(vtc), flush=True)
    by_case = {}
    for i in range(len(vtc)):
        r = vtc[i]
        by_case.setdefault(r["case_id"], []).append(i)
    sup_cases = [c for c, ii in by_case.items()
                 if any(vtc[i]["label"] == "SUPPORTS" for i in ii)
                 and any(vtc[i]["label"] == "REFUTES" for i in ii)]
    rng.shuffle(sup_cases)
    pairs = got_sup = got_con = 0
    for c in sup_cases:
        if pairs >= Q_VTC_PAIR:
            break
        s_idx = next(i for i in by_case[c] if vtc[i]["label"] == "SUPPORTS")
        f_idx = next(i for i in by_case[c] if vtc[i]["label"] == "REFUTES")
        cand = []
        for i, tag in ((s_idx, "sup"), (f_idx, "con")):
            r = vtc[i]
            ev, cl = clean(r["evidence"]), clean(r["claim"], 600)
            if not ev or not cl:
                drop(str(r["unique_id"]), "empty-evidence-or-claim"); break
            text = "vitaminc %s: %s || %s" % (r["page"], ev, cl)
            d = denied(text)
            if d:
                drop(str(r["unique_id"]), "denylist:" + d); break
            cand.append((tag, r, text))
        else:
            pairs += 1
            pid = "b3pair-vtc-%03d" % pairs
            for tag, r, text in cand:
                en.append({"verdict": "SUP" if tag == "sup" else "CON",
                           "text": text, "src": "tals/vitaminc-train",
                           "lic": LIC_VTC, "oid": "vitc-%s" % r["unique_id"],
                           "pair_id": pid})
    print("VITC pairs: %d" % pairs, flush=True)
    nei_idx = [i for i in range(len(vtc)) if vtc[i]["label"] == "NOT ENOUGH INFO"]
    rng.shuffle(nei_idx)
    got_nei = 0
    for i in nei_idx:
        if got_nei >= Q_VTC_NEI:
            break
        r = vtc[i]
        ev, cl = clean(r["evidence"]), clean(r["claim"], 600)
        if not ev or not cl:
            drop(str(r["unique_id"]), "empty-evidence-or-claim"); continue
        text = "vitaminc %s: %s || %s" % (r["page"], ev, cl)
        d = denied(text)
        if d:
            drop(str(r["unique_id"]), "denylist:" + d); continue
        got_nei += 1
        en.append({"verdict": "NEI", "text": text, "src": "tals/vitaminc-train",
                   "lic": LIC_VTC, "oid": "vitc-%s" % r["unique_id"]})
    print("VITC NEI: %d" % got_nei, flush=True)

    # ---------- FoolMeTwice ----------
    fmt = load_dataset("tasksource/fool-me-twice", "default", split="train")
    print("FMT train: n=%d" % len(fmt), flush=True)
    order = list(range(len(fmt)))
    rng.shuffle(order)
    got_fmt = {"SUP": 0, "CON": 0}
    for i in order:
        if sum(got_fmt.values()) >= Q_FMT:
            break
        r = fmt[i]
        if r["label"] not in ("SUPPORTS", "REFUTES"):
            continue
        v = "SUP" if r["label"] == "SUPPORTS" else "CON"
        if got_fmt[v] >= (Q_FMT + 1) // 2:
            continue
        gold = parse_py(r["gold_evidence"]) or []
        ev = " ".join(g.get("text", "") for g in gold[:2] if isinstance(g, dict))
        ev, cl = clean(ev), clean(r["text"], 600)
        if not ev or not cl:
            drop(str(r["id"]), "empty-evidence-or-claim"); continue
        text = "foolmetwice %s: %s || %s" % (r["wikipedia_page"], ev, cl)
        d = denied(text)
        if d:
            drop(str(r["id"]), "denylist:" + d); continue
        got_fmt[v] += 1
        en.append({"verdict": v, "text": text, "src": "tasksource/fool-me-twice-train",
                   "lic": LIC_FMT, "oid": "fmt-%s" % r["id"]})
    print("FMT kept:", got_fmt, flush=True)

    # ---------- FaVIQ ----------
    fq = load_dataset("tasksource/faviq", "default", split="train")
    print("FaVIQ train: n=%d" % len(fq), flush=True)
    order = list(range(len(fq)))
    rng.shuffle(order)
    got_fq = {"SUP": 0, "CON": 0}
    for i in order:
        if sum(got_fq.values()) >= Q_FQ:
            break
        r = fq[i]
        if r["label"] not in ("SUPPORTS", "REFUTES"):
            continue
        v = "SUP" if r["label"] == "SUPPORTS" else "CON"
        if got_fq[v] >= (Q_FQ + 1) // 2:
            continue
        pos = parse_py(r["positive_evidence"]) or {}
        neg = parse_py(r["negative_evidence"]) or {}
        ev_src = pos if (v == "SUP" and pos.get("text") not in (None, "", "N/A")) else neg
        if ev_src.get("text") in (None, "", "N/A"):
            ev_src = neg if ev_src is pos else pos
        if ev_src.get("text") in (None, "", "N/A"):
            drop(str(r["id"]), "no-usable-evidence"); continue
        ev, cl = clean(ev_src["text"]), clean(r["claim"], 600)
        if not ev or not cl:
            drop(str(r["id"]), "empty-evidence-or-claim"); continue
        text = "faviq: %s || %s" % (ev, cl)
        d = denied(text)
        if d:
            drop(str(r["id"]), "denylist:" + d); continue
        got_fq[v] += 1
        en.append({"verdict": v, "text": text, "src": "tasksource/faviq-train",
                   "lic": LIC_FQ, "oid": "faviq-%s" % r["id"]})
    print("FaVIQ kept:", got_fq, flush=True)
    print("oversample pool: %d" % len(en), flush=True)
    # ---- downselect EN file to quota (first-N per source, deterministic) ----
    file_pool = []
    n_pair = n_nei = n_fmt = n_fq = 0
    for e in en:
        if e["src"].startswith("tals") and "pair_id" in e and n_pair < F_VTC_PAIR * 2:
            file_pool.append(e); n_pair += 1
        elif e["src"].startswith("tals") and n_nei < F_VTC_NEI:
            file_pool.append(e); n_nei += 1
        elif "fool" in e["src"] and n_fmt < F_FMT:
            file_pool.append(e); n_fmt += 1
        elif e["src"].startswith("tasksource/faviq") and n_fq < F_FQ:
            file_pool.append(e); n_fq += 1
    en_file = file_pool
    assert len(en_file) == 450, "B3-EN short: %d" % len(en_file)

    out_en = []
    counters = {}
    for e in en_file:
        counters[e["verdict"]] = counters.get(e["verdict"], 0) + 1
        row = {"id": "b3-%s-en-%s-%03d" % (
                    "vtc" if e["src"].startswith("tals") else
                    ("fmt" if "fool" in e["src"] else "fq"),
                    e["verdict"].lower(), counters[e["verdict"]]),
               "text": e["text"], "all_labels": GATE_CANDS,
               "true_labels": {"SUP": ["SUPPORTED"], "CON": ["CONTRADICTED"],
                               "NEI": []}[e["verdict"]],
               "source": e["src"], "license": e["lic"], "lang": "en",
               "orig_id": e["oid"]}
        if "pair_id" in e:
            row["pair_id"] = e["pair_id"]
        out_en.append(row)

    # ---------- ES mirror (stratified from EN) ----------
    by_v = {"SUP": [], "CON": [], "NEI": []}
    for e in en:  # full oversample pool feeds the mirror (top-up headroom)
        by_v[e["verdict"]].append(e)
    mirror = []
    for v, w in Q_ES.items():
        rng.shuffle(by_v[v])
        mirror.extend(by_v[v][:w])
    device = detect_device()
    print("MT device:", device, flush=True)
    es_rows = []
    B = 100
    spare = [e for v in by_v.values() for e in v if e not in mirror]
    rng.shuffle(spare)
    candidates = list(mirror)
    while len(es_rows) < 250 and candidates:
        batch = candidates[:B]
        candidates = candidates[B:]
        parts = [e["text"].split(" || ", 1) for e in batch]
        evs = [p[0] for p in parts]
        cls = [p[1] if len(p) > 1 else "" for p in parts]
        es_ev = translate(evs, "en-es", device, batch=8)
        es_cl = translate(cls, "en-es", device, batch=8)
        bk_ev = translate(es_ev, "es-en", device, batch=8)
        bk_cl = translate(es_cl, "es-en", device, batch=8)
        en_j = ["%s || %s" % (a, b) for a, b in zip(evs, cls)]
        es_j = ["%s || %s" % (a, b) for a, b in zip(es_ev, es_cl)]
        bk_j = ["%s || %s" % (a, b) for a, b in zip(bk_ev, bk_cl)]
        keeps, reasons = verify_rows(en_j, es_j, bk_j,
                                     lambda a, b: jacc(trigrams(a), trigrams(b)))
        for e, t, keep, why in zip(batch, es_j, keeps, reasons):
            if not keep:
                drop(e["oid"] + "#es", "mt-reverify:" + why); continue
            if denied(t):
                drop(e["oid"] + "#es", "denylist:" + denied(t)); continue
            es_rows.append({"e": e, "text": t})
        if len(es_rows) < 250 and not candidates and spare:
            take = min(len(spare), B)
            candidates = spare[:take]
            spare = spare[take:]
    if len(es_rows) > 250:
        stats["over_quota_unused"] = len(es_rows) - 250
        es_rows = es_rows[:250]
    assert len(es_rows) == 250, "B3-ES short: %d" % len(es_rows)

    out_es = []
    n_es = 0
    for s in es_rows:
        n_es += 1
        e = s["e"]
        out_es.append({"id": "b3-es-%s-%03d" % (e["verdict"].lower(), n_es),
                       "text": s["text"], "all_labels": GATE_CANDS,
                       "true_labels": {"SUP": ["SUPPORTED"], "CON": ["CONTRADICTED"],
                                       "NEI": []}[e["verdict"]],
                       "source": e["src"] + ":es-mirror-mt", "license": e["lic"],
                       "lang": "es", "orig_id": e["oid"] + "#es"})

    write_jsonl(os.path.join(BASE, "b3-verify-contrast.jsonl"), out_en + out_es)
    stats.update({"total": 700, "en": len(out_en), "es": len(out_es),
                  "pairs": pairs})
    json.dump(stats, open(os.path.join(BASE, "b3-stats.json"), "w"), indent=1)
    print("B3 TOTAL: %d EN + %d ES (pairs=%d)" % (len(out_en), len(out_es), pairs))


if __name__ == "__main__":
    main()
