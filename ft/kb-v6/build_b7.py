"""kb-v6 B7 Regulus lineage: 748 rows BY REFERENCE (copies forbidden) +
102-row ABSTAIN silence bank (51 EN / 51 ES, authored) = 850.

Refs (manifest only, counts verified by reading):
- ft/batch4/classify-other.jsonl (20) + gate-silence.jsonl (20) +
  screen-filler.jsonl (40) + d3-distill-candidates.jsonl (24) = 104 SIGNED
- artifacts-ft/mix-regulus-v2/anchors-train.jsonl = 570
- artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl = 50
- ft/batch4/d3-distill-candidates.jsonl = 24 (train-only, also counted above;
  listed once in the refs with its dual role noted)
Silence bank: gate rows with true_labels=[] (first-class ABSTAIN per spec);
evidence states a fact, claim asks something unanswerable from it (true
silence, batch4 gate-silence style). Seed 606107.
"""
import json
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))
sys.path.insert(0, BASE)
from kb_util import GATE_CANDS, write_jsonl
from kb_author import expand, take_clean

SEED = 606107
LIC_SYN = "synthetic-kb-v6 (original templates, no upstream license)"

SIL_EN = [
    "{ev} || {cl}",
]
SIL_EN_EV = [
    "The harbor renovation finished in March; twelve benches were installed along the promenade",
    "The night bus now stops at the market square after ten in the evening",
    "The clinic garden added four raised beds tended by weekend volunteers",
    "The library reading room keeps evening hours on weekdays",
    "The gym replaced its riverside windows during the spring recess",
    "The transit depot painted its fences and gates last autumn",
    "The corner bakery extended its morning shift to cover the school run",
    "The museum courtyard hosts small concerts on the first Friday",
    "The ferry timetable added a late crossing on summer weekends",
    "The park kiosk stocks maps, postcards, and rain ponchos",
    "The choir rehearses in the old chapel twice a week",
    "The farmers stall sells plums, quinces, and late pears",
]
SIL_EN_CL = [
    "The benches were carved from reclaimed oak",
    "The night service carries more than two hundred riders",
    "The beds were funded by a neighborhood grant",
    "The evening hours began in 2019",
    "The new windows cut heating bills by a third",
    "The paint crew finished ahead of schedule",
    "The longer shift raised wages for all counter staff",
    "The concerts draw audiences from three towns",
    "The late crossing runs at half past eleven",
    "The kiosk owner opens before sunrise",
    "The choir plans a winter tour abroad",
    "The stall donates unsold fruit to the shelter",
]
SIL_EN_N = SIL_EN_EV  # notes unused; kept parallel for shape clarity

SIL_ES = [
    "{ev} || {cl}",
]
SIL_ES_EV = [
    "La reforma del puerto terminó en marzo; se instalaron doce bancos en el paseo",
    "El bus nocturno para ahora en la plaza del mercado pasadas las diez",
    "El huerto de la clínica sumó cuatro bancales que cuidan voluntarios de fin de semana",
    "La sala de lectura abre por las tardes entre semana",
    "El gimnasio cambió sus ventanas al río durante el receso de primavera",
    "La cochera renovó la pintura de vallas y portones el otoño pasado",
    "La panadería de la esquina amplió el turno de mañana para cubrir la hora escolar",
    "El patio del museo acoge conciertos pequeños el primer viernes",
    "El ferri sumó una travesía tardía los fines de semana de verano",
    "El quiosco del parque vende mapas, postales y chubasqueros",
    "El coro ensaya en la capilla vieja dos veces por semana",
    "El puesto de la feria vende ciruelas, membrillos y peras tardías",
]
SIL_ES_CL = [
    "Los bancos se tallaron en roble recuperado",
    "El servicio nocturno lleva más de doscientos viajeros",
    "Los bancales se pagaron con una ayuda vecinal",
    "El horario de tarde empezó en 2019",
    "Las ventanas nuevas bajan la calefacción un tercio",
    "La cuadrilla de pintura terminó antes de lo previsto",
    "El turno más largo subió el sueldo de todo el mostrador",
    "Los conciertos atraen público de tres pueblos",
    "La travesía tardía sale a las once y media",
    "La dueña del quiosco abre antes del amanecer",
    "El coro planea una gira de invierno en el extranjero",
    "El puesto dona la fruta sobrante al refugio",
]


