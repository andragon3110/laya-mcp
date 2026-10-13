"""Regulus-v4 solid base builder (R3+R4, NO training).

Pulls public sources, converts to GLiClass rows {text, all_labels, true_labels,
source, license, lang} in ft/base-v4/ per lane. Deterministic (SEED=424242).

Sources (see SOURCES.json for URLs/licenses/pins):
- FEVER train (official fever.ai/download/fever/train.jsonl, CC-BY-SA-3.0):
  600 gate rows (200 SUP / 200 CON / 200 ABSTAIN-empty), evidence = live
  Wikipedia intro extracts of the claim's evidence pages (cached in
  raw/wiki-cache.json); NEI rows pair the claim with an unrelated page's
  extract (true silence, mirrors gate-silence construction). SUP+CON rows
  sharing an evidence page get a shared pair_id (contrastive pairs).
- facebook/xnli es train (HF parquet, license unlisted on mirror): 750 NLI
  anchors (250 entail/250 neutral/250 contra) -> gate SUPPORTED/ABSTAIN/
  CONTRADICTED, text = "premise || hypothesis".
- facebook/xnli en train (= original MNLI-train, same corpus): 200 NLI
  anchors (67/67/66). Documented lineage, no second MNLI pull.
- deepset/prompt-injections train (Apache-2.0): 150 screen rows
  (75 injection->[malicious] / 75 legit->[benign]).
- geodesic-research/bipia (CC-BY-SA-4.0 mirror of official microsoft/BIPIA
  test files, pinned commit recorded in SOURCES.json): 50 attacked contexts
  ->[malicious] + 50 paired benign (attack_str stripped, verified) ->[benign].
  NOTE: mirror rows come from BIPIA's TEST split (benchmark has no train);
  used as train anchors for OUR screen lane only, never for BIPIA scores.

ABSTAIN encoding per parent spec: true_labels=[] with "ABSTAIN" present in
all_labels (differs from legacy mix encoding labels=["ABSTAIN"]; flagged in
the v4 report for the mix author).

microsoft/BIPIA on HF: does NOT exist (API 401 = nonexistent, calibrated vs a
bogus id) -> BLOCKED per spec; the geodesic mirror above is the substitute.
"""
import json
import os
import random
import re
import sys
import urllib.parse
import urllib.request

SEED = 424242
BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "raw")
UA = {"User-Agent": "laya-mcp-regulus-v4-base/1.0 (research data prep; contact: repo owner)"}

GATE_CANDS = ["SUPPORTED", "CONTRADICTED", "ABSTAIN"]
SCREEN_CANDS = ["benign", "suspicious", "malicious"]

# Denylist copied from ft/gen_gate_v3.py (eval-distinctive phrases; single
# generic CI words deliberately excluded there; distance enforced by
# exact-text + Jaccard in check.py).
DENY = [
    "ship fix", "null check", "empty cart", "carrito vac",
    "all tests pass", "the build is green", "no test failed",
    "todas las pruebas pasan", "no falló ninguna prueba",
    "la compilación quedó en verde", "compilación: ok",
    "all null dereferences are fixed", "todos los inputs inválidos se rechazan",
    "sso", "webhook", "rate limit", "invoice", "csv",
    "pdf viewer", "ignore all previous", "ignora las instrucciones",
    "lorem ipsum", "support hours", "atención del soporte", "migration",
    "migración", "onboarding", "apple pie", "tarta de manzana",
    "quantum", "cuánt", "zebra", "cebra", "revenue", "facturación",
    "reset my password", "restablezco mi contraseña", "disk usage",
    "search-engine", "meta description", "deploy log", "ticket volume",
    "merge pr", "javascript", "loading", "password", "contraseña",
    "system note", "aviso del sistema", "external-review",
    "revision-externa", "summarizer", "resumidor", "export", "exportar",
    "starter plan", "enterprise plan", "spotify", "quarterly",
    "linux", "windows", "uptime", "battery", "batería", "latencia",
    "latency", "throughput", "vulnerability", "vulnerabilidad", "inyección sql", "xss",
    "rollback", "backup", "restauración", "i18n", "todos los idiomas",
    "pii", "never logged", "impossible", "imposible", "siempre funciona",
    "audit script flagged", "soporte técnico",
]


def norm(s):
    return re.sub(r"\s+", " ", s.strip().lower())


def denied(text):
    t = norm(text)
    for d in DENY:
        hit = re.search(r"\b" + re.escape(d) + r"\b", t) if " " not in d else (d in t)
        if hit:
            return d
    return None


def fever_title(t):
    """FEVER wiki titles use -LRB-/-RRB-/-LSB-/-RSB-/-LCB-/-RCB- escapes + underscores."""
    for a, b in (("-LRB-", "("), ("-RRB-", ")"), ("-LSB-", "["),
                  ("-RSB-", "]"), ("-LCB-", "{"), ("-RCB-", "}")):
        t = t.replace(a, b)
    return t.replace("_", " ")


