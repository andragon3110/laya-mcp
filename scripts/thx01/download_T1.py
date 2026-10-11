"""T1 downloads: resume + sha pins for THX-01 + 3 teachers.

Usage: ../py/.venv-thx01/bin/python scripts/thx01/download_T1.py [--skip-ultra]
Writes: scripts/thx01/pins.json (+ partial on timeout/failure, never blocks T1).
Time-box: 1h per model (SIGALRM-free, uses per-model timeout via subprocess-free
 wall-clock check between files is not feasible with snapshot_download, so the
 caller wraps each model call with `timeout 3600`).
"""
import json
import sys
import time
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download

OUT = Path(__file__).with_name("pins.json")
MODELS = [
    "doofz/THX-01",
    "convaiinnovations/laya-typed-decisions",
    "MoritzLaurer/ModernBERT-large-zeroshot-v2.0",
    "knowledgator/gliclass-multilang-ultra",
]

only = sys.argv[1:]  # optional subset of model ids
targets = [m for m in MODELS if (not only or m in only)]


def load_existing():
    if OUT.exists():
        try:
            return json.loads(OUT.read_text())
        except Exception:
            return {}
    return {}


def main():
    api = HfApi()
    pins = load_existing()
    for repo in targets:
        t0 = time.time()
        status = "ok"
        rev = sha = None
        path = None
        err = None
        try:
            info = api.model_info(repo)
            rev = info.sha
            path = snapshot_download(
                repo_id=repo,
                revision=rev,  # pin exact sha -> reproducible + resumable cache
                resume_download=True,
                max_workers=4,
            )
            sha = rev
        except Exception as e:  # noqa: BLE001 - record and continue, never block T1
            status = f"failed: {type(e).__name__}: {e}"[:500]
            err = status
        pins[repo] = {
            "revision": sha,
            "local_path": path,
            "status": status,
            "elapsed_s": round(time.time() - t0, 1),
        }
        if err:
            print(f"[download] {repo}: {err}", flush=True)
        else:
            print(
                f"[download] {repo}: OK sha={sha[:12] if sha else '?'} "
                f"elapsed={pins[repo]['elapsed_s']}s path={path}",
                flush=True,
            )
        OUT.write_text(json.dumps(pins, indent=2, ensure_ascii=False) + "\n")
    print(f"[download] pins written to {OUT}")


if __name__ == "__main__":
    main()
