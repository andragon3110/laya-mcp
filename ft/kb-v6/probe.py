"""kb-v6 probe: existence + splits + sizes + license tags for all spec sources. Read-only, fast (no full downloads)."""
import warnings
warnings.filterwarnings("ignore")
from datasets import get_dataset_config_names, get_dataset_split_names
from huggingface_hub import HfApi

IDS = ["facebook/xnli", "facebook/anli", "tals/vitaminc",
       "tasksource/fool-me-twice", "tasksource/faviq", "fever/fever",
       "deepset/prompt-injections", "geodesic-research/bipia", "nyu-mll/glue"]

api = HfApi()
for did in IDS:
    try:
        info = api.dataset_info(did)
        tags = info.tags or []
        lic = [t for t in tags if t.startswith("license:")]
        print(f"== {did} OK  licenses={lic or 'UNLISTED'}")
        try:
            cfgs = get_dataset_config_names(did)
            print(f"   configs: {cfgs[:12]}{'...' if len(cfgs) > 12 else ''}")
        except Exception as e:
            print(f"   configs ERR: {str(e)[:160]}")
        for cfg in (["plain_text"] if did == "fever/fever" else []) :
            try:
                print(f"   splits({cfg}): {get_dataset_split_names(did, cfg)}")
            except Exception as e:
                print(f"   splits({cfg}) ERR: {str(e)[:160]}")
    except Exception as e:
        print(f"== {did} MISSING/ERR: {str(e)[:200]}")
# default-config splits for the key ones
for did, cfg in [("facebook/anli", None), ("tals/vitaminc", None),
                 ("tasksource/fool-me-twice", None), ("tasksource/faviq", None),
                 ("deepset/prompt-injections", None), ("nyu-mll/glue", "mnli_matched")]:
    try:
        if cfg:
            print(f"splits {did}/{cfg}: {get_dataset_split_names(did, cfg)}")
        else:
            print(f"splits {did}: {get_dataset_split_names(did)}")
    except Exception as e:
        print(f"splits {did} ERR: {str(e)[:200]}")