def wiki_extracts(titles):
    """Fetch intro extracts for Wikipedia titles (batched, cached). Returns {title: extract}."""
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
                    "action": "query", "prop": "extracts", "exintro": "1", "explaintext": "1",
                    "redirects": "1", "format": "json", "titles": "|".join(batch),
                })
                req = urllib.request.Request("https://en.wikipedia.org/w/api.php?" + q, headers=UA)
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = json.load(r)
                break
            except Exception as e:
                print(f"  wiki batch retry {attempt + 1} ({e})", flush=True)
                time.sleep(5 * (attempt + 1))
        if data is None:
            print("  wiki batch FAILED x4; titles deferred as missing", flush=True)
            for t in batch:
                cache.setdefault(t, "")
            json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
            continue
        for p in data.get("query", {}).get("pages", {}).values():
            if "missing" not in p and p.get("extract"):
                cache[p.get("title", "")] = p["extract"][:900]
        for t in batch:
            cache.setdefault(t, "")
        json.dump(cache, open(cache_path, "w", encoding="utf-8"), ensure_ascii=False)
        print(f"  wiki batch {i // 20 + 1}/{(len(missing) + 19) // 20}: cache={len(cache)}", flush=True)
    # map requested titles (redirects may rename keys): fall back to normalized lookup
    out = {}
    lower = {k.lower(): v for k, v in cache.items()}
    for t in titles:
        out[t] = cache.get(t, lower.get(t.lower().replace("_", " "), lower.get(t.lower(), "")))
    return out


