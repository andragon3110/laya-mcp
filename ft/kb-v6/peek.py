"""kb-v6 schema peek: first-row columns of each source (streaming, no full pull)."""
import warnings
warnings.filterwarnings("ignore")
from datasets import load_dataset

JOBS = [
    ("facebook/xnli", "es", "train", 3),
    ("facebook/anli", "plain_text", "train_r1", 3),
    ("tals/vitaminc", "default", "train", 3),
    ("tasksource/fool-me-twice", "default", "train", 3),
    ("tasksource/faviq", "default", "train", 3),
    ("deepset/prompt-injections", "default", "train", 3),
    ("geodesic-research/bipia", "bipia", "train", 2),
]
for did, cfg, split, n in JOBS:
    try:
        ds = load_dataset(did, cfg, split=split, streaming=True)
        print(f"== {did}/{cfg}/{split}: features={list(ds.features.keys())}")
        for i, r in enumerate(ds.take(n)):
            keys = {k: (str(v)[:120].replace(chr(10), ' ')) for k, v in r.items()}
            print(f"   row{i}: {keys}")
    except Exception as e:
        print(f"== {did} ERR: {str(e)[:300]}")
# opus-mt availability (no download)
try:
    from huggingface_hub import HfApi
    api = HfApi()
    for m in ["Helsinki-NLP/opus-mt-en-es", "Helsinki-NLP/opus-mt-es-en"]:
        try:
            info = api.model_info(m)
            print(f"MT {m}: OK tags={[t for t in (info.tags or []) if 'license' in t]}")
        except Exception as e:
            print(f"MT {m} ERR: {str(e)[:120]}")
except Exception as e:
    print("hub ERR", str(e)[:120])
