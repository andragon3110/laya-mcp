"""kb-v6 B6 classify/other: XNLI-neutral pairs EN 150/ES 150 (true [other],
real negatives per spec) + repo-domain bug/feature/other EN 140/ES 140
(bug 50 / feature 50 / other 40 per lang) = 580 new (+ 20 batch4 other-neg
refs = 600; EN 290+10ref=300, ES 290+10ref=300).

Repo-domain rows are authored from real repo components (file/lane names)
with synthetic symptoms; source labeled kb-v6:repo-domain-*, never eval
text. Deterministic template+slot (seed 606106), build-time filtered.
all_labels = [bug, feature, other] throughout.
"""
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from kb_util import CLASSIFY_CANDS, denied, write_jsonl
from kb_author import expand, take_clean

SEED = 606106
LIC_X = "unlisted-on-mirror (upstream XNLI Conneau et al. 2018; verify before commercial use)"
LIC_SYN = "synthetic-kb-v6 (original templates, no upstream license)"

BUG_EN = [
    "Report: {comp} {symptom} during {sit}. {detail}",
    "Defect note: {comp} {symptom} when {sit}. {detail}",
    "Seen in testing: {comp} {symptom} across {sit}. {detail}",
    "Failure log: {comp} {symptom} after {sit}. {detail}",
    "Bug filed by night-watch: {comp} {symptom} near {sit}. {detail}",
    "Regression watch: {comp} {symptom} under {sit}. {detail}",
]
BUG_EN_COMP = [
    "evals/run.mjs", "py/gliclass_server.py", "ft/batch4/check.py",
    "evals/reliability.mjs", "the lane router", "the :8770 sidecar",
    "the corpus index", "the manifest writer", "the checkpoint loader",
    "the suite runner",
]
BUG_EN_SYM = [
    "exits 2 on empty input", "prints duplicate ids", "skips the last suite",
    "holds the port after stop", "writes unsorted ids", "counts abstentions twice",
    "renders an empty diagram", "drops the final newline", "rereads the cache on every case",
    "emits mixed line endings", "reports zero rows but writes a file", "halts on a stray comma",
]
BUG_EN_SIT = [
    "the nightly run", "reruns of the sample corpus", "the pre-launch pass",
    "back-to-back invocations", "a cold start", "the full eleven-suite sweep",
]
BUG_EN_DET = [
    "Noticed twice this week; reproducible with the sample corpus.",
    "First spotted in the pre-launch pass; needs a minimal repro.",
    "Only manifests on reruns; the first pass stays green.",
    "Filed with timestamps; the log excerpt is attached to the ticket.",
]

FEA_EN = [
    "Request: {comp} should {cap} for {ben}. {detail}",
    "Proposal: teach {comp} to {cap} to gain {ben}. {detail}",
    "Feature ask: extend {comp} so it can {cap}; expect {ben}. {detail}",
    "Enhancement: {comp} needs the ability to {cap}, giving {ben}. {detail}",
    "Idea from triage: let {comp} {cap} and deliver {ben}. {detail}",
    "Roadmap note: {comp} ought to {cap} toward {ben}. {detail}",
]
FEA_EN_CAP = [
    "emit machine-readable summaries", "list lane coverage per suite",
    "pin model revisions in manifests", "retry stalled sidecars",
    "sort ids before writing", "refuse empty inputs with exit 2",
    "diagram bin counts", "record wall-clock per lane",
    "diff golds against oracles verbosely", "archive prior reports by date",
]
FEA_EN_BEN = [
    "faster triage", "cleaner diffs", "safer reruns", "clearer reports",
    "calmer on-call rotations", "shorter debug loops",
]
FEA_EN_DET = [
    "Requested after the last review round stalled on missing context.",
    "Would unblock the docs refresh without touching handler code.",
    "Pairs well with the existing reliability diagrams.",
    " Keeps the harness output stable for downstream parsers.".replace("  ", " ").strip(),
]

OTH_EN = [
    "Garden rota for March: {item}. {note}",
    "Pantry inventory reminder: {item}. {note}",
    "Alumni picnic planning: {item}. {note}",
    "Bus timetable change notice: {item}. {note}",
    "Book club pick for spring: {item}. {note}",
]
OTH_EN_ITEM = [
    "rosemary and thyme beds need mulching", "the mower booking moves to Fridays",
    "oat stock is low; rye arrives Thursday", "the cooler door sticks again",
    "twenty folding chairs reserved", "the riverside route now leaves at eight",
    "two essays on harbor towns", "a novel about lighthouse keepers",
]
OTH_EN_NOTE = [
    "Pinned by the treasurer; no action for the crew.",
    "Copied to the noticeboard for the weekend shift.",
    "Confirmed at the monthly gathering.",
]

