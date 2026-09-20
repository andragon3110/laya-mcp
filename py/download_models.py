#!/usr/bin/env python3
"""
Pre-download the Laya model checkpoint(s) so the first laya-server boot
does not block on a multi-hundred-MB fetch.

By default this downloads the recommended checkpoint for coding agents
(`laya-typed-decisions`) into the HuggingFace cache, which is what
`laya.load(subfolder="typed-decisions")` reads. Other checkpoints can
be pulled on demand by setting `LAYA_MODELS` to a comma-separated list,
e.g. `LAYA_MODELS=convaiinnovations/laya,convaiinnovations/laya-multilingual`.

Idempotent: re-running is safe and skips already-cached files.
"""
from __future__ import annotations

import argparse
import os
import sys

DEFAULT_MODEL = "convaiinnovations/laya-typed-decisions"


def main() -> int:
    parser = argparse.ArgumentParser(description="Download Laya checkpoints for offline use.")
    parser.add_argument(
        "--model",
        default=os.getenv("LAYA_MODEL", DEFAULT_MODEL),
        help=f"HuggingFace model id (default: {DEFAULT_MODEL}).",
    )
    parser.add_argument(
        "--subfolder",
        default="typed-decisions",
        help="Subfolder inside the repo (default: typed-decisions).",
    )
    parser.add_argument(
        "--all-checkpoints",
        action="store_true",
        help="Download all three official Laya checkpoints (English, multilingual, typed-decisions).",
    )
    args = parser.parse_args()

    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        print("huggingface_hub not installed. Run: pip install -r py/requirements.txt", file=sys.stderr)
        return 2

    if args.all_checkpoints:
        # The three checkpoints Laya.Router can route between when preload=True
        # is set. All three are bundled under the `convaiinnovations/laya` repo
        # at different subfolders; huggingface_hub only downloads the requested
        # subfolder's weights.
        models = [
            ("convaiinnovations/laya", None),                         # english / ModernBERT-large
            ("convaiinnovations/laya-multilingual", None),            # multilingual / mmBERT-base
            ("convaiinnovations/laya-typed-decisions", "typed-decisions"),  # english / fine-tuned
        ]
    else:
        models = [(args.model, args.subfolder)]

    for repo_id, subfolder in models:
        print(f"[download] {repo_id}" + (f" (subfolder={subfolder})" if subfolder else ""))
        try:
            snapshot_download(
                repo_id=repo_id,
                subfolder=subfolder,
                allow_patterns=None,
                tqdm_class=None,
            )
            print(f"[download] {repo_id}: ok")
        except Exception as exc:  # noqa: BLE001
            print(f"[download] {repo_id}: FAILED -- {exc!r}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