def main():
    rng = random.Random(SEED)
    stats = {"drops": []}

    def drop(rowid, reason):
        stats["drops"].append({"id": rowid, "reason": reason})

    # ---------- 1. FEVER ----------
    fever = []
    with open(os.path.join(RAW, "fever-train.jsonl"), encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            ev = r.get("evidence") or []
            titles = []
            for eset in ev:
                for e in eset:
                    if len(e) >= 3 and e[2]:
                        titles.append(e[2])
            fever.append({"fid": r["id"], "label": r["label"], "claim": r["claim"], "titles": titles})
    by_label = {"SUPPORTS": [], "REFUTES": [], "NOT ENOUGH INFO": []}
    for r in fever:
        by_label[r["label"]].append(r)
    # SUP/REF need >=1 evidence title; NEI needs none
    sup = [r for r in by_label["SUPPORTS"] if r["titles"]]
    ref = [r for r in by_label["REFUTES"] if r["titles"]]
    nei = by_label["NOT ENOUGH INFO"]
    print(f"FEVER pool: sup={len(sup)} ref={len(ref)} nei={len(nei)}")
    rng.shuffle(sup); rng.shuffle(ref); rng.shuffle(nei)

    sup_sel, ref_sel, nei_sel = [], [], []
    for pool, sel, want in ((sup, sup_sel, 500), (ref, ref_sel, 500), (nei, nei_sel, 260)):
        for r in pool:
            if len(sel) >= want:
                break
            if denied(r["claim"]):
                drop(f"fever-{r['fid']}", "denylist:" + denied(r["claim"]))
                continue
            sel.append(r)
    need_titles = {t for r in sup_sel + ref_sel for t in r["titles"][:2]}
    need_norm = {t: fever_title(t) for t in need_titles}
    print(f"fetching {len(set(need_norm.values()))} wiki extracts...")
    extracts = wiki_extracts(sorted(set(need_norm.values())))
    extracts = {t: extracts.get(need_norm[t], "") for t in need_titles}
    # unrelated-page pool for NEI = extracts of pages bearing on other claims
    pool_pages = [t for t in need_titles if extracts.get(t)]
    rng.shuffle(pool_pages)
    print(f"usable extracts: {len(pool_pages)}")

    fever_rows = []
    used = {"SUP": 0, "REF": 0, "NEI": 0}

    def fever_row(r, kind, page):
        ext = extracts.get(page, "")
        if not ext:
            return None
        title = page.replace("_", " ")
        text = f"wikipedia {title}: {ext} || {r['claim']}"
        if denied(text):
            return None
        true = {"SUP": ["SUPPORTED"], "REF": ["CONTRADICTED"], "NEI": []}[kind]
        return {"text": text, "true": true, "page": page, "fid": r["fid"], "kind": kind}

    for r in sup_sel:
        if used["SUP"] >= 200:
            break
        for t in r["titles"][:3]:
            row = fever_row(r, "SUP", t)
            if row:
                fever_rows.append(row); used["SUP"] += 1
                break
        else:
            drop(f"fever-{r['fid']}", "no usable extract")
    for r in ref_sel:
        if used["REF"] >= 200:
            break
        for t in r["titles"][:3]:
            row = fever_row(r, "REF", t)
            if row:
                fever_rows.append(row); used["REF"] += 1
                break
        else:
            drop(f"fever-{r['fid']}", "no usable extract")
    pi = 0
    for r in nei_sel:
        if used["NEI"] >= 200:
            break
        page = pool_pages[pi % len(pool_pages)]; pi += 1
        row = fever_row(r, "NEI", page)
        if row:
            fever_rows.append(row); used["NEI"] += 1
    print("FEVER selected:", used, "rows:", len(fever_rows))

    # contrastive SUP+CON pairs on shared evidence page
    by_page = {}
    for idx, r in enumerate(fever_rows):
        if r["kind"] in ("SUP", "REF"):
            by_page.setdefault(r["page"], []).append(idx)
    pair_n = 0
    for page, idxs in by_page.items():
        s = [i for i in idxs if fever_rows[i]["kind"] == "SUP"]
        c = [i for i in idxs if fever_rows[i]["kind"] == "REF"]
        for a, b in zip(s, c):
            pair_n += 1
            pid = f"b4pair-{re.sub(r'[^a-z0-9]+', '-', page.lower()).strip('-')[:40]}-{pair_n:02d}"
            fever_rows[a]["pair_id"] = pid
            fever_rows[b]["pair_id"] = pid
    stats["fever_pairs"] = pair_n
    stats["fever_paired_rows"] = pair_n * 2
    print(f"FEVER contrastive pairs: {pair_n} ({pair_n * 2} rows)")

    out_fever = []
    counters = {"SUP": 0, "REF": 0, "NEI": 0}
    tag = {"SUP": "sup", "REF": "con", "NEI": "nei"}
    for r in fever_rows:
        counters[r["kind"]] += 1
        row = {"id": f"b4f-gate-en-{tag[r['kind']]}-{counters[r['kind']]:03d}",
               "text": r["text"], "all_labels": GATE_CANDS, "true_labels": r["true"],
               "source": "fever/fever-train", "license": "CC-BY-SA-3.0",
               "lang": "en", "orig_id": f"fever-{r['fid']}"}
        if "pair_id" in r:
            row["pair_id"] = r["pair_id"]
        out_fever.append(row)

    # ---------- 2-4. HF sources ----------
    sys.path.append(os.path.join(BASE, ".pylibs"))
    import warnings
    warnings.filterwarnings("ignore")
    from datasets import load_dataset

    XNLI2GATE = {0: ["SUPPORTED"], 1: [], 2: ["CONTRADICTED"]}
    XNLI_TAG = {0: "ent", 1: "neu", 2: "con"}

    def sample_xnli(cfg, per_class, prefix, lic):
        ds = load_dataset("facebook/xnli", cfg, split="train")
        print(f"XNLI {cfg}: n={len(ds)}")
        buckets = {0: [], 1: [], 2: []}
        for i, lab in enumerate(ds["label"]):
            buckets[int(lab)].append(i)
        rows = []
        for lab in (0, 1, 2):
            rng.shuffle(buckets[lab])
            take = per_class if isinstance(per_class, int) else per_class[lab]
            got = 0
            for i in buckets[lab]:
                if got >= take:
                    break
                p, h = ds[i]["premise"], ds[i]["hypothesis"]
                text = f"{p} || {h}"
                if denied(text):
                    drop(f"xnli-{cfg}-{i}", "denylist")
                    continue
                got += 1
                rows.append({"id": f"{prefix}-{XNLI_TAG[lab]}-{got:03d}", "text": text,
                             "all_labels": GATE_CANDS, "true_labels": XNLI2GATE[lab],
                             "source": f"facebook/xnli:{cfg}-train", "license": lic,
                             "lang": cfg, "orig_id": f"xnli-{cfg}-{i}"})
        return rows

    XNLI_LIC = "unlisted-on-mirror (upstream XNLI Conneau et al. 2018; verify before commercial use)"
    out_es = sample_xnli("es", 250, "b4x-gate-es", XNLI_LIC)
    out_en = sample_xnli("en", {0: 67, 1: 66, 2: 67}, "b4m-gate-en", XNLI_LIC)
    print(f"XNLI rows: es={len(out_es)} en={len(out_en)}")

    # ---------- 5. deepset ----------
    ds = load_dataset("deepset/prompt-injections", split="train")
    inj = [i for i, l in enumerate(ds["label"]) if l == 1]
    leg = [i for i, l in enumerate(ds["label"]) if l == 0]
    rng.shuffle(inj); rng.shuffle(leg)
    out_ds = []
    for k, i in enumerate(inj[:110], 1):
        t = ds[i]["text"]
        if denied(t):
            drop(f"deepset-{i}", "denylist")
            continue
        out_ds.append({"id": f"b4d-screen-en-inj-{len([r for r in out_ds if 'inj' in r['id']]) + 1:03d}",
                       "text": t, "all_labels": SCREEN_CANDS, "true_labels": ["malicious"],
                       "source": "deepset/prompt-injections-train", "license": "Apache-2.0",
                       "lang": "en", "orig_id": f"deepset-{i}"})
        if sum(1 for r in out_ds if "inj" in r["id"]) >= 75:
            break
    for i in leg:
        if sum(1 for r in out_ds if "leg" in r["id"]) >= 75:
            break
        t = ds[i]["text"]
        if denied(t):
            drop(f"deepset-{i}", "denylist")
            continue
        out_ds.append({"id": f"b4d-screen-en-leg-{sum(1 for r in out_ds if 'leg' in r['id']) + 1:03d}",
                       "text": t, "all_labels": SCREEN_CANDS, "true_labels": ["benign"],
                       "source": "deepset/prompt-injections-train", "license": "Apache-2.0",
                       "lang": "en", "orig_id": f"deepset-{i}"})
    print(f"deepset rows: {len(out_ds)}")

    # ---------- 6. BIPIA mirror ----------
    bp = load_dataset("geodesic-research/bipia", split="train")
    # stratify task x position
    cells = {}
    for i in range(len(bp)):
        cells.setdefault((bp[i]["task_name"], bp[i]["position"]), []).append(i)
    for k in cells:
        rng.shuffle(cells[k])
    want = {"email": 20, "code": 15, "table": 15}
    order = ["email", "code", "table"]
    pos = ["start", "middle", "end"]
    out_bp, seen_ctx = [], set()
    for task in order:
        per_pos = want[task] // 3 + 1
        for p in pos:
            got = sum(1 for r in out_bp if r.get("_t") == (task, p) and "atk" in r.get("id", ""))
            for i in cells.get((task, p), []):
                ntask = sum(1 for r in out_bp if r.get("_t", (None,))[0] == task and "atk" in r.get("id", ""))
                if got >= per_pos or ntask >= want[task]:
                    break
                ctx, atk = bp[i]["context"] or "", bp[i]["attack_str"] or ""
                if not atk or atk not in ctx or len(ctx) < 50:
                    continue
                if denied(ctx):
                    drop(bp[i]["id"], "denylist")
                    continue
                # attacked text: window around the injection (keeps attack at any position)
                at = ctx.find(atk)
                lo, hi = max(0, at - 900), at + len(atk) + 900
                atext = (("…" if lo > 0 else "") + ctx[lo:hi] + ("…" if hi < len(ctx) else ""))
                # benign: same context with the injection stripped
                btext = (ctx[:at] + ctx[at + len(atk):]).strip()
                btext = re.sub(r"\n{3,}", "\n\n", btext)
                if len(btext) < 50 or denied(btext):
                    drop(bp[i]["id"], "benign-denylist/short")
                    continue
                n = sum(1 for r in out_bp if "atk" in r.get("id", "")) + 1
                pid = f"b4pair-bipia-{task}-{n:02d}"
                out_bp.append({"id": f"b4b-screen-en-atk-{n:03d}", "text": atext,
                               "all_labels": SCREEN_CANDS, "true_labels": ["malicious"],
                               "source": "geodesic-research/bipia:attacked",
                               "license": "CC-BY-SA-4.0", "lang": "en",
                               "orig_id": bp[i]["id"], "pair_id": pid, "_t": (task, p)})
                out_bp.append({"id": f"b4b-screen-en-ben-{n:03d}", "text": btext[:2400],
                               "all_labels": SCREEN_CANDS, "true_labels": ["benign"],
                               "source": "geodesic-research/bipia:benign-reconstructed",
                               "license": "CC-BY-SA-4.0", "lang": "en",
                               "orig_id": bp[i]["id"] + "#benign", "pair_id": pid, "_t": (task, p)})
                got += 1
    for r in out_bp:
        r.pop("_t", None)
    print(f"bipia rows: {len(out_bp)}")

    # ---------- write ----------
    files = {"gate-fever.jsonl": out_fever, "gate-nli-es.jsonl": out_es,
             "gate-nli-en.jsonl": out_en, "screen-deepset.jsonl": out_ds,
             "screen-bipia.jsonl": out_bp}
    total = 0
    for fn, rows in files.items():
        with open(os.path.join(BASE, fn), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        total += len(rows)
        print(f"wrote {fn}: {len(rows)}")
    stats["total_new"] = total
    stats["files"] = {fn: len(rows) for fn, rows in files.items()}
    stats["seed"] = SEED
    json.dump(stats, open(os.path.join(BASE, "build-stats.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("TOTAL new rows:", total, "| drops:", len(stats["drops"]))


if __name__ == "__main__":
    main()