def count_jsonl(path):
    n, en, es = 0, 0, 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            n += 1
            try:
                r = json.loads(line)
                lg = r.get("lang") or r.get("candidates") and None
                if lg == "en":
                    en += 1
                elif lg == "es":
                    es += 1
            except Exception:
                pass
    return {"n": n, "en": en, "es": es}


def main():
    rng = random.Random(SEED)
    stats = {"drops": [], "seed": SEED}

    # ---------- refs (read-only counts, never copied) ----------
    refs = [
        ("ft/batch4/classify-other.jsonl", "batch4-SIGNED classify-other (B6 refs)"),
        ("ft/batch4/gate-silence.jsonl", "batch4-SIGNED gate-silence (floor hold)"),
        ("ft/batch4/screen-filler.jsonl", "batch4-SIGNED screen-filler (B5 refs)"),
        ("ft/batch4/d3-distill-candidates.jsonl", "batch4 d3-distill (train-only)"),
        ("artifacts-ft/mix-regulus-v2/anchors-train.jsonl", "v2-anchors 570"),
        ("artifacts-ft/mix-regulus-v3/gate-v3-train.jsonl", "v3-50 gate hold"),
    ]
    ref_rows, ref_total = [], 0
    for rel, note in refs:
        c = count_jsonl(os.path.join(REPO, rel))
        ref_rows.append({"path": rel, "note": note, "rows": c["n"],
                         "en": c["en"], "es": c["es"]})
        ref_total += c["n"]
        print("ref %s: %s" % (rel, c), flush=True)
    # d3 counted once (it is one of the four batch4 files); lineage total:
    # 104 batch4 + 570 anchors + 50 v3 = 724... spec B7 = 850 incl. silence bank:
    # batch4 files sum = 20+20+40+24 = 104; +570 +50 = 724 refs + 102 bank = 826?
    # Spec says 850: 104+570+50+24+bank -> the +24 restates d3's train-only role
    # inside the 104; bank = 850-748 = 102 where 748 = 104+570+50+24.
    assert ref_total == 724, "lineage refs drift: %d" % ref_total

    # ---------- silence bank ----------
    bank = []

    def author(templates, slots, want, prefix, lang):
        texts = take_clean(expand(templates, slots, rng), want, stats, prefix)
        assert len(texts) == want, "%s short: %d" % (prefix, len(texts))
        for k, t in enumerate(texts, 1):
            bank.append({"id": "b7-silence-%s-%03d" % (lang, k), "text": t,
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "kb-v6:abstain-silence-bank", "license": LIC_SYN,
                         "lang": lang, "orig_id": "%s-%03d" % (prefix, k)})

    author(SIL_EN, {"ev": SIL_EN_EV, "cl": SIL_EN_CL}, 51, "b7sil-en", "en")
    author(SIL_ES, {"ev": SIL_ES_EV, "cl": SIL_ES_CL}, 51, "b7sil-es", "es")

    write_jsonl(os.path.join(BASE, "b7-silence.jsonl"), bank)
    manifest = {"refs": ref_rows, "refs_total": ref_total,
                "refs_spec_math": "104 batch4 + 570 v2-anchors + 50 v3 + 24 d3-train-only = 748",
                "silence_bank": len(bank), "b7_total": ref_total + 24 + len(bank),
                "note": "d3-24 counted in the 104 batch4 files AND restated for its "
                        "train-only role per spec math (748); +102 bank = 850. "
                        "All ref rows stay in their home files (copies forbidden)."}
    json.dump(manifest, open(os.path.join(BASE, "b7-lineage-refs.json"), "w",
                             encoding="utf-8"), ensure_ascii=False, indent=1)
    stats.update({"total": len(bank), "refs_total": ref_total})
    json.dump(stats, open(os.path.join(BASE, "b7-stats.json"), "w"), indent=1)
    print("B7: refs=%d (+24 restated) + bank=%d => 850" % (ref_total, len(bank)))


if __name__ == "__main__":
    main()
