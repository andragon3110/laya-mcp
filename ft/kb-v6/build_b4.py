"""kb-v6 B4 verify scale: fever.ai train.jsonl, 900 rows (SUP/REF/NEI 300/300/300),
EN 600 / ES 300 (MT mirror, same protocol as B2/B3).

Evidence = live Wikipedia intro extracts of the claim's evidence pages
(cached in kb-v6/raw/wiki-cache.json); NEI rows pair the claim with an
unrelated page's extract (true silence). SUP+REF rows sharing an evidence
page get a shared pair_id (contrastive pairs). Oversample x1.3 for mirror
headroom; EN file downselected to quota. Seed 606104.
License CC-BY-SA-3.0 (HF fever/fever tags license:cc-by-sa-3.0; the gpl-3.0
tag covers the HF loader script, not the data — v4 precedent).
"""
import json
import os
import random
import re
import sys
import urllib.parse
import urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "raw")
sys.path.insert(0, BASE)
from kb_util import GATE_CANDS, denied, trigrams, jacc, write_jsonl
from mt import translate, verify_rows, detect_device

SEED = 606104
LIC = "CC-BY-SA-3.0"
UA = {"User-Agent": "laya-mcp-kb-v6/1.0 (research data prep; contact: repo owner)"}
FEVER_URL = "https://fever.ai/download/fever/train.jsonl"
WANT = {"SUP": 400, "REF": 400, "NEI": 400}   # oversample; file keeps 300 each
F_WANT = {"SUP": 300, "REF": 300, "NEI": 300}
EN_Q = {"SUP": 200, "REF": 200, "NEI": 200}   # EN file per verdict
ES_Q = {"SUP": 100, "REF": 100, "NEI": 100}   # ES mirror per verdict


def fever_title(t):
    for a, b in (("-LRB-", "("), ("-RRB-", ")"), ("-LSB-", "["),
                  ("-RSB-", "]"), ("-LCB-", "{"), ("-RCB-", "}")):
        t = t.replace(a, b)
    return t.replace("_", " ")


def wiki_extracts(titles):
    cache_path = os.path.join(RAW, "wiki-cache.json")
    cache = {}
    if os.path.exists(cache_path):
        cache = json.load(open(cache_path, encoding="utf-8"))
    missing = [t for t in titles if t not in cache]
    import time
    for i in range(0, len(missing), 20):
        time.sleep(2)
        batch = missing[i:i + 20]
        data = None
        for attempt in range(4):
            try:
                q = urllib.parse.urlencode({
                    "action": "query", "prop": "extracts", "exintro": "1",
                    "explaintext": "1", "redirects": "1", "format": "json",
                    "titles": "|".join(batch)})
                req = urllib.request.Request(
                    "https://en.wikipedia.org/w/api.php?" + q, headers=UA)
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = json.load(r)
                break
            except Exception as e:
                print("  wiki retry %d (%s)" % (attempt + 1, str(e)[:80]), flush=True)
                time.sleep(5 * (attempt + 1))
        if data is None:
            for t in batch:
                cache.setdefault(t, "")
            json.dump(cache, open(cache_path, "w", encoding="utf-8"),
                      ensure_ascii=False)
            continue
        for p in data.get("query", {}).get("pages", {}).values():
            if "missing" not in p and p.get("extract"):
                cache[p.get("title", "")] = p["extract"][:900]
        for t in batch:
            cache.setdefault(t, "")
        json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
        print("  wiki batch %d/%d cache=%d" % (i // 20 + 1, (len(missing) + 19) // 20,
                                              len(cache)), flush=True)
    out = {}
    lower = {k.lower(): v for k, v in cache.items()}
    for t in titles:
        out[t] = cache.get(t, lower.get(t.lower().replace("_", " "),
                                        lower.get(t.lower(), "")))
    return out


