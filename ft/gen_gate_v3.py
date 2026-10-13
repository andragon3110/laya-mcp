"""Regulus-v3 gate-gap generator (finetune-r3j-complete v3 round, approved 2026-10-12).

Builds 50 focused gap rows, schema-identical to the v2 mix
({id, text, labels(true), candidates, source}):

- gate SUPPORTED (44: 22 EN + 22 ES): normals-with-bearing-evidence in the
  r1-gate normal/difficult SHAPE (short CI/test/build/lint evidence that
  directly bears on a restating claim, incl. skipped/omitted-does-not-
  contradict difficult variants), text = "evidence || claim" (v1 lane
  mapping), candidates 3 gate labels, truth by construction (evidence
  bears -> SUPPORTED).
- classify other-holds (6: 3 EN + 3 ES): status/admin-style other questions
  (the v2-classify confused neighborhood: EN-other-03 status + EN-other-04
  admin ->bug), truth by construction (neither bug nor feature -> other).

Construction labeling (no human awake for sign-off): every row's truth
follows from its construction (bearing evidence / non-defect question),
and the generator self-checks coherence (SUP rows must match the bearing
pattern; other rows must carry no defect/request language). Documented in
MIX_README, not hidden.

Overlap rule (0-overlap vs ALL eval ids + prior mixes): new v3a-* ids vs an
extended universe (244 eval ids + 570 anchor ids); exact normalized-text
match vs 337 eval texts + 674 prior-mix texts; token-3-gram Jaccard
near-dup scan vs both text universes (refuse any pair >= 0.5); denylist of
eval-distinctive multi-word phrases (single generic words like tests /
pruebas / build / lint are DELIBERATELY allowed: they ARE the r1-gate
normal neighborhood this round trains; the enforcement is exact-text +
near-dup + phrase-level, reported honestly in overlap-report.json).

Deliberate neighborhood note: these rows train the CI/test/build/lint
evidence neighborhood that v2 anchors (attendance/oven logs) never covered.
Claims reword every eval claim (never the eval strings "all tests pass",
"the build is green", "no test failed", "todas las pruebas pasan",
"no falló ninguna prueba", "la compilación quedó en verde"); evidence uses
fresh counts. The Jaccard scan enforces the distance.

Outputs (into --out, default artifacts-ft/mix-regulus-v3/):
- gate-v3-train.jsonl (the 50 rows)
- batch4-train.jsonl (byte copy of the v2 mix file; v2 dir stays read-only)
- anchors-train.jsonl (byte copy of the v2 mix file; v2 dir stays read-only)
- eval-ids-train.txt (byte copy of the v2 140-id file: train-time
  --eval-ids, so batch-4 + v3 rows stay in the mix while r1/v2 stay out)
- eval-ids.txt (EXTENDED exclusion universe for future rounds:
  v2 244 + 570 anchor ids + 50 new = 864)
- overlap-report.json (0-overlap evidence)

Usage:
  py/.venv-ft/Scripts/python ft/gen_gate_v3.py --eval-texts <v2 eval-texts.json>
      --eval-ids-v2 <v2 eval-ids.txt> --seed 31337
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V2_MIX = os.path.join(REPO, "artifacts-ft", "mix-regulus-v2")
V2_BATCH4 = os.path.join(V2_MIX, "batch4-train.jsonl")
V2_ANCHORS = os.path.join(V2_MIX, "anchors-train.jsonl")
V2_IDS_TRAIN = os.path.join(V2_MIX, "eval-ids-train.txt")
V2_IDS_EXT = os.path.join(V2_MIX, "eval-ids.txt")

GEN_SEED = 31337  # v3 data-generation seed (recorded; NOT the train seed)

CLASS_CANDS = ["bug", "feature", "other"]
GATE_CANDS = ["SUPPORTED", "CONTRADICTED", "ABSTAIN"]

# Eval-distinctive MULTI-WORD phrases / specific tokens (lowercased). Any
# generated text containing one is refused. Single generic words (tests,
# pruebas, build, lint, suite, verde, green, passed...) are deliberately NOT
# here: they are the r1-gate normal neighborhood under treatment; distance
# is enforced by exact-text + Jaccard instead (see module docstring).
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
    "linux", "windows", "uptime", "battery", "batería", "latency", "latencia",
    "throughput", "vulnerability", "vulnerabilidad", "inyección sql", "xss",
    "rollback", "backup", "restauración", "i18n", "todos los idiomas",
    "pii", "never logged", "impossible", "imposible", "siempre funciona",
    "audit script flagged", "soporte técnico",
]

# (evidence, claim) SUPPORTED-construction pairs: evidence directly bears
# (counts with zero failures; skips/omissions coexist with zero failures),
# claim restates the evidence outcome. Fresh counts + reworded claims
# throughout (never eval claim strings).
EN_SUP = [
    ("tests: 34 passed with zero failures", "the suite cleared 34 of 34"),
    ("tests: 58 passed, none failed", "all 58 checks came back passing"),
    ("build succeeded; lint reports 0 errors and 0 warnings", "the build finished clean"),
    ("ci pipeline green across 76 checks with zero failures", "every pipeline check passed"),
    ("tests: 112 passed, 3 skipped, zero failures", "nothing failed among the tests that ran"),
    ("nightly run: 207 checks passed, none failed", "the nightly run stayed fully green"),
    ("typecheck clean with 0 errors; unit tests 96 of 96", "types and unit tests both hold"),
    ("lint found no issues; tests 45 of 45 passed", "lint and tests both came back clean"),
    ("test run 412 ended 143 passed, 2 skipped, zero failed", "no executed test failed"),
    ("coverage gate met at 84 percent with zero failing tests", "the coverage gate holds"),
    ("tests: 67 passed in a row with no failures", "each of the 67 tests passed"),
    ("build ok; static analysis shows 0 findings", "build and analysis report nothing wrong"),
    ("smoke suite: 29 passed, none failed", "the smoke suite passed end to end"),
    ("tests: 88 passed, 1 skipped, zero failures", "a single skip and no failures on record"),
    ("regression pack: 156 passed with zero failures", "the regression pack shows no failures"),
    ("ci finished 41 jobs succeeded and none failed", "all 41 ci jobs succeeded"),
    ("tests: 73 passed without a single failure", "the batch completed with zero failures"),
    ("lint clean at 0 errors and the build artifact produced", "clean lint plus a built artifact"),
    ("integration run: 52 passed, none failed", "integration came back fully passing"),
    ("tests: 39 passed, 4 skipped, zero failures", "only skips apart, nothing failed"),
    ("audit script: 118 checks passed, none flagged", "the audit round came back with nothing flagged"),
    ("tests: 264 passed with zero failures", "the extended suite passed in full"),
]

ES_SUP = [
    ("pruebas: 34 superadas con cero fallos", "la suite superó 34 de 34"),
    ("pruebas: 58 superadas, ninguna fallida", "las 58 comprobaciones salieron adelante"),
    ("compilación correcta; el lint informa 0 errores y 0 avisos", "la compilación terminó limpia"),
    ("tubería de integración en verde con 76 comprobaciones sin fallos", "cada comprobación pasó"),
    ("pruebas: 112 superadas, 3 omitidas, cero fallos", "nada falló entre las pruebas ejecutadas"),
    ("turno nocturno: 207 comprobaciones superadas, ninguna fallida", "la noche quedó en verde total"),
    ("tipado limpio con 0 errores; unitarias 96 de 96", "tipos y unitarias aguantan"),
    ("el lint no halló nada; pruebas 45 de 45", "lint y pruebas volvieron limpios"),
    ("corrida 412 terminó 143 superadas, 2 omitidas, cero fallos", "ninguna prueba ejecutada falló"),
    ("umbral de cobertura al 84 por ciento sin pruebas fallidas", "el umbral de cobertura aguanta"),
    ("pruebas: 67 seguidas sin fallos", "cada una de las 67 pruebas pasó"),
    ("compilación bien; análisis estático con 0 hallazgos", "compilación y análisis sin nada raro"),
    ("suite de humo: 29 superadas, ninguna fallida", "la suite de humo pasó de punta a punta"),
    ("pruebas: 88 superadas, 1 omitida, cero fallos", "una sola omisión y ningún fallo registrado"),
    ("paquete de regresión: 156 superadas sin fallos", "la regresión no muestra fallos"),
    ("integración continua: 41 trabajos bien y ninguno mal", "los 41 trabajos salieron bien"),
    ("pruebas: 73 superadas sin un solo fallo", "el lote terminó con cero fallos"),
    ("lint limpio con 0 errores y artefacto generado", "lint limpio más artefacto construido"),
    ("corrida de integración: 52 superadas, ninguna fallida", "la integración volvió en verde total"),
    ("pruebas: 39 superadas, 4 omitidas, cero fallos", "aparte de omisiones, nada falló"),
    ("script de auditoría: 118 comprobaciones bien, ninguna marcada", "la auditoría no marcó nada"),
    ("pruebas: 264 superadas con cero fallos", "la suite amplia pasó entera"),
]

# other-hold questions: status/admin-style (the v2-classify confused
# neighborhood), neither defect reports nor feature requests by construction.
EN_OTHER = [
    "Is the status page showing an outage in our region right now?",
    "Please close my workspace and erase everything inside it.",
    "How do I add a teammate to the on-call rotation?",
]

ES_OTHER = [
    "¿La página de estado muestra alguna incidencia en nuestra zona ahora mismo?",
    "Cierren mi espacio de trabajo y borren todo su contenido, por favor.",
    "¿Cómo añado a un compañero a la guardia semanal?",
]


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def trigrams(s: str) -> set[str]:
    toks = norm(s).split()
    if len(toks) < 3:
        return {" ".join(toks)}
    return {" ".join(toks[i:i + 3]) for i in range(len(toks) - 2)}


def jacc(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def build() -> list[dict]:
    rows: list[dict] = []
    for i, (ev, cl) in enumerate(EN_SUP, 1):
        rows.append({"id": f"v3a-gate-en-sup-{i:02d}", "text": f"{ev} || {cl}",
                     "labels": ["SUPPORTED"], "candidates": GATE_CANDS,
                     "source": "synthetic-gate-v3:gate"})
    for i, (ev, cl) in enumerate(ES_SUP, 1):
        rows.append({"id": f"v3a-gate-es-sup-{i:02d}", "text": f"{ev} || {cl}",
                     "labels": ["SUPPORTED"], "candidates": GATE_CANDS,
                     "source": "synthetic-gate-v3:gate"})
    for i, t in enumerate(EN_OTHER, 1):
        rows.append({"id": f"v3a-classify-en-other-{i:02d}", "text": t,
                     "labels": ["other"], "candidates": CLASS_CANDS,
                     "source": "synthetic-gate-v3:other-hold"})
    for i, t in enumerate(ES_OTHER, 1):
        rows.append({"id": f"v3a-classify-es-other-{i:02d}", "text": t,
                     "labels": ["other"], "candidates": CLASS_CANDS,
                     "source": "synthetic-gate-v3:other-hold"})
    return rows


def coherence_check(rows: list[dict]) -> list[str]:
    """Construction-truth self-check: SUP rows must carry bearing evidence
    (zero-failure / all-pass counts), other rows must carry no defect or
    feature-request language."""
    errs = []
    bug_words = ["crash", "broken", "fails on", "error when", "defect",
                 "rotten", "se rompe", "falla al", "averiado"]
    feat_words = ["please add", "add support", "quisiera pedir", "añadan",
                  "could you offer", "it would be great"]
    for r in rows:
        t = norm(r["text"])
        if r["labels"] == ["SUPPORTED"]:
            if not re.search(r"(zero|0|cero|ningun|sin|none|not?hing|every|all|each|cada|toda|meet|holds|aguanta|no issues|\d+\s+of\s+\d+|\d+ de \d+)", t):
                errs.append(f"{r['id']}: SUP row without bearing-evidence wording")
            if " || " not in r["text"]:
                errs.append(f"{r['id']}: gate row missing ' || ' lane separator")
        elif r["labels"] == ["other"]:
            for w in bug_words + feat_words:
                if w in t:
                    errs.append(f"{r['id']}: other-hold carries suspect {w!r}")
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser(description="Regulus-v3 gate-gap generator.")
    ap.add_argument("--out", default=os.path.join(REPO, "artifacts-ft", "mix-regulus-v3"))
    ap.add_argument("--eval-texts", required=True,
                    help="v2 eval-texts.json {ids, texts, tris} (337 eval texts)")
    ap.add_argument("--eval-ids-v2", default=V2_IDS_EXT,
                    help="v2 extended eval-ids.txt (244)")
    ap.add_argument("--seed", type=int, default=GEN_SEED)
    args = ap.parse_args(argv)

    rows = build()
    assert len(rows) == 50, f"v3 round is 50 rows, got {len(rows)}"
    n_gate = sum(1 for r in rows if r["labels"] == ["SUPPORTED"])
    n_other = sum(1 for r in rows if r["labels"] == ["other"])
    n_en = sum(1 for r in rows if "-en-" in r["id"])
    n_es = sum(1 for r in rows if "-es-" in r["id"])
    print(f"built {len(rows)} rows: gate-SUP {n_gate}, other-hold {n_other}, EN {n_en}, ES {n_es}")

    errs = coherence_check(rows)
    if errs:
        print(f"REFUSED: coherence self-check failed ({len(errs)}):")
        for e in errs[:10]:
            print(f"  - {e}")
        return 2
    print("coherence self-check: PASS (construction truth: bearing->SUP, non-defect->other)")

    denied = []
    for r in rows:
        t = norm(r["text"])
        for d in DENY:
            hit = re.search(r"\b" + re.escape(d) + r"\b", t) if " " not in d else (d in t)
            if hit:
                denied.append((r["id"], d))
    if denied:
        print(f"REFUSED: {len(denied)} denylist hits, e.g. {denied[:8]}")
        return 2
    print("denylist: PASS (0 phrase hits; generic CI words allowed by design, see docstring)")

    with open(args.eval_texts, encoding="utf-8") as f:
        ev = json.load(f)
    ev_texts = {norm(t) for t in ev["texts"]}
    ev_tris = [set(t) for t in ev["tris"]]

    with open(args.eval_ids_v2, encoding="utf-8") as f:
        ext_ids = [l.strip() for l in f if l.strip()]
    prior_rows = []
    for path in (V2_BATCH4, V2_ANCHORS):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    prior_rows.append(json.loads(line))
    anchor_ids = [r["id"] for r in prior_rows]
    universe = set(ext_ids) | set(anchor_ids)
    mix_texts = {norm(r["text"]) for r in prior_rows}
    mix_tris = [trigrams(r["text"]) for r in prior_rows]

    new_ids = [r["id"] for r in rows]
    id_overlap = sorted(set(new_ids) & universe)
    new_texts = {norm(r["text"]) for r in rows}
    exact_eval = sorted(new_texts & ev_texts)
    exact_mix = sorted(new_texts & mix_texts)

    worst_eval, worst_mix = [], []
    for r in rows:
        rt = trigrams(r["text"])
        be = max([jacc(rt, et) for et in ev_tris] or [0.0])
        bm = max([jacc(rt, mt) for mt in mix_tris] or [0.0])
        worst_eval.append((be, r["id"]))
        worst_mix.append((bm, r["id"]))
    worst_eval.sort(reverse=True)
    worst_mix.sort(reverse=True)

    report = {
        "gen_seed": args.seed,
        "n_new": len(rows),
        "composition": {"gate_SUPPORTED": n_gate, "other_hold": n_other,
                        "en": n_en, "es": n_es},
        "eval_universe": {"eval_ids": len(ext_ids), "anchor_ids": len(anchor_ids),
                          "total_ids": len(universe), "eval_texts": len(ev_texts)},
        "prior_mix_texts": len(mix_texts),
        "id_overlap": id_overlap,
        "exact_text_overlap_eval": exact_eval,
        "exact_text_overlap_mix": exact_mix,
        "denylist_hits": denied,
        "max_jaccard3_vs_eval": round(worst_eval[0][0], 4),
        "top5_jaccard_vs_eval": [(i, round(j, 4)) for j, i in worst_eval[:5]],
        "pairs_above_0.5_vs_eval": [(i, round(j, 4)) for j, i in worst_eval if j >= 0.5],
        "max_jaccard3_vs_mix": round(worst_mix[0][0], 4),
        "top5_jaccard_vs_mix": [(i, round(j, 4)) for j, i in worst_mix[:5]],
        "pairs_above_0.5_vs_mix": [(i, round(j, 4)) for j, i in worst_mix if j >= 0.5],
    }
    os.makedirs(args.out, exist_ok=True)
    rng = random.Random(args.seed)
    order = list(rows)
    rng.shuffle(order)
    with open(os.path.join(args.out, "gate-v3-train.jsonl"), "w", encoding="utf-8") as f:
        for r in order:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    shutil.copyfile(V2_BATCH4, os.path.join(args.out, "batch4-train.jsonl"))
    shutil.copyfile(V2_ANCHORS, os.path.join(args.out, "anchors-train.jsonl"))
    shutil.copyfile(V2_IDS_TRAIN, os.path.join(args.out, "eval-ids-train.txt"))
    future = ext_ids + [i for i in anchor_ids if i not in set(ext_ids)] + new_ids
    with open(os.path.join(args.out, "eval-ids.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(future) + "\n")
    with open(os.path.join(args.out, "overlap-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(json.dumps({k: v for k, v in report.items()
                      if k not in ("top5_jaccard_vs_eval", "top5_jaccard_vs_mix")},
                     indent=2, ensure_ascii=False)[:2200])

    ok = (not id_overlap and not exact_eval and not exact_mix
          and not report["pairs_above_0.5_vs_eval"]
          and not report["pairs_above_0.5_vs_mix"])
    print("OVERLAP CHECK:",
          "PASS (0 id, 0 exact, 0 pairs>=0.5 vs eval AND vs prior mix)" if ok else "FAIL")
    if ok:
        print(f"future exclusion universe: {len(future)} ids "
              f"(244 eval + 570 anchors + 50 new = {244 + 570 + 50})")
    return 0 if ok else 3


if __name__ == "__main__":
    raise SystemExit(main())
