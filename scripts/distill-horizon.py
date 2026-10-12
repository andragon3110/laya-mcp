#!/usr/bin/env python3
"""S5-distill: Margin-MSE distillation of Horizon mmBERT on measured hard rows.

Parent decision (odd/tasks/spike-horizon-rerank.md S5-distill): distill ONLY
on hard rows with live Qwen-0.6B (:8768) teacher margins + gold orders.
Gate: r1-rerank 11/12 hold + extended >= 10/12, else record and stop.

Recipe precedent (read-only): laya-mcp-finetune-gliclass r3 —
  * mix weighting (hard rows upweighted, anchors weight 1),
  * eval-loss delta with abort if eval-loss rises > 0.3 vs baseline,
  * sha discipline (triplets file hashed before training, manifest).

Data (FIXED before training, <= 100 triplets):
  * 12 extended hard ES rows (gold pos/neg from duel_ext.mjs, golds fixed
    before any signal),
  * 12 r1-rerank rows (gold pos/neg from evals/corpus-r1/rerank.mjs),
  * weights: extended own-misses + shared miss x4, r1 adversarial/difficult
    x2, anchors x1  =>  21 + 16 = 37 triplets (<= 100).

Teacher: live Qwen-0.6B via http://127.0.0.1:8768/rerank (NEVER touched,
read-only scoring). Target margin = teacher_margin(pos - neg by GOLD order)
when the teacher's sign agrees with gold, else the median agreeing teacher
margin (gold_fallback, recorded per triplet). The shared miss
(xadv-es-legal-02, teacher also misses) therefore trains toward GOLD order
with a typical teacher-scale margin instead of a negative margin.

Loss: Margin-MSE  mean((student_margin - target_margin)^2)  (Hofstaetter et
al., Indonesian-distill style), student margin = sigmoid(logit_pos) -
sigmoid(logit_neg) from the SAME cross-encoder pair scoring as serving.

Method: LoRA (peft, pinned version in MANIFEST) on ModernBert
Wqkv/Wo/Wi, r=8, alpha=16, dropout 0.05, AdamW LR 1e-4, CPU fp32.
Weights + run dir under /tmp/horizon-distill (+ HF cache reads only),
NEVER in the repo. :8774 sidecar is never swapped (parent owns promotion).

Outputs: /tmp/horizon-distill/<run>/ {triplets.jsonl, manifest.json,
adapter/, merged/} + stdout MANIFEST_JSON line for the record.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import resource
import sys
import time
import urllib.request
from datetime import datetime, timezone

RUN_TS = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
BASE_MODEL = "Horizon-Labs/multilingual-reranker-base"
TEACHER_URL = "http://127.0.0.1:8768/rerank"
RUN_ROOT = "/tmp/horizon-distill"
MAX_LENGTH = 384
SEED_S5 = 20261011  # S5 recipe seed (reproducibility anchor)
SEED_S5B = SEED_S5 + 1  # S5b retry seed (same family, bumped +1)
SEED = SEED_S5  # default = S5 behavior unless --tie-exclude/--seed set
TIE_EXCLUDE_DEFAULT = os.getenv("TIE_EXCLUDE", "0") == "1"


def is_tie_row(t: dict) -> bool:
    """Identical-text tie row: candidates equal => order is numeric noise."""
    return t["pos"] == t["neg"]

# ---------------------------------------------------------------- fixed data
# Extended 12 (query, gold-pos text, gold-neg text). pos/neg by GOLD order.
EXTENDED = [
    ("xadv-es-clinic-01",
     "¿Cómo saco un turno de odontología por obra social en CABA?",
     "Pedí el turno de odontología desde la cartilla de tu obra social: elegí prestador en CABA, seleccioná la especialidad y confirmá día y horario con tu credencial y DNI.",
     "Turno odontología obra social CABA dentista muela caries limpieza ortodoncia obra social turno online odontólogo urgente cordales empaste corona implante"),
    ("xadv-es-legal-01",
     "¿Qué plazo tengo para reclamar por un despido sin causa en Argentina?",
     "El reclamo por despido sin causa se inicia con telegrama laboral y prescribe a los dos años; la indemnización del art. 245 LCT se calcula sobre la mejor remuneración mensual.",
     "Despido sin causa indemnización juicio laboral abogado despido plazos reclamo telegrama ley contrato trabajo despido arbitrario salarios caídos demanda laboral fuero"),
    ("xadv-es-chat-01",
     "che, ¿dónde pago la factura de luz vencida sin recargo extra?",
     "Podés pagar la factura de luz vencida por la app de la distribuidora o en Pago Fácil con el código de barras; el recargo por mora se calcula sobre los días de atraso.",
     "Che factura luz vencida pagar Edesur Edenor boleta kilowatt recargo vencimiento pago facturas luz online che boleta medidor tarifa social subsidio"),
    ("xadv-es-clinic-02",
     "Mi hijo tiene fiebre de 39 y tos, ¿cuándo lo llevo a la guardia?",
     "Llevalo a la guardia si la fiebre de 39 persiste más de 48 horas, respira con dificultad o rechaza líquidos; mientras tanto hidratá y controlá la temperatura cada 6 horas.",
     "Fiebre tos pediatría guardia niño fiebre alta tos mocos gripe remedios pediatra termómetro jarabe tos fiebre diarrea vacuna control niño sano"),
    ("xadv-es-legal-02",  # shared miss (teacher also misses)
     "¿Puede el dueño aumentarme el alquiler fuera del contrato en CABA?",
     "No: el precio solo se ajusta según lo pactado en el contrato con el índice acordado; ningún aumento extra es exigible y podés intimar por carta documento.",
     "Alquiler aumento contrato dueño inquilino expensas depósito garantía CABA alquileres ley aumento expensas inmobiliaria comisión contrato alquiler dueño"),
    ("xadv-es-chat-02",  # Horizon own miss
     "Necesito renovar el DNI, ¿qué tengo que llevar al Renaper?",
     "Para renovar el DNI sacá turno en Mi Argentina y llevá el DNI anterior más la tasa paga; si cambiaste de domicilio sumá un servicio a tu nombre.",
     "DNI Renaper renovar trámite pasaporte partida nacimiento domicilio turno DNI express documento identidad CUIL Anses pasaporte visa migraciones"),
    ("xdiff-es-01",
     "¿Cada cuánto se hace el service del auto naftero?",
     "El service del naftero se hace cada 10.000 km o una vez por año: aceite, filtros y revisión de frenos.",
     "El service del auto incluye rotación de neumáticos y alineación cada 10.000 km, además del cambio de escobillas."),
    ("xdiff-es-02",  # Horizon own miss
     "¿Cómo doy de baja una suscripción de streaming desde la web?",
     "Entrá a tu cuenta en la web, abrí Suscripción y elegí Cancelar plan; la baja rige al fin del ciclo facturado.",
     "Desde la app del streaming podés pausar la suscripción un mes o cambiar de plan sin perder tu perfil."),
    ("xdiff-es-03",
     "¿Qué colectivo me deja en el Hospital Italiano desde Almagro?",
     "Desde Almagro el 168 te deja a dos cuadras del Hospital Italiano por Av. Rivadavia y Gascón.",
     "Desde Almagro el subte A hasta Plaza Miserere combina cerca del Hospital Italiano con un corto viaje en taxi."),
    ("xdiff-es-04",
     "¿Puedo freezar una tarta de ricota ya horneada?",
     "Sí: dejá enfriar la tarta de ricota horneada, envolvela en film y freezala hasta 3 meses; descongelá en heladera.",
     "La ricota fresca dura 3 días en heladera en recipiente hermético y no conviene guardarla a temperatura ambiente."),
    ("xxlang-01",
     "How do I dispute an incorrect charge on my electricity bill?",
     "Podés impugnar un cargo incorrecto de la factura de luz con reclamo formal ante la distribuidora y luego ante el ente regulador con tu número de cliente.",
     "Consejos para ahorrar electricidad en casa: bombillas LED, desconectar el standby y usar el aire en 24 grados."),
    ("xxlang-02",
     "¿Dónde reclamo si la aerolínea perdió mi valija?",
     "File a lost-baggage claim (PIR) at the airline desk before leaving arrivals with your boarding pass and bag tag, then track it with the reference code.",
     "Airlines offer cheap upgrades at check-in and extra legroom seats if you arrive early at the airport counter."),
]

# r1-rerank 12 (query, gold-pos, gold-neg). pos/neg by GOLD order.
R1 = [
    ("r1-rerank-en-normal-01", "how do I reset my password",
     "Open Settings, click Reset password, and follow the emailed link to choose a new one.",
     "Zebra migration notes for the spring season."),
    ("r1-rerank-en-normal-02", "quarterly revenue growth",
     "Quarterly revenue grew 5% on cloud sales.",
     "The cafeteria menu changes on Fridays."),
    ("r1-rerank-en-difficult-01", "slow database queries",
     "Guide to tuning indexes for faster queries.",
     "Nightly backup schedule for the database."),
    ("r1-rerank-en-ambiguous-01", "onboarding doc",
     "New hires start with the onboarding checklist.",
     "New hires start with the onboarding checklist."),
    ("r1-rerank-en-adversarial-01", "apple pie recipe",
     "Step-by-step apple pie recipe with ingredients and baking times.",
     "apple apple apple pie pie recipe recipe"),
    ("r1-rerank-en-negative-01", "quantum entanglement lecture notes",
     "Open Settings, click Reset password, and follow the emailed link.",
     "Zebra migration notes for the spring season."),
    ("r1-rerank-es-normal-01", "¿cómo restablezco mi contraseña?",
     "Abre Configuración, pulsa Restablecer contraseña y sigue el enlace que recibes por correo.",
     "Notas sobre la migración de las cebras en primavera."),
    ("r1-rerank-es-normal-02", "facturación del último trimestre",
     "La facturación creció un 5 % impulsada por las ventas en la nube.",
     "El menú del comedor cambia los viernes."),
    ("r1-rerank-es-difficult-01", "consultas lentas en la base de datos",
     "Guía para ajustar índices y acelerar las consultas.",
     "Calendario de copias de seguridad nocturnas de la base de datos."),
    ("r1-rerank-es-adversarial-01", "receta de tarta de manzana",
     "Receta paso a paso de tarta de manzana con ingredientes y tiempos de horneado.",
     "manzana manzana manzana tarta tarta receta receta"),
    ("r1-rerank-es-ambiguous-01", "documento de incorporación",
     "Las personas nuevas empiezan con la lista de incorporación.",
     "Las personas nuevas empiezan con la lista de incorporación."),
    ("r1-rerank-es-cross-01", "how do I change my email address",
     "Abre Configuración, selecciona Cuenta y pulsa Cambiar correo electrónico.",
     "Quarterly revenue grew 5% on cloud sales."),
]

EXTENDED_HARD_MISS = {"xadv-es-legal-02", "xadv-es-chat-02", "xdiff-es-02"}
R1_ADV_DIFF = {"r1-rerank-en-adversarial-01", "r1-rerank-es-adversarial-01",
               "r1-rerank-en-difficult-01", "r1-rerank-es-difficult-01"}


def triplet_weight(origin: str, tid: str) -> int:
    if origin == "extended":
        return 4 if tid in EXTENDED_HARD_MISS else 1
    return 2 if tid in R1_ADV_DIFF else 1


def teacher_margin(query: str, pos: str, neg: str, retries: int = 5) -> tuple[float, float, float]:
    """Live teacher margin from :8768 (read-only). Returns (pos, neg, margin)."""
    payload = json.dumps({"query": query, "candidates": [
        {"id": "pos", "text": pos}, {"id": "neg", "text": neg}]}).encode()
    last = None
    for _ in range(retries):
        try:
            req = urllib.request.Request(TEACHER_URL, data=payload,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = json.load(r)
            scores = {row["id"]: float(row["score"]) for row in body["ranked"]}
            return scores["pos"], scores["neg"], scores["pos"] - scores["neg"]
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2)
    raise RuntimeError(f"teacher unreachable after {retries} tries: {last!r}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=5)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--run-name", default=f"run-{RUN_TS}-s5")
    ap.add_argument("--tie-exclude", action="store_true",
                    default=TIE_EXCLUDE_DEFAULT,
                    help="exclude identical-text tie rows from Margin-MSE "
                         "targets (kept as eval-hold only); default off = S5 "
                         "behavior. Also enabled via TIE_EXCLUDE=1.")
    ap.add_argument("--seed", type=int, default=None,
                    help="override RNG seed (default: SEED_S5B when "
                         "--tie-exclude, else SEED_S5)")
    ap.add_argument("--dry-run", action="store_true",
                    help="build triplets + teacher margins only, no training")
    args = ap.parse_args()

    t_start = time.time()
    run_dir = os.path.join(RUN_ROOT, args.run_name)
    os.makedirs(run_dir, exist_ok=False)

    import peft  # pinned; import failure aborts with record (no silent fallback)
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tie_exclude = bool(args.tie_exclude)
    seed = args.seed if args.seed is not None else (SEED_S5B if tie_exclude else SEED_S5)
    print(json.dumps({"event": "versions", "peft": peft.__version__,
                      "run": args.run_name, "seed": seed,
                      "seed_s5": SEED_S5, "seed_s5b": SEED_S5B,
                      "tie_exclude": tie_exclude,
                      "torch": torch.__version__}), flush=True)

    # ---- 1. fixed triplets + live teacher margins (BEFORE training) ----
    unique = []
    for tid, q, pos, neg in EXTENDED:
        unique.append({"id": tid, "origin": "extended", "query": q,
                       "pos": pos, "neg": neg,
                       "weight": triplet_weight("extended", tid)})
    for tid, q, pos, neg in R1:
        unique.append({"id": tid, "origin": "r1", "query": q,
                       "pos": pos, "neg": neg,
                       "weight": triplet_weight("r1", tid)})
    assert len(unique) == 24 and sum(t["weight"] for t in unique) == 37 <= 100

    for t in unique:
        spos, sneg, m = teacher_margin(t["query"], t["pos"], t["neg"])
        t["teacher_pos"] = spos
        t["teacher_neg"] = sneg
        t["teacher_margin"] = m
        t["teacher_agrees_gold"] = bool(m > 0)
    agree = [t["teacher_margin"] for t in unique if t["teacher_margin"] > 0]
    agree.sort()
    gold_fallback = agree[len(agree) // 2]
    for t in unique:
        t["target_margin"] = (t["teacher_margin"] if t["teacher_agrees_gold"]
                              else gold_fallback)
        t["target_source"] = ("teacher" if t["teacher_agrees_gold"]
                              else "gold_fallback")
    n_disagree = sum(1 for t in unique if not t["teacher_agrees_gold"])

    trip_path = os.path.join(run_dir, "triplets.jsonl")
    with open(trip_path, "w") as f:
        for t in unique:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")
    with open(trip_path, "rb") as f:
        trip_sha = hashlib.sha256(f.read()).hexdigest()

    # S5b: identical-text tie rows leave Margin-MSE targets, stay eval-hold.
    # Default (tie_exclude=False) = exact S5 behavior.
    tie_hold_ids = [t["id"] for t in unique if is_tie_row(t)]
    train_set = [t for t in unique if not (tie_exclude and is_tie_row(t))]
    for t in unique:
        if tie_exclude and is_tie_row(t):
            t["target_source"] = "tie_hold_excluded"

    # expanded (weighted) training list, deterministic shuffle
    expanded = []
    for t in train_set:
        expanded += [t["id"]] * t["weight"]
    import random
    rng = random.Random(seed)
    rng.shuffle(expanded)
    by_id = {t["id"]: t for t in unique}

    print(json.dumps({"event": "data_fixed", "unique": len(unique),
                      "train_unique": len(train_set),
                      "expanded": len(expanded), "triplets_sha256": trip_sha,
                      "gold_fallback_margin": gold_fallback,
                      "teacher_disagree": n_disagree,
                      "tie_exclude": tie_exclude,
                      "tie_hold_ids": tie_hold_ids,
                      "disagree_ids": [t["id"] for t in unique
                                       if not t["teacher_agrees_gold"]]},
                     ensure_ascii=False), flush=True)
    if args.dry_run:
        print(json.dumps({"event": "dry_run_done", "run_dir": run_dir}), flush=True)
        return

    # ---- 2. student baseline margins (eval-loss BEFORE) ----
    torch.manual_seed(seed)
    device = "cpu"
    tok = AutoTokenizer.from_pretrained(BASE_MODEL)
    base = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL, dtype=torch.float32).to(device).eval()

    @torch.inference_mode()
    def student_margin(model, q, pos, neg) -> float:
        enc = tok([q, q], [pos, neg], padding=True, truncation=True,
                  max_length=MAX_LENGTH, return_tensors="pt")
        logits = model(**enc).logits[:, 0].sigmoid().tolist()
        return logits[0] - logits[1]

    base_margins = {t["id"]: student_margin(base, t["query"], t["pos"], t["neg"])
                    for t in unique}

    def eval_loss(margins) -> float:
        # S5b: eval-loss covers Margin-MSE targets only (tie rows are hold).
        return sum((margins[t["id"]] - t["target_margin"]) ** 2
                   for t in train_set) / len(train_set)

    loss_before = eval_loss(base_margins)

    # ---- 3. LoRA train ----
    from peft import LoraConfig, TaskType, get_peft_model

    model = AutoModelForSequenceClassification.from_pretrained(
        BASE_MODEL, dtype=torch.float32).to(device)
    cfg = LoraConfig(task_type=TaskType.SEQ_CLS, r=8, lora_alpha=16,
                     lora_dropout=0.05,
                     target_modules=["Wqkv", "Wo", "Wi"], bias="none")
    model = get_peft_model(model, cfg)
    model.train()
    n_train = sum(p.numel() for p in model.parameters() if p.requires_grad)

    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                            lr=args.lr)
    n_steps_epoch = (len(expanded) + args.batch - 1) // args.batch
    total_steps = n_steps_epoch * args.epochs
    warmup = max(1, total_steps // 10)

    def lr_at(step: int) -> float:
        if step < warmup:
            return args.lr * (step + 1) / warmup
        prog = (step - warmup) / max(1, total_steps - warmup)
        return args.lr * 0.5 * (1.0 + __import__("math").cos(3.14159265 * prog))

    step = 0
    train_losses = []
    for ep in range(args.epochs):
        if time.time() - t_start > 2 * 3600 - 600:
            print(json.dumps({"event": "TIMEBOX_STOP", "epoch": ep}), flush=True)
            break
        for i in range(0, len(expanded), args.batch):
            chunk = expanded[i:i + args.batch]
            opt.zero_grad(set_to_none=True)
            loss_acc = 0.0
            for tid in chunk:
                t = by_id[tid]
                enc = tok([t["query"], t["query"]], [t["pos"], t["neg"]],
                          padding=True, truncation=True, max_length=MAX_LENGTH,
                          return_tensors="pt")
                logits = model(**enc).logits[:, 0].sigmoid()
                sm = logits[0] - logits[1]
                loss = (sm - t["target_margin"]) ** 2
                (loss / len(chunk)).backward()
                loss_acc += float(loss.detach())
            for g in opt.param_groups:
                g["lr"] = lr_at(step)
            opt.step()
            train_losses.append(loss_acc / len(chunk))
            step += 1
        print(json.dumps({"event": "epoch", "epoch": ep + 1,
                          "mean_loss": sum(train_losses[-n_steps_epoch:]) / n_steps_epoch},
                         ), flush=True)

    # ---- 4. eval-loss AFTER + abort rule (r3 precedent: abort if +0.3) ----
    model.eval()
    tuned_margins = {}
    with torch.inference_mode():
        for t in unique:
            enc = tok([t["query"], t["query"]], [t["pos"], t["neg"]],
                      padding=True, truncation=True, max_length=MAX_LENGTH,
                      return_tensors="pt")
            logits = model(**enc).logits[:, 0].sigmoid().tolist()
            tuned_margins[t["id"]] = logits[0] - logits[1]
    loss_after = eval_loss(tuned_margins)
    abort = (loss_after - loss_before) > 0.3

    # ---- 5. save (adapter + merged fp32 for the sidecar) ----
    model.save_pretrained(os.path.join(run_dir, "adapter"))
    tok.save_pretrained(os.path.join(run_dir, "adapter"))
    merged = model.merge_and_unload()
    merged.save_pretrained(os.path.join(run_dir, "merged"))
    tok.save_pretrained(os.path.join(run_dir, "merged"))

    peak_ram_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    wall_s = time.time() - t_start
    tie_hold = {tid: {"base_margin": base_margins[tid],
                       "tuned_margin": tuned_margins[tid]}
                for tid in tie_hold_ids} if tie_exclude else {}
    if tie_exclude:
        print(json.dumps({"event": "tie_hold", "tie_hold": tie_hold},
                         ensure_ascii=False), flush=True)
    manifest = {
        "run": args.run_name, "date_utc": RUN_TS, "seed": seed,
        "seed_s5": SEED_S5, "seed_s5b": SEED_S5B,
        "tie_exclude": tie_exclude, "tie_hold_ids": tie_hold_ids,
        "tie_hold": tie_hold,
        "base": BASE_MODEL, "teacher": "Qwen/Qwen3-Reranker-0.6B live :8768",
        "method": "LoRA", "peft": peft.__version__,
        "lora": {"r": 8, "alpha": 16, "dropout": 0.05,
                 "targets": ["Wqkv", "Wo", "Wi"], "trainable": n_train},
        "hparams": {"epochs": args.epochs, "batch": args.batch, "lr": args.lr,
                    "loss": "Margin-MSE", "device": "cpu", "dtype": "fp32"},
        "data": {"unique": len(unique), "train_unique": len(train_set),
                 "expanded": len(expanded),
                 "triplets_sha256": trip_sha,
                 "gold_fallback_margin": gold_fallback,
                 "teacher_disagree": n_disagree},
        "eval_loss_before": loss_before, "eval_loss_after": loss_after,
        "eval_loss_delta": loss_after - loss_before,
        "abort_eval_loss_gt_0.3": abort,
        "wall_seconds": wall_s, "peak_ram_mb": peak_ram_mb,
        "vram_used_by_train_mb": 0,
        "run_dir": run_dir,
    }
    with open(os.path.join(run_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    print("MANIFEST_JSON " + json.dumps(manifest, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    sys.exit(main())