def main():
    import warnings
    warnings.filterwarnings("ignore")
    rng = random.Random(SEED)
    os.makedirs(RAW, exist_ok=True)
    stats = {"drops": [], "seed": SEED, "license": LIC}

    fp = os.path.join(RAW, "fever-train.jsonl")
    if not os.path.exists(fp):
        print("downloading fever train (33MB)...", flush=True)
        req = urllib.request.Request(FEVER_URL, headers=UA)
        with urllib.request.urlopen(req, timeout=300) as r, open(fp, "wb") as f:
            f.write(r.read())
        print("saved %d bytes" % os.path.getsize(fp), flush=True)
    else:
        print("reusing downloaded %s (%d bytes)" % (fp, os.path.getsize(fp)), flush=True)

    fever = []
    with open(fp, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            ev = r.get("evidence") or []
            titles = []
            for eset in ev:
                for e in eset:
                    if len(e) >= 3 and e[2]:
                        titles.append(e[2])
            fever.append({"fid": r["id"], "label": r["label"],
                          "claim": r["claim"], "titles": titles})
    by_label = {"SUPPORTS": [r for r in fever if r["label"] == "SUPPORTS" and r["titles"]],
                "REFUTES": [r for r in fever if r["label"] == "REFUTES" and r["titles"]],
                "NEI": [r for r in fever if r["label"] == "NOT ENOUGH INFO"]}
    for k in by_label:
        rng.shuffle(by_label[k])
    print("pool: %s" % {k: len(v) for k, v in by_label.items()}, flush=True)

    sel = {"SUP": [], "REF": [], "NEI": []}
    for key, pool in (("SUP", by_label["SUPPORTS"]), ("REF", by_label["REFUTES"]),
                      ("NEI", by_label["NEI"])):
        for r in pool:
            if len(sel[key]) >= WANT[key]:
                break
            if denied(r["claim"]):
                stats["drops"].append({"id": "fever-%s" % r["fid"],
                                      "reason": "denylist-claim"})
                continue
            sel[key].append(r)

    need = {t for r in sel["SUP"] + sel["REF"] for t in r["titles"][:2]}
    need_norm = {t: fever_title(t) for t in need}
    print("fetching %d wiki extracts..." % len(set(need_norm.values())), flush=True)
    extracts = wiki_extracts(sorted(set(need_norm.values())))
    extracts = {t: extracts.get(need_norm[t], "") for t in need}
    pool_pages = [t for t in need if extracts.get(t)]
    rng.shuffle(pool_pages)
    print("usable extracts: %d" % len(pool_pages), flush=True)

    pool = []  # oversample rows with verdict tags

    def add_row(r, kind, page):
        ext = extracts.get(page, "")
        if not ext:
            return "no-extract"
        title = page.replace("_", " ")
        text = "wikipedia %s: %s || %s" % (title, ext, r["claim"])
        d = denied(text)
        if d:
            return "denylist:" + d
        true = {"SUP": ["SUPPORTED"], "REF": ["CONTRADICTED"], "NEI": []}[kind]
        pool.append({"verdict": kind, "text": text, "page": page,
                     "fid": r["fid"], "true": true})
        return None

    for r in sel["SUP"][:WANT["SUP"]]:
        for t in r["titles"][:3]:
            err = add_row(r, "SUP", t)
            if err is None or len([x for x in pool if x["verdict"] == "SUP"]) >= WANT["SUP"]:
                break
    for r in sel["REF"][:WANT["REF"]]:
        for t in r["titles"][:3]:
            err = add_row(r, "REF", t)
            if err is None or len([x for x in pool if x["verdict"] == "REF"]) >= WANT["REF"]:
                break
    # count real failures
    pi = 0
    for r in sel["NEI"]:
        if len([x for x in pool if x["verdict"] == "NEI"]) >= WANT["NEI"]:
            break
        page = pool_pages[pi % len(pool_pages)]
        pi += 1
        add_row(r, "NEI", page)
    cv = {k: len([x for x in pool if x["verdict"] == k]) for k in ("SUP", "REF", "NEI")}
    print("oversample pool:", cv, flush=True)
    assert all(cv[k] >= F_WANT[k] for k in cv), "B4 pool short: %s" % cv

    # contrastive pair_ids on shared pages (over the pool; file inherits)
    by_page = {}
    for idx, x in enumerate(pool):
        if x["verdict"] in ("SUP", "REF"):
            by_page.setdefault(x["page"], []).append(idx)
    pair_n = 0
    for page, idxs in by_page.items():
        s = [i for i in idxs if pool[i]["verdict"] == "SUP"]
        c = [i for i in idxs if pool[i]["verdict"] == "REF"]
        for a, b in zip(s, c):
            pair_n += 1
            pid = "b4pair-%s-%02d" % (
                re.sub(r"[^a-z0-9]+", "-", page.lower()).strip("-")[:40], pair_n)
            pool[a]["pair_id"] = pid
            pool[b]["pair_id"] = pid
    print("contrastive pairs: %d" % pair_n, flush=True)

    # EN file: first EN_Q per verdict (pool order = shuffled claim order)
    en, seen_n = [], {k: 0 for k in EN_Q}
    for x in pool:
        if seen_n[x["verdict"]] < EN_Q[x["verdict"]]:
            en.append(x)
            seen_n[x["verdict"]] += 1
    tag = {"SUP": "sup", "REF": "con", "NEI": "nei"}
    out_en, counters = [], {}
    for x in en:
        counters[x["verdict"]] = counters.get(x["verdict"], 0) + 1
        row = {"id": "b4-gate-en-%s-%03d" % (tag[x["verdict"]], counters[x["verdict"]]),
               "text": x["text"], "all_labels": GATE_CANDS, "true_labels": x["true"],
               "source": "fever/fever-train", "license": LIC, "lang": "en",
               "orig_id": "fever-%s" % x["fid"]}
        if "pair_id" in x:
            row["pair_id"] = x["pair_id"]
        out_en.append(row)

    # ES mirror from the pool (stratified ES_Q)
    by_v = {k: [x for x in pool if x["verdict"] == k] for k in ES_Q}
    for k in by_v:
        rng.shuffle(by_v[k])
    mirror = []
    for k, w in ES_Q.items():
        mirror.extend(by_v[k][:w])
    spare = [x for k in by_v for x in by_v[k] if x not in mirror]
    rng.shuffle(spare)
    device = detect_device()
    print("MT device:", device, flush=True)
    es_rows, candidates = [], list(mirror)
    B = 100
    while len(es_rows) < 300 and candidates:
        batch = candidates[:B]
        candidates = candidates[B:]
        parts = [x["text"].split(" || ", 1) for x in batch]
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
        for x, t, keep, why in zip(batch, es_j, keeps, reasons):
            if not keep:
                stats["drops"].append({"id": "fever-%s#es" % x["fid"],
                                      "reason": "mt-reverify:" + why})
                continue
            if denied(t):
                stats["drops"].append({"id": "fever-%s#es" % x["fid"],
                                      "reason": "denylist:" + denied(t)})
                continue
            es_rows.append({"x": x, "text": t})
        if len(es_rows) < 300 and not candidates and spare:
            take = min(len(spare), B)
            candidates = spare[:take]
            spare = spare[take:]
    if len(es_rows) > 300:
        stats["over_quota_unused"] = len(es_rows) - 300
        es_rows = es_rows[:300]
    assert len(es_rows) == 300, "B4-ES short: %d" % len(es_rows)

    out_es, n_es = [], 0
    for s in es_rows:
        n_es += 1
        x = s["x"]
        row = {"id": "b4-gate-es-%s-%03d" % (tag[x["verdict"]], 200 + n_es),
               "text": s["text"], "all_labels": GATE_CANDS, "true_labels": x["true"],
               "source": "fever/fever-train:es-mirror-mt", "license": LIC,
               "lang": "es", "orig_id": "fever-%s#es" % x["fid"]}
        out_es.append(row)

    write_jsonl(os.path.join(BASE, "b4-fever.jsonl"), out_en + out_es)
    stats.update({"total": 900, "en": len(out_en), "es": len(out_es),
                  "pairs_mined": pair_n})
    json.dump(stats, open(os.path.join(BASE, "b4-stats.json"), "w"), indent=1)
    print("B4 TOTAL: %d EN + %d ES" % (len(out_en), len(out_es)))


if __name__ == "__main__":
    main()
