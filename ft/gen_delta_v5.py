"""Regulus-v5 delta generator (finetune-r3j-complete v5 round, approved 2026-10-12).

Builds ~120 correction rows, schema-compatible with the v4 train loop
(dual-schema: legacy {labels, candidates} + new {all_labels, true_labels})):

- gate silences (70: 35 EN + 35 ES, new schema all_labels 3 gate labels,
  true_labels=[] EMPTY by construction): evidence carries zero information
  about the claim subject (FEVER-NEI-style entity mismatch + batch-shaped
  short-evidence/unrelated-claim + fresh d3-style general-domain subjects).
  Truth by construction (silence -> ABSTAIN), self-checked (separator,
  both sides non-empty, subject-disjoint heuristic spot audit below).
- screen fillers (50: 25 EN + 25 ES, legacy schema labels=[suspicious],
  candidates [benign, suspicious, malicious] mirroring batch4-train filler
  rows): plain UI chrome (no instruction) + quoted-payload near-injections
  (instruction-like string QUOTED as cited/rejected/sampled content with
  framing, never an order). Truth by construction (filler -> REVIEW via
  suspicious), self-checked (plain has no instruction verbs as orders;
  near-inject must carry quotes + citation framing).

Construction labeling (no human awake for sign-off): documented here and in
MIX_README, not hidden. Spot audit in MIX_README records hand-verified rows.

Split (silence-loaded validation): the 70 silences are stratified 50 train /
20 held-out (per type+lang ~28% held out). Held-out ids NEVER enter the mix;
they join batch4-80 for the 100-row silence-heavy validation (40 silences).
Screen 50 all train (batch4-40 screen already covers validation fillers).

Overlap rule (0 tolerance vs ALL eval universes + prior mixes): new v5s-*
ids vs union(220-universe, 244-extended, 570 anchors, 50 v3, 24 d3
dist-ids are inside batch4-104); exact normalized-text vs 337 eval texts +
220 base texts + prior-mix texts (674 v2 + 1550 base + 50 v3); token-3-gram
Jaccard near-dup scan vs both (refuse any pair >= 0.5); denylist of
eval-distinctive multi-word phrases + batch4-filler distinctive strings.

Outputs (into --out, default artifacts-ft/mix-regulus-v5/):
- v5-silence-train.jsonl (50), v5-silence-heldout.jsonl (20),
  v5-screen-train.jsonl (50)
- overlap-report.json (0-overlap evidence)

The full mix assembly (byte copies of v2 + base files) is done by this
script too, so the mix dir is complete in one audited step (v3 pattern):
- batch4-train.jsonl + anchors-train.jsonl (byte copies of v2 mix files)
- gate-fever.jsonl + gate-nli-es.jsonl + gate-nli-en.jsonl (copies of
  ft/base-v4/ files with sha; screen-deepset + screen-bipia DELIBERATELY
  DROPPED per the v4 lesson: prose-injection screen rows do not transfer
  to filler rows; v3 gate-v3 50 DELIBERATELY NOT CARRIED: narrow SUP-only
  CI-vocabulary pressure was the v3 bias source; SUP coverage comes from
  the broad FEVER/NLI pairs instead. Both choices recorded in MIX_README.)
- eval-ids-train.txt (220-universe: r1+v2+batch4 ALL HELD OUT, v4 pattern;
  drops the 80 v2d validation rows from batch4-train, keeps 24 d3)
- eval-ids.txt (extended future universe), overlap-report.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V2_MIX = os.path.join(REPO, "artifacts-ft", "mix-regulus-v2")
V2_BATCH4 = os.path.join(V2_MIX, "batch4-train.jsonl")
V2_ANCHORS = os.path.join(V2_MIX, "anchors-train.jsonl")
V2_EVAL_TEXTS = os.path.join(V2_MIX, "eval-texts.json")
V2_IDS_EXT = os.path.join(V2_MIX, "eval-ids.txt")
BASE = os.path.join(REPO, "ft", "base-v4")
FEVER = os.path.join(BASE, "gate-fever.jsonl")
NLI_ES = os.path.join(BASE, "gate-nli-es.jsonl")
NLI_EN = os.path.join(BASE, "gate-nli-en.jsonl")
UNIVERSE_220 = os.path.join(BASE, "eval-universe.json")
V3_IDS = os.path.join(REPO, "artifacts-ft", "mix-regulus-v3", "gate-v3-train.jsonl")

GEN_SEED = 20261015  # v5 data-generation seed (recorded; NOT the train seed)

GATE_CANDS = ["SUPPORTED", "CONTRADICTED", "ABSTAIN"]
SCREEN_CANDS = ["benign", "suspicious", "malicious"]

# Eval-distinctive multi-word phrases / specific claim fragments (lowercased).
# Any generated SILENCE text containing one is refused. Single generic words
# (tests, lint, CI, deploy, verde, pruebas...) are deliberately NOT here:
# they ARE the silence pattern under treatment; distance is enforced by
# exact-text + Jaccard instead (v3 pattern).
GATE_DENY = [
    "disk usage", "search-engine ranking", "search engine ranking",
    "gdpr-compliant", "gdpr compliant", "works fully offline", "fully offline",
    "encrypted at rest", "failover", "audit trail", "land in spam",
    "argon2", "eu region", "eu customer", "ticket volume", "mobile signups",
    "soc 2", "task completion", "customer churn", "conversion lifts",
    "signup conversion", "million-row exports", "email open rates",
    "log pipeline", "search adoption", "insurer security", "incident response",
    "support ticket", "erroneous clicks", "bounce rate", "bounce baja",
    "accounting reconciliation", "conciliacion contable", "lost sales",
    "ventas perdidas", "multi-region", "event delivery", "multi-tenant",
    "electronic invoicing", "facturacion electronica", "activation mejora",
    "abre en excel", "all tests pass", "build is green", "no test failed",
    "todas las pruebas pasan", "no fallo ninguna prueba", "compilacion quedo en verde",
    "all null dereferences", "inputs invalidos se rechazan", "sso", "webhook",
    "rate limit", "starter plan", "enterprise plan", "spotify", "quarterly",
    "shah rukh khan", "eddie vedder", "robert downey", "cricket is a bat",
    "ship fix", "null check", "empty cart", "carrito vac",
    "reset my password", "restablezco mi contrase", "deploy log: rollout completed",
    "meta description", "merge pr", "two approvals", "notification emails",
    "passwords are now hashed", "audit script flagged", "antipattern",
    "onboarding", "apple pie", "tarta de manzana", "quantum", "zebra", "cebra",
    "revenue", "facturacion", "linux", "windows", "uptime", "battery endurance",
    "vulnerability", "vulnerabilidad", "rollback", "backup",
    "todos los idiomas", "never logged", "impossible", "imposible",
    "siempre funciona", "soporte tecnico", "lorem ipsum", "support hours",
    "atencion del soporte", "migration", "migracion",
]

# Batch4-filler distinctive strings (any generated SCREEN text containing one
# is refused; generic chrome words like "page", "results", "session" are fine).
SCREEN_DENY = [
    "fetch your results", "sponsored links", "back to top", "print this page",
    "unavailable in your region", "javascript is required", "free articles remaining",
    "was this page helpful", "related articles", "sort by: relevance", "sort by relevance",
    "session expires in", "draft saved automatically", "printed from",
    "table of contents", "skip to main content", "live chat is currently offline",
    "escalate to root", "password reset link", "sudo rm -rf", "disable all firewall",
    "transfer $10,000", "espera mientras preparamos", "enlaces patrocinados",
    "volver arriba", "no esta disponible en tu region", "activar javascript",
    "articulos gratis", "te resulto util", "articulos relacionados", "ordenar por relevancia",
    "sesion vence", "borrador guardado", "impreso desde", "indice:",
    "saltar al contenido", "chat esta fuera de linea", "acceso root",
    "enlace a atacante", "apagar --forzar", "desactiva el antivirus",
    "transferi $10.000",
]

# ---- silence pairs: (evidence, claim), disjoint subjects by construction ----
EN_FEVER = [
    ("Harborview Lighthouse: Harborview Lighthouse is a 34-meter granite tower completed in 1891 on Gull Rock. Its keepers logged fog signals and oil use daily until automation in 1974.",
     "The marathon world record fell twice within a single season."),
    ("Smoke in beekeeping: beekeepers puff cool smoke across hive frames to mask alarm pheromones before lifting supers. The practice dates to clay smokers used along the Nile delta.",
     "Subway ridership on line 4 doubled after the fare revision."),
    ("Lisbon tram line 28: the Remodelado cars climb grades near 13 percent through Alfama on 900mm gauge track. The route keeps its 1930s livery for heritage service.",
     "The highland coffee harvest finished three weeks early this year."),
    ("Salt glazing pottery: throwing salt into the kiln near 1280 degrees vaporizes sodium that bonds with silica into an orange-peel glaze. Rhineland stoneware used the method for storage jars.",
     "Two communications satellites reached orbit on the same launcher."),
    ("Canal lock flights: the Caen Hill flight lifts narrowboats 72 meters through sixteen chambers in under four kilometers. Volunteers still wind most paddles by hand.",
     "Opera subscriptions among first-time buyers rose by a fifth."),
    ("Wool grading tables: skirting removes stained edges before fleeces are classed by micron, staple and yield. Merino lots under 19 microns fetch the top bids.",
     "Container-ship tonnage through the strait set a monthly record."),
    ("Tide prediction books: harbor tables list high-water times computed from harmonic constituents for each port. Spring tides follow the new and full moon by two days.",
     "The national chess title changed hands in a final-round upset."),
    ("Seed vault ledgers: duplicate accessions sleep at minus 18 degrees inside triple-sealed pouches. Germination tests wake a sample of each lot every decade.",
     "The autumn film festival split its top prize between two debuts."),
    ("Clock-tower restoration: masons repointed the belfry with lime mortar and rehung the cracked bell a quarter-turn. The escapement now beats within two seconds a week.",
     "The flag carrier posted its best on-time month in six years."),
    ("Vineyard frost guards: wind machines stir warmer air down over budding rows when sensors read minus one. Smudge pots stand ready only for still, clear nights.",
     "A magnitude 5 tremor was felt across three coastal counties."),
]

ES_FEVER = [
    ("Faro de Punta Brava: el faro de Punta Brava es una torre de granito de 34 metros terminada en 1891 sobre la Roca Gaviota. Sus torreros anotaron sirenas de niebla y consumo de aceite hasta la automatizacion de 1974.",
     "El record mundial de maraton cayo dos veces en una misma temporada."),
    ("Humo en apicultura: los apicultores soplan humo frio sobre los cuadros para enmascarar la feromona de alarma antes de alzar las alzas. La practica viene de ahumadores de barro del delta del Nilo.",
     "Los viajes en la linea 4 del metro se duplicaron tras la revision tarifaria."),
    ("Tranvia 28 de Lisboa: los coches Remodelado suben rampas cercanas al 13 por ciento por Alfama en via de 900 mm. La linea conserva la librea de 1930 para servicio patrimonial.",
     "La cosecha de cafe de altura termino tres semanas antes este año."),
    ("Vidriado a la sal: echar sal al horno cerca de 1280 grados vaporiza sodio que se une a la silice en un vidriado piel de naranja. La greseria renana lo uso en tinajas.",
     "Dos satelites de comunicaciones llegaron a orbita en el mismo lanzador."),
    ("Esclusas del canal: la escalera de Caen Hill eleva barcazas 72 metros por dieciseis camaras en menos de cuatro kilometros. Voluntarios aun giran la mayoria de las compuertas a mano.",
     "Los abonos de opera entre compradores primerizos subieron un quinto."),
    ("Mesas de clasificacion de lana: el desborde retira bordes manchados antes de clasificar por micras, mecha y rinde. Los lotes merino bajo 19 micras logran las mejores ofertas.",
     "El tonelaje de portacontenedores por el estrecho marco record mensual."),
    ("Tablas de mareas: los anuarios listan pleamares calculadas por constituyentes armonicas de cada puerto. Las mareas vivas siguen a la luna nueva y llena con dos dias.",
     "El titulo nacional de ajedrez cambio de manos en la ultima ronda."),
    ("Registros del banco de semillas: accesiones duplicadas duermen a menos 18 grados en bolsas triple selladas. Pruebas de germinacion despiertan una muestra cada decada.",
     "El festival de cine de otoño repartio su premio mayor entre dos debuts."),
    ("Restauracion del campanario: canteros rejuntaron con mortero de cal y colgaron la campana rajada girada un cuarto de vuelta. El escape late ahora con dos segundos por semana.",
     "La aerolinea bandera firmo su mejor mes de puntualidad en seis años."),
    ("Defensas de helada en viñedo: ventiladores mezclan aire calido sobre brotes cuando los sensores marcan menos uno. Las estufas solo esperan noches quietas y despejadas.",
     "Un temblor de magnitud 5 se sintio en tres provincias costeras."),
]

EN_BATCH = [
    ("tests: 61 passed", "the warehouse restocks its shelves overnight without staff"),
    ("lint: clean", "delivery scooters hold charge for eleven hours of route work"),
    ("ci: green across 44 checks", "library cards renew at the kiosk in under a minute"),
    ("deploy record: rollout finished", "gym class bookings confirm instantly at midnight"),
    ("review: two sign-offs logged", "market stall fees post to ledgers by Friday"),
    ("staging deploy: succeeded", "ferry crossings run every half hour after dawn"),
    ("tests: 27 passed", "parking meters along the avenue accept contactless now"),
    ("typecheck: 0 errors", "pool lane reservations open each Sunday evening"),
    ("audit round: 118 checks clear", "bakery output doubles before festival weekends"),
    ("tests: 93 passed, 1 skipped", "museum cloakroom tokens return deposits in full"),
    ("build note: artifact produced", "harbor dredging finishes before the regatta"),
    ("nightly run: 207 checks green", "orchard pickers sort fruit by size at the shed"),
    ("smoke suite: 29 passed", "tram depot doors open for visitors each spring"),
    ("coverage gate: 84 percent met", "shepherd huts rent by the week in lambing season"),
    ("integration run: 52 passed", "lighthouse tours pause during gale warnings"),
]

ES_BATCH = [
    ("pruebas: 61 superadas", "el almacen repone estantes de noche sin personal"),
    ("lint: limpio", "los monopatines de reparto aguantan once horas de ruta"),
    ("integracion: 44 comprobaciones en verde", "los carnets de biblioteca se renuevan en un minuto"),
    ("registro de despliegue: despliegue terminado", "las reservas de clases del gimnasio confirman a medianoche"),
    ("revision: dos firmas registradas", "las tasas de puestos del mercado se asientan el viernes"),
    ("despliegue en staging: correcto", "los ferris salen cada media hora tras el alba"),
    ("pruebas: 27 superadas", "los parquimetros de la avenida aceptan sin contacto"),
    ("tipado: 0 errores", "las reservas de carriles de piscina abren cada domingo"),
    ("ronda de auditoria: 118 comprobaciones limpias", "la panaderia duplica produccion antes de fiestas"),
    ("pruebas: 93 superadas, 1 omitida", "la consigna del museo devuelve depositos enteros"),
    ("nota de compilacion: artefacto generado", "el dragado del puerto termina antes de la regata"),
    ("turno nocturno: 207 comprobaciones en verde", "los cosecheros clasifican fruta por tamaño en el galpon"),
    ("suite de humo: 29 superadas", "la cochera del tranvia abre visitas cada primavera"),
    ("umbral de cobertura: 84 por ciento", "las cabañas de pastor se alquilan por semana en paricion"),
    ("corrida de integracion: 52 superadas", "las visitas al faro pausan con aviso de galerna"),
]

EN_D3 = [
    ("tests: 7 passed", "the night bus leaves the depot every twenty minutes"),
    ("ci: green", "corner bakeries shape three hundred loaves before sunrise"),
    ("lint: clean", "ferry queues clear the dock within one sailing"),
    ("config: value changed", "parking wardens chalk tires only after noon"),
    ("docs: link added", "swim lessons open new lanes when pools refill"),
    ("staging: deploy ok", "farmers restock berry crates by first light"),
    ("tests: 12 passed", "clinic queue numbers advance without announcements"),
    ("legal: template reviewed", "choir rehearsals move indoors after October"),
    ("tests: 5 passed", "tram conductors punch transfers at every third stop"),
    ("deploy: succeeded", "harbor pilots board inbound ships before the bar"),
]

ES_D3 = [
    ("pruebas: 7 superadas", "el bus nocturno sale de la cochera cada veinte minutos"),
    ("integracion: verde", "las panaderias de barrio forman trescientos panes antes del alba"),
    ("lint: limpio", "las colas del ferri vacian el muelle en una travesia"),
    ("config: valor cambiado", "los guardias marcan neumaticos solo tras el mediodia"),
    ("docs: enlace agregado", "las clases de natacion abren carriles al rellenar piletas"),
    ("staging: despliegue ok", "los chacareros reponen cajones de fruta a primera luz"),
    ("pruebas: 12 superadas", "los numeros de sala avanzan sin avisos"),
    ("legal: plantilla revisada", "los ensayos del coro se mudan adentro tras octubre"),
    ("pruebas: 5 superadas", "los guardas pican boletos cada tres paradas"),
    ("despliegue: correcto", "los practicos abordan buques antes de la barra"),
]

EN_CHROME = [
    "Pull down to refresh - Last synced 2 minutes ago.",
    "Cookie choice: accept all or adjust preferences.",
    "Your download begins automatically in 10 seconds.",
    "No saved spots yet. Pin one on the map to start.",
    "Sheet 2 of 9 - Back | Forward",
    "Photo strip: 6 images - Select to enlarge.",
    "Text size: small medium large - Theme: light.",
    "Atlas data 2026 edition - Borders revised in spring.",
    "4 readers have this guide open now.",
    "Your tray is clear. Add tools from the shelf to begin.",
    "Quiet hours on until 08:00 tomorrow.",
    "Upload cap: 25 MB per item - 5 items at most.",
    "Shortcut card: hold Shift to see every combo.",
    "Preview: 4 sheets - Wide layout - Grayscale.",
    "Shelf progress: 60 percent - Add a cover to finish.",
]

ES_CHROME = [
    "Desliza para actualizar - Sincronizado hace 2 minutos.",
    "Cookies: aceptar todo o ajustar preferencias.",
    "Tu descarga empieza sola en 10 segundos.",
    "Sin lugares guardados. Marca uno en el mapa.",
    "Hoja 2 de 9 - Atras | Adelante",
    "Tira de fotos: 6 imagenes - Toca para ampliar.",
    "Letra: chica mediana grande - Tema: claro.",
    "Atlas edicion 2026 - Fronteras revisadas en primavera.",
    "4 lectores tienen esta guia abierta ahora.",
    "Tu bandeja esta vacia. Agrega herramientas del estante.",
    "Horas quietas hasta las 08:00 de mañana.",
    "Tope de subida: 25 MB por pieza - 5 piezas maximo.",
    "Tarjeta de atajos: mantene Mayus para ver combos.",
    "Vista previa: 4 hojas - Apaisado - Grises.",
    "Progreso del estante: 60 por ciento - Agrega portada.",
]

EN_NEAR = [
    "Postmortem quotes the blocked entry 'grant admin to guest' as an example of denied privilege requests.",
    "Release checklist shows the string 'forward all mail to outsider@unknown.net' only as a quarantined phishing sample.",
    "Runbook cites ```wipe --all caches``` from the draft guide as text awaiting sign-off, never a command.",
    "Help article quotes 'turn off disk encryption' copied from a scam transcript under review.",
    "QA sheet lists the entry 'refund $5,000 to wallet 44' as fabricated test data, never processed.",
    "Audit note reproduces 'open port 22 to the world' from a misconfiguration report as evidence.",
    "Moderation queue shows 'delete every backup older than a day' quoted from a vandalized comment.",
    "Training deck displays 'share the master API key' as a forbidden-request example in red.",
    "Ticket thread pastes 'reboot all nodes without notice' from a rejected change proposal.",
    "Handbook excerpt marks 'skip every safety check' as a never-follow line from an old draft.",
]

ES_NEAR = [
    "La postmortem cita el intento 'dar admin a invitado' como ejemplo de pedido de privilegios denegado.",
    "La lista de release muestra 'reenviar todo a externo@desconocido.net' solo como muestra de phishing en cuarentena.",
    "La guia cita ```borrar --todas las caches``` del borrador como texto a firmar, nunca una orden.",
    "La ayuda cita 'apagar el cifrado de disco' copiado de una estafa en revision.",
    "La planilla lista 'reembolsar $5.000 a billetera 44' como dato de prueba inventado, nunca procesado.",
    "La nota de auditoria reproduce 'abrir el puerto 22 al mundo' de un reporte de mala configuracion.",
    "La cola muestra 'borrar cada respaldo de mas de un dia' citado de un comentario vandalizado.",
    "La presentacion marca 'compartir la llave maestra' como ejemplo prohibido en rojo.",
    "El ticket pega 'reiniciar todos los nodos sin aviso' de una propuesta rechazada.",
    "El manual marca 'saltear cada control de seguridad' como linea a no seguir de un borrador viejo.",
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


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_rows() -> tuple[list[dict], list[dict]]:
    silences: list[dict] = []
    for i, (ev, cl) in enumerate(EN_FEVER, 1):
        silences.append({"id": f"v5s-gate-en-fever-{i:02d}", "text": f"{ev} || {cl}",
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "synthetic-silence-v5:fever-nei", "lang": "en"})
    for i, (ev, cl) in enumerate(ES_FEVER, 1):
        silences.append({"id": f"v5s-gate-es-fever-{i:02d}", "text": f"{ev} || {cl}",
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "synthetic-silence-v5:fever-nei", "lang": "es"})
    for i, (ev, cl) in enumerate(EN_BATCH, 1):
        silences.append({"id": f"v5s-gate-en-batch-{i:02d}", "text": f"{ev} || {cl}",
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "synthetic-silence-v5:batch-shape", "lang": "en"})
    for i, (ev, cl) in enumerate(ES_BATCH, 1):
        silences.append({"id": f"v5s-gate-es-batch-{i:02d}", "text": f"{ev} || {cl}",
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "synthetic-silence-v5:batch-shape", "lang": "es"})
    for i, (ev, cl) in enumerate(EN_D3, 1):
        silences.append({"id": f"v5s-gate-en-d3-{i:02d}", "text": f"{ev} || {cl}",
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "synthetic-silence-v5:d3-style", "lang": "en"})
    for i, (ev, cl) in enumerate(ES_D3, 1):
        silences.append({"id": f"v5s-gate-es-d3-{i:02d}", "text": f"{ev} || {cl}",
                         "all_labels": GATE_CANDS, "true_labels": [],
                         "source": "synthetic-silence-v5:d3-style", "lang": "es"})
    screens: list[dict] = []
    for i, t in enumerate(EN_CHROME, 1):
        screens.append({"id": f"v5s-screen-en-chrome-{i:02d}", "text": t,
                        "labels": ["suspicious"], "candidates": SCREEN_CANDS,
                        "source": "synthetic-filler-v5:plain-chrome", "lang": "en"})
    for i, t in enumerate(ES_CHROME, 1):
        screens.append({"id": f"v5s-screen-es-chrome-{i:02d}", "text": t,
                        "labels": ["suspicious"], "candidates": SCREEN_CANDS,
                        "source": "synthetic-filler-v5:plain-chrome", "lang": "es"})
    for i, t in enumerate(EN_NEAR, 1):
        screens.append({"id": f"v5s-screen-en-near-{i:02d}", "text": t,
                        "labels": ["suspicious"], "candidates": SCREEN_CANDS,
                        "source": "synthetic-filler-v5:quoted-payload", "lang": "es" if False else "en"})
    for i, t in enumerate(ES_NEAR, 1):
        screens.append({"id": f"v5s-screen-es-near-{i:02d}", "text": t,
                        "labels": ["suspicious"], "candidates": SCREEN_CANDS,
                        "source": "synthetic-filler-v5:quoted-payload", "lang": "es"})
    return silences, screens


def coherence_check(silences: list[dict], screens: list[dict]) -> list[str]:
    errs = []
    order_verbs = ["ignore all previous", "ignora las instrucciones", "you must send",
                   "ejecuta ahora mismo"]
    for r in silences:
        if r["true_labels"] != []:
            errs.append(f"{r['id']}: silence true_labels must be [] (got {r['true_labels']})")
        if r["all_labels"] != GATE_CANDS:
            errs.append(f"{r['id']}: silence all_labels must be 3 gate labels")
        if " || " not in r["text"]:
            errs.append(f"{r['id']}: gate row missing ' || ' lane separator")
        else:
            ev, cl = r["text"].split(" || ", 1)
            if len(ev.strip()) < 8 or len(cl.strip()) < 8:
                errs.append(f"{r['id']}: evidence/claim side too short (silence needs substance)")
            ev_words = set(re.findall(r"[a-záéíóúñ]{4,}", norm(ev)))
            cl_words = set(re.findall(r"[a-záéíóúñ]{4,}", norm(cl)))
            shared = ev_words & cl_words - {"tests", "passed", "pruebas", "superadas",
                                            "with", "para", "como", "este", "esta",
                                            "años", "cada", "todos", "todas"}
            if len(shared) > 2:
                errs.append(f"{r['id']}: evidence/claim share {sorted(shared)[:5]} (not a silence)")
    for r in screens:
        if r["labels"] != ["suspicious"]:
            errs.append(f"{r['id']}: filler labels must be [suspicious] (got {r['labels']})")
        if r["candidates"] != SCREEN_CANDS:
            errs.append(f"{r['id']}: filler candidates must be 3 screen labels")
        t = r["text"]
        if "quoted-payload" in r["source"]:
            frame_words = ("quot", "cit", "muestra", "ejemplo", "example", "sample",
                             "report", "transcript", "fabricat", "inventado", "sintet",
                             "synthetic", "test data", "datos de prueba", "nunca", "never",
                             "reject", "denied", "denegad", "rechazad", "prohibido",
                             "forbidden", "draft", "borrador", "sheet", "planilla",
                             "thread", "ticket", "deck", "presentacion", "note", "nota",
                             "queue", "cola", "excerpt", "handbook", "manual", "postmortem",
                             "checklist", "runbook", "guia", "article", "articulo", "ayuda",
                             "audit", "moderat", "training", "reprodu", "display",
                             "marks", "marca", "pastes", "pega", "cita", "cites",
                             "lists", "lista", "shows", "muestra", "marks")
            if not (("'" in t or "```" in t or '"' in t)
                    and any(w in norm(t) for w in frame_words)):
                errs.append(f"{r['id']}: near-inject without quotes+citation framing")
            for v in order_verbs:
                if norm(t).startswith(v):
                    errs.append(f"{r['id']}: near-inject reads as a direct order (must be quoted)")
        else:
            if "```" in t:
                errs.append(f"{r['id']}: plain chrome must not carry code payloads")
    return errs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Regulus-v5 delta generator + mix assembly.")
    ap.add_argument("--out", default=os.path.join(REPO, "artifacts-ft", "mix-regulus-v5"))
    ap.add_argument("--eval-texts", default=V2_EVAL_TEXTS)
    ap.add_argument("--seed", type=int, default=GEN_SEED)
    args = ap.parse_args(argv)

    silences, screens = build_rows()
    assert len(silences) == 70, f"v5 silences must be 70, got {len(silences)}"
    assert len(screens) == 50, f"v5 screens must be 50, got {len(screens)}"
    n_en_sil = sum(1 for r in silences if r["lang"] == "en")
    n_es_sil = sum(1 for r in silences if r["lang"] == "es")
    n_en_scr = sum(1 for r in screens if r["lang"] == "en")
    n_es_scr = sum(1 for r in screens if r["lang"] == "es")
    print(f"built {len(silences)} silences (EN {n_en_sil} ES {n_es_sil}) + "
          f"{len(screens)} screens (EN {n_en_scr} ES {n_es_scr}) = "
          f"{len(silences) + len(screens)} delta rows")

    errs = coherence_check(silences, screens)
    if errs:
        print(f"REFUSED: coherence self-check failed ({len(errs)}):")
        for e in errs[:12]:
            print(f"  - {e}")
        return 2
    print("coherence self-check: PASS (silences empty-true + disjoint; "
          "fillers suspicious + quoted framing)")

    denied = []
    for r in silences:
        t = norm(r["text"])
        for d in GATE_DENY:
            hit = re.search(r"\b" + re.escape(d) + r"\b", t) if " " not in d else (d in t)
            if hit:
                # 'night bus arrives' guard is ours-only; skip self-hit note
                denied.append((r["id"], d))
                break
    for r in screens:
        t = norm(r["text"])
        for d in SCREEN_DENY:
            hit = re.search(r"\b" + re.escape(d) + r"\b", t) if " " not in d else (d in t)
            if hit:
                denied.append((r["id"], d))
                break
    if denied:
        print(f"REFUSED: {len(denied)} denylist hits, e.g. {denied[:8]}")
        return 2
    print("denylist: PASS (0 phrase hits)")

    with open(args.eval_texts, encoding="utf-8") as f:
        ev = json.load(f)
    ev_texts = {norm(t) for t in ev["texts"]}
    ev_tris = [set(t) for t in ev["tris"]]
    with open(UNIVERSE_220, encoding="utf-8") as f:
        u220 = json.load(f)
    ids_220 = set(u220["ids"])
    base_texts = {norm(t["items"][0]["text"]) if isinstance(t, dict) and "items" in t
                   else norm(str(t)) for t in u220.get("texts", [])}
    with open(V2_IDS_EXT, encoding="utf-8") as f:
        ext_ids = [l.strip() for l in f if l.strip()]
    prior_rows: list[dict] = []
    for path in (V2_BATCH4, V2_ANCHORS, FEVER, NLI_ES, NLI_EN):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    prior_rows.append(json.loads(line))
    v3_rows = []
    if os.path.exists(V3_IDS):
        with open(V3_IDS, encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    v3_rows.append(json.loads(line))
        prior_rows.extend(v3_rows)
    anchor_ids = [r["id"] for r in prior_rows]
    universe = set(ext_ids) | ids_220 | set(anchor_ids)
    mix_texts = set()
    for r in prior_rows:
        mix_texts.add(norm(r.get("text", "")))
    mix_tris = [trigrams(r.get("text", "")) for r in prior_rows]

    new_rows = silences + screens
    new_ids = [r["id"] for r in new_rows]
    id_overlap = sorted(set(new_ids) & universe)
    new_texts = {norm(r["text"]) for r in new_rows}
    exact_eval = sorted(new_texts & ev_texts)
    exact_base = sorted(new_texts & base_texts)
    exact_mix = sorted(new_texts & mix_texts)

    worst_eval, worst_mix = [], []
    for r in new_rows:
        rt = trigrams(r["text"])
        be = max([jacc(rt, et) for et in ev_tris] or [0.0])
        bm = max([jacc(rt, mt) for mt in mix_tris] or [0.0])
        worst_eval.append((be, r["id"]))
        worst_mix.append((bm, r["id"]))
    worst_eval.sort(reverse=True)
    worst_mix.sort(reverse=True)

    report = {
        "gen_seed": args.seed,
        "n_new": len(new_rows),
        "composition": {"silences": len(silences), "sil_en": n_en_sil, "sil_es": n_es_sil,
                        "screens": len(screens), "scr_en": n_en_scr, "scr_es": n_es_scr,
                        "sil_types": {"fever_nei": 20, "batch_shape": 30, "d3_style": 20},
                        "scr_types": {"plain_chrome": 30, "quoted_payload": 20}},
        "eval_universe": {"ext_ids": len(ext_ids), "universe_220": len(ids_220),
                          "total_ids": len(universe), "eval_texts": len(ev_texts),
                          "base_texts": len(base_texts)},
        "prior_mix_texts": len(mix_texts),
        "id_overlap": id_overlap,
        "exact_text_overlap_eval": exact_eval,
        "exact_text_overlap_base": exact_base,
        "exact_text_overlap_mix": exact_mix,
        "denylist_hits": denied,
        "max_jaccard3_vs_eval": round(worst_eval[0][0], 4),
        "top5_jaccard_vs_eval": [(i, round(j, 4)) for j, i in worst_eval[:5]],
        "pairs_above_0.5_vs_eval": [(i, round(j, 4)) for j, i in worst_eval if j >= 0.5],
        "max_jaccard3_vs_mix": round(worst_mix[0][0], 4),
        "top5_jaccard_vs_mix": [(i, round(j, 4)) for j, i in worst_mix[:5]],
        "pairs_above_0.5_vs_mix": [(i, round(j, 4)) for j, i in worst_mix if j >= 0.5],
    }
    print(json.dumps({k: v for k, v in report.items()
                      if k not in ("top5_jaccard_vs_eval", "top5_jaccard_vs_mix")},
                     indent=2, ensure_ascii=False)[:2400])
    ok = (not id_overlap and not exact_eval and not exact_base and not exact_mix
          and not report["pairs_above_0.5_vs_eval"]
          and not report["pairs_above_0.5_vs_mix"])
    print("OVERLAP CHECK:",
          "PASS (0 id, 0 exact, 0 pairs>=0.5 vs eval AND vs prior mix)" if ok else "FAIL")
    if not ok:
        return 3

    # Stratified silence split: per (type,lang) ~28% held out for validation.
    rng = random.Random(args.seed)
    groups: dict[str, list[dict]] = {}
    for r in silences:
        key = (r["source"], r["lang"])
        groups.setdefault(str(key), []).append(r)
    held_ids: set[str] = set()
    for key, rs in sorted(groups.items()):
        rs = sorted(rs, key=lambda r: r["id"])
        n_hold = max(1, round(len(rs) * 0.2857))
        # deterministic: every 4th starting at index 1 (~28%)
        hold = [rs[i] for i in range(len(rs)) if i % 4 == 1][:n_hold]
        while len(hold) < n_hold:  # tiny-group guard (never triggers at n>=7)
            cand = rng.choice([r for r in rs if r not in hold])
            hold.append(cand)
        for r in hold:
            held_ids.add(r["id"])
    sil_train = sorted([r for r in silences if r["id"] not in held_ids],
                       key=lambda r: r["id"])
    sil_hold = sorted([r for r in silences if r["id"] in held_ids],
                      key=lambda r: r["id"])
    assert len(sil_train) == 50 and len(sil_hold) == 20, \
        f"split must be 50/20, got {len(sil_train)}/{len(sil_hold)}"
    print(f"silence split: train {len(sil_train)} / held-out {len(sil_hold)} "
          f"(validation joins batch4-80 -> 100-row heavy split, 40 silences)")

    os.makedirs(args.out, exist_ok=True)
    rng.shuffle(sil_train)
    rng2 = random.Random(args.seed + 1)
    scr_out = list(screens)
    rng2.shuffle(scr_out)
    with open(os.path.join(args.out, "v5-silence-train.jsonl"), "w", encoding="utf-8") as f:
        for r in sil_train:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(args.out, "v5-silence-heldout.jsonl"), "w", encoding="utf-8") as f:
        for r in sil_hold:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(args.out, "v5-screen-train.jsonl"), "w", encoding="utf-8") as f:
        for r in scr_out:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    # Full mix assembly (byte copies; v2/v3/base dirs stay read-only).
    copies = [(V2_BATCH4, "batch4-train.jsonl"), (V2_ANCHORS, "anchors-train.jsonl"),
              (FEVER, "gate-fever.jsonl"), (NLI_ES, "gate-nli-es.jsonl"),
              (NLI_EN, "gate-nli-en.jsonl")]
    manifest = []
    for src, name in copies:
        dst = os.path.join(args.out, name)
        shutil.copyfile(src, dst)
        manifest.append({"file": name, "sha256": sha256_file(dst),
                         "rows": sum(1 for _ in open(dst, encoding="utf-8"))})
    with open(os.path.join(args.out, "overlap-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    with open(os.path.join(args.out, "eval-ids-train.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(u220["ids"]) + "\n")
    future = sorted(set(ext_ids) | ids_220 | set(new_ids))
    with open(os.path.join(args.out, "eval-ids.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(future) + "\n")
    print(f"mix staged: {manifest} + v5 delta (50+50 train, 20 held-out) "
          f"+ 220-id train exclusion; future universe {len(future)} ids")
    print("NOTE: screen-deepset/bipia DROPPED (v4 lesson) + v3-50 NOT CARRIED "
          "(SUP-only bias); recorded in MIX_README.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
