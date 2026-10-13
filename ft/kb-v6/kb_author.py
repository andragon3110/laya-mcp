"""kb-v6 template authoring helper (anchors precedent: deterministic seed-fixed
template+slot expansion, NO LLM, NO corpus mining).

filter_rows(): build-time guard — denylist + exact-text + Jaccard-3>=0.5 vs
the EXTENDED exclusion universe (fresh 220 texts + mix-v2 337 texts; ids vs
244+220 union). Rejections recorded with cause; caller oversamples and takes
the first-N survivors (never forces rows in).
"""
import itertools
import json
import os
import random
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))
sys.path.insert(0, BASE)
from kb_util import norm, denied, trigrams, jacc

_universe = None


def universe():
    global _universe
    if _universe is None:
        ev = json.load(open(os.path.join(BASE, "eval-universe.json"), encoding="utf-8"))
        mx = json.load(open(os.path.join(REPO, "artifacts-ft", "mix-regulus-v2",
                                         "eval-texts.json"), encoding="utf-8"))
        texts = list(ev["texts"]) + list(mx["texts"])
        _universe = {"texts": {norm(t) for t in texts},
                     "tris": [trigrams(t) for t in texts]}
    return _universe


def check_text(text):
    """Returns None if clean, else 'denylist:X' / 'exact-eval' / 'near-eval:0.XXX'."""
    d = denied(text)
    if d:
        return "denylist:" + d
    u = universe()
    if norm(text) in u["texts"]:
        return "exact-eval"
    rt = trigrams(text)
    worst = 0.0
    for et in u["tris"]:
        j = jacc(rt, et)
        if j > worst:
            worst = j
            if worst >= 0.5:
                return "near-eval:%.3f" % worst
    return None


def expand(templates, slot_dict, rng):
    """Cartesian product of NAMED slots into templates, shuffled."""
    cands = []
    keys = list(slot_dict.keys())
    for t in templates:
        for combo in itertools.product(*[slot_dict[k] for k in keys]):
            try:
                cands.append(t.format(**dict(zip(keys, combo))))
            except (IndexError, KeyError):
                continue
    rng.shuffle(cands)
    return cands


def take_clean(cands, want, stats, prefix):
    """First-want survivors; records every rejection. Never forces."""
    out = []
    for c in cands:
        if len(out) >= want:
            break
        if not c or len(c) > 3500:
            stats["drops"].append({"id": "%s-cand" % prefix, "reason": "length"})
            continue
        cause = check_text(c)
        if cause:
            stats["drops"].append({"id": "%s-cand" % prefix, "reason": cause})
            continue
        out.append(c)
    return out