BUG_ES = [
    "Reporte: {comp} {symptom} durante {sit}. {detail}",
    "Nota de defecto: {comp} {symptom} cuando {sit}. {detail}",
    "Visto en pruebas: {comp} {symptom} en {sit}. {detail}",
    "Registro de fallo: {comp} {symptom} tras {sit}. {detail}",
    "Reporte de la guardia nocturna: {comp} {symptom} cerca de {sit}. {detail}",
    "Vigilancia de regresiones: {comp} {symptom} bajo {sit}. {detail}",
]
BUG_ES_COMP = [
    "evals/run.mjs", "py/gliclass_server.py", "ft/batch4/check.py",
    "evals/reliability.mjs", "el enrutador de carriles", "el sidecar del puerto 8770",
    "el índice del corpus", "el escritor de manifiestos", "el cargador de checkpoints",
    "el corredor de suites",
]
BUG_ES_SYM = [
    "sale con código 2 ante entradas vacías", "imprime identificadores duplicados",
    "omite la última suite", "retiene el puerto tras detenerse", "escribe identificadores sin ordenar",
    "cuenta dos veces las abstenciones", "dibuja un diagrama vacío", "pierde el salto de línea final",
    "relee la caché en cada caso", "emite finales de línea mixtos",
    "reporta cero filas pero escribe un archivo", "se detiene ante una coma suelta",
]
BUG_ES_SIT = [
    "la corrida nocturna", "las repeticiones del corpus de muestra", "la pasada previa al lanzamiento",
    "invocaciones consecutivas", "un arranque en frío", "el barrido completo de once suites",
]
BUG_ES_DET = [
    "Visto dos veces esta semana; reproducible con el corpus de muestra.",
    "Detectado en la pasada previa al lanzamiento; falta un repro mínimo.",
    "Solo aparece en repeticiones; la primera pasada sale bien.",
    "Archivado con marcas de tiempo; el extracto va adjunto al ticket.",
]

FEA_ES = [
    "Petición: {comp} debería {cap} para {ben}. {detail}",
    "Propuesta: enseñar a {comp} a {cap} y lograr {ben}. {detail}",
    "Solicitud: extender {comp} para que pueda {cap}; se espera {ben}. {detail}",
    "Mejora: {comp} necesita poder {cap}, aportando {ben}. {detail}",
    "Idea del triaje: permitir que {comp} {cap} y entregue {ben}. {detail}",
    "Nota de ruta: {comp} convendría que {cap} hacia {ben}. {detail}",
]
FEA_ES_CAP = [
    "emitir resúmenes legibles por máquina", "listar la cobertura de carriles por suite",
    "fijar revisiones de modelos en manifiestos", "reintentar sidecars detenidos",
    "ordenar identificadores antes de escribir", "rechazar entradas vacías con código 2",
    "diagramar conteos por cubeta", "registrar tiempo de muro por carril",
    "comparar oráculos contra dorados con detalle", "archivar reportes previos por fecha",
]
FEA_ES_BEN = [
    "un triaje más veloz", "diferencias más limpias", "repeticiones más seguras",
    "reportes más claros", "guardias más tranquilas", "ciclos de depuración más cortos",
]
FEA_ES_DET = [
    "Pedido tras atascarse la última revisión por falta de contexto.",
    "Desbloquearía la renovación de docs sin tocar código de handlers.",
    "Combina bien con los diagramas de fiabilidad existentes.",
    "Mantiene estable la salida del harness para los analizadores.",
]

OTH_ES = [
    "Turnos del huerto para marzo: {item}. {note}",
    "Recordatorio de despensa: {item}. {note}",
    "Plan del picnic de exalumnos: {item}. {note}",
    "Aviso de cambio de horarios del bus: {item}. {note}",
    "Lectura del club para primavera: {item}. {note}",
]
OTH_ES_ITEM = [
    "los bancales de romero y tomillo necesitan acolchado", "la reserva de la segadora pasa a los viernes",
    "queda poca avena; el centeno llega el jueves", "la puerta del refrigerador se atasca de nuevo",
    "veinte sillas plegables reservadas", "la ruta ribereña sale ahora a las ocho",
    "dos ensayos sobre pueblos del puerto", "una novela sobre fareros",
]
OTH_ES_NOTE = [
    "Fijado por la tesorera; sin acción para la cuadrilla.",
    "Copiado al tablón para el turno del fin de semana.",
    "Confirmado en la reunión mensual.",
]


