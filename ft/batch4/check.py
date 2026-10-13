"""Batch-4 schema checker (SIGNED mode, post human sign-off 2026-10-12).

Validates ids unique, required keys, lang balance, SIGNED oracles/whys,
per-lane gold shapes. Rejects ANY DRAFT leftover (promotion proof).
No eval harness imports.
"""
import json
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent

SIG = "SIGNED (human 2026-10-12)"

FILES = {
    "classify-other.jsonl": ("classify", {"classification", "decision", "abstained", "why"}),
    "gate-silence.jsonl": ("gate", {"verdict", "decision", "abstained", "why"}),
    "screen-filler.jsonl": ("screen", {"assessment", "decision", "why"}),
    "d3-distill-candidates.jsonl": ("gate", {"verdict", "decision", "abstained", "why"}),
}

BASE_KEYS = {"id", "kind", "lang", "class", "gold_source", "input", "oracle", "gold"}

errors: list[str] = []
seen: dict[str, str] = {}
counts: dict[str, dict[str, int]] = {}

for fname, (lane, gold_keys) in FILES.items():
    path = BASE / fname
    rows = path.read_text(encoding="utf-8").splitlines()
    counts[fname] = {"total": 0, "en": 0, "es": 0}
    for lineno, line in enumerate(rows, 1):
        if not line.strip():
            continue
        if "DRAFT" in line:
            errors.append(f"{fname}:{lineno} DRAFT leftover (promotion incomplete)")
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"{fname}:{lineno} bad JSON: {e}")
            continue
        counts[fname]["total"] += 1
        missing = BASE_KEYS - set(row)
        if missing:
            errors.append(f"{fname}:{lineno} {row.get('id', '?')} missing keys {sorted(missing)}")
            continue
        rid = row["id"]
        if rid in seen:
            errors.append(f"{fname}:{lineno} duplicate id {rid} (also in {seen[rid]})")
        else:
            seen[rid] = fname
        lang = row["lang"]
        if lang not in ("en", "es"):
            errors.append(f"{fname}:{lineno} {rid} bad lang {lang!r}")
        else:
            counts[fname][lang] += 1
        oracle = row["oracle"]
        if not isinstance(oracle, str) or not oracle.startswith(SIG):
            errors.append(f"{fname}:{lineno} {rid} oracle must start with {SIG!r}")
        gold = row["gold"]
        if not isinstance(gold, dict) or set(gold) != gold_keys:
            errors.append(f"{fname}:{lineno} {rid} gold keys {sorted(gold) if isinstance(gold, dict) else type(gold)} != {sorted(gold_keys)}")
        else:
            why = gold.get("why")
            if not isinstance(why, str) or not why.startswith(SIG):
                errors.append(f"{fname}:{lineno} {rid} gold.why must start with {SIG!r}")
        if not isinstance(row["input"], dict) or not row["input"]:
            errors.append(f"{fname}:{lineno} {rid} input must be a non-empty object")
        if row.get("gold_source") != "independent":
            errors.append(f"{fname}:{lineno} {rid} gold_source must be 'independent'")

print("batch4 schema check (SIGNED mode)")
for fname, c in counts.items():
    print(f"  {fname}: total={c['total']} en={c['en']} es={c['es']}")
print(f"  unique ids: {len(seen)}")

# Balance guards: classify/gate 10+10, screen 20+20, d3 12+12
guards = [
    ("classify-other.jsonl", 10, 10),
    ("gate-silence.jsonl", 10, 10),
    ("d3-distill-candidates.jsonl", 12, 12),
]
for fname, want_en, want_es in guards:
    c = counts[fname]
    if c["en"] < want_en or c["es"] < want_es:
        errors.append(f"{fname} below minimum en>={want_en} es>={want_es}: got {c}")
sc = counts["screen-filler.jsonl"]
if sc["en"] < 20 or sc["es"] < 20:
    errors.append(f"screen-filler.jsonl below 20+20: got {sc}")

if errors:
    print("FAIL:")
    for e in errors:
        print(f"  - {e}")
    sys.exit(1)
print(f"OK: all schema checks passed ({SIG}, 0 DRAFT leftovers)")
