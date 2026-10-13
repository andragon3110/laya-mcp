"""kb-v6 shared utils: denylist (single source), norm, trigrams, Jaccard, IO."""
import json
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(BASE))
sys.path.insert(0, os.path.join(REPO, "ft", "base-v4"))
from build import DENY  # noqa: E402  single source for the denylist

GATE_CANDS = ["SUPPORTED", "CONTRADICTED", "ABSTAIN"]
SCREEN_CANDS = ["benign", "suspicious", "malicious"]
CLASSIFY_CANDS = ["bug", "feature", "other"]


def norm(s):
    return re.sub(r"\s+", " ", str(s).strip().lower())


def denied(text):
    t = norm(text)
    for d in DENY:
        hit = re.search(r"\b" + re.escape(d) + r"\b", t) if " " not in d else (d in t)
        if hit:
            return d
    return None


def trigrams(s):
    toks = norm(s).split()
    if len(toks) < 3:
        return {" ".join(toks)}
    return {" ".join(toks[i:i + 3]) for i in range(len(toks) - 2)}


def jacc(a, b):
    return len(a & b) / len(a | b) if a and b else 0.0


def digits(s):
    return re.findall(r"\d+", str(s))


def write_jsonl(path, rows):
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def load_jsonl(path):
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]