def main():
    import warnings
    warnings.filterwarnings("ignore")
    from datasets import load_dataset
    rng = random.Random(SEED)
    stats = {"drops": [], "seed": SEED}
    rows = []

    def add(text, true, source, lic, lang, oid):
        rows.append({"text": text, "all_labels": CLASSIFY_CANDS,
                     "true_labels": true, "source": source, "license": lic,
                     "lang": lang, "orig_id": oid})

    # ---------- XNLI neutral -> other ----------
    for cfg, lang in (("en", "en"), ("es", "es")):
        ds = load_dataset("facebook/xnli", cfg, split="train")
        idx = [i for i, l in enumerate(ds["label"]) if int(l) == 1]
        rng.shuffle(idx)
        got = 0
        for i in idx:
            if got >= 150:
                break
            text = "%s || %s" % (ds[i]["premise"], ds[i]["hypothesis"])
            d = denied(text)
            if d:
                stats["drops"].append({"id": "xnli-%s-%d" % (cfg, i),
                                      "reason": "denylist:" + d})
                continue
            got += 1
            add(text, ["other"], "facebook/xnli:%s-train:neutral-as-other"
                % cfg, LIC_X, lang, "xnli-%s-%d" % (cfg, i))
        print("neutral %s: %d" % (cfg, got), flush=True)
        assert got == 150, "B6-neutral-%s short" % cfg

    # ---------- repo-domain ----------
    def author(templates, slots, want, prefix, true, lang, src):
        texts = take_clean(expand(templates, slots, rng), want, stats, prefix)
        assert len(texts) == want, "%s short: %d" % (prefix, len(texts))
        for k, t in enumerate(texts, 1):
            add(t, true, src, LIC_SYN, lang, "%s-%03d" % (prefix, k))

    B = {"comp": BUG_EN_COMP, "symptom": BUG_EN_SYM, "sit": BUG_EN_SIT, "detail": BUG_EN_DET}
    F = {"comp": BUG_EN_COMP, "cap": FEA_EN_CAP, "ben": FEA_EN_BEN, "detail": FEA_EN_DET}
    O = {"item": OTH_EN_ITEM, "note": OTH_EN_NOTE}
    author(BUG_EN, B, 50, "b6repo-bug-en", ["bug"], "en", "kb-v6:repo-domain-bug")
    author(FEA_EN, F, 50, "b6repo-fea-en", ["feature"], "en", "kb-v6:repo-domain-feature")
    author(OTH_EN, O, 40, "b6repo-oth-en", ["other"], "en", "kb-v6:repo-domain-other")
    BE = {"comp": BUG_ES_COMP, "symptom": BUG_ES_SYM, "sit": BUG_ES_SIT, "detail": BUG_ES_DET}
    FE = {"comp": BUG_ES_COMP, "cap": FEA_ES_CAP, "ben": FEA_ES_BEN, "detail": FEA_ES_DET}
    OE = {"item": OTH_ES_ITEM, "note": OTH_ES_NOTE}
    author(BUG_ES, BE, 50, "b6repo-bug-es", ["bug"], "es", "kb-v6:repo-domain-bug")
    author(FEA_ES, FE, 50, "b6repo-fea-es", ["feature"], "es", "kb-v6:repo-domain-feature")
    author(OTH_ES, OE, 40, "b6repo-oth-es", ["other"], "es", "kb-v6:repo-domain-other")

    counters = {}
    for r in rows:
        key = (r["lang"], r["true_labels"][0])
        counters[key] = counters.get(key, 0) + 1
        r["id"] = "b6-classify-%s-%s-%03d" % (key[0], key[1][:3], counters[key])
    import json
    write_jsonl(os.path.join(BASE, "b6-classify.jsonl"), rows)
    by = {}
    for r in rows:
        by[(r["lang"], r["true_labels"][0])] = by.get((r["lang"], r["true_labels"][0]), 0) + 1
    stats.update({"total": len(rows), "by": {str(k): v for k, v in by.items()}})
    json.dump(stats, open(os.path.join(BASE, "b6-stats.json"), "w"), indent=1)
    print("B6 TOTAL:", len(rows), by)


if __name__ == "__main__":
    main()
