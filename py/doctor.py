"""
Diagnose the laya-mcp install: Laya SDK, downloaded checkpoints, GPU,
memory, the Python server, the built MCP bundle and the optional agent
config snippet. Returns a structured report -- never raises.

Each check returns a dict with:
  - name:    short identifier
  - status:  "pass" | "warn" | "fail" | "skip"
  - message: human-readable summary
  - detail:  optional extra context (paths, versions, etc.)

The aggregate report has `summary` (counts of pass/warn/fail/skip),
`checks` (ordered list), and a top-level `ok` boolean.
"""
from __future__ import annotations

import importlib
import importlib.util
import os
import shutil
import socket
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Where the install lives. Default matches install.sh.
INSTALL_DIR = Path(os.environ.get("LAYA_MCP_HOME", Path.home() / "laya-mcp")).expanduser()
HF_CACHE = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")).expanduser()
# Model snapshots live under $HF_HOME/hub/models--org--repo/snapshots/<rev>/.
# Fall back to $HF_HOME itself for non-standard layouts (e.g. HF_HUB_CACHE).
HF_HUB = HF_CACHE / "hub" if (HF_CACHE / "hub").exists() else HF_CACHE

# The three checkpoints we expect when Router mode is on.
EXPECTED_CHECKPOINTS = [
    ("english", "convaiinnovations/laya"),
    ("multilingual", "convaiinnovations/laya-multilingual"),
    ("typed-decisions", "convaiinnovations/laya-typed-decisions"),
]

# The HF cache layout for the bundled repo: `models--{org}--{repo}/snapshots/<rev>/<subfolder>/`.
HF_BUNDLE_REPO_DIR = HF_HUB / "models--convaiinnovations--laya"
HF_STANDALONE_DIRS = {
    "english": HF_HUB / "models--convaiinnovations--laya",
    "multilingual": HF_HUB / "models--convaiinnovations--laya-multilingual",
    "typed-decisions": HF_HUB / "models--convaiinnovations--laya-typed-decisions",
}


def _check(name: str, status: str, message: str, **detail: Any) -> Dict[str, Any]:
    return {"name": name, "status": status, "message": message, **({"detail": detail} if detail else {})}


def _ok(name: str, message: str, **detail: Any) -> Dict[str, Any]:
    return _check(name, "pass", message, **detail)


def _warn(name: str, message: str, **detail: Any) -> Dict[str, Any]:
    return _check(name, "warn", message, **detail)


def _fail(name: str, message: str, **detail: Any) -> Dict[str, Any]:
    return _check(name, "fail", message, **detail)


def _skip(name: str, message: str, **detail: Any) -> Dict[str, Any]:
    return _check(name, "skip", message, **detail)


# -- individual checks -------------------------------------------------------


def check_laya_sdk() -> Dict[str, Any]:
    """Is the Laya Python package importable, and at which version?"""
    try:
        spec = importlib.util.find_spec("laya")
        if spec is None:
            return _fail("laya-sdk", "laya Python package not installed", install_hint="pip install laya>=0.3.0,<0.4.0")
        laya = importlib.import_module("laya")
        version = getattr(laya, "__version__", None) or _pkg_version("laya") or "unknown"
        # Router is the surface we depend on.
        has_router = hasattr(laya, "Router")
        if not has_router:
            return _fail("laya-sdk", "laya SDK installed but Router class is missing", version=version)
        return _ok("laya-sdk", f"laya {version} installed with Router", version=version)
    except Exception as exc:  # noqa: BLE001
        return _fail("laya-sdk", f"failed to import laya: {exc!r}")


def check_laya_version_min() -> Dict[str, Any]:
    """Is the installed Laya SDK recent enough to support `subfolder=` (>=0.3.0)?"""
    raw = _pkg_version("laya")
    if raw is None:
        return _skip("laya-version", "laya not installed -- skipped version check")
    try:
        major, minor, *_ = (int(x) for x in raw.split(".")[:3])
    except ValueError:
        return _warn("laya-version", f"could not parse version {raw!r}", version=raw)
    if (major, minor) >= (0, 3):
        return _ok("laya-version", f"laya {raw} supports subfolder kwarg", version=raw)
    return _fail(
        "laya-version",
        f"laya {raw} is older than 0.3.0 -- the typed-decisions subfolder will not load",
        version=raw,
        required=">=0.3.0,<0.4.0",
    )


def _pkg_version(name: str) -> Optional[str]:
    try:
        from importlib.metadata import version

        return version(name)
    except Exception:  # noqa: BLE001
        return None


def check_checkpoints_present() -> List[Dict[str, Any]]:
    """Are all 3 Laya checkpoints cached locally for offline use?"""
    out: List[Dict[str, Any]] = []
    for ckpt_name, repo_id in EXPECTED_CHECKPOINTS:
        slug = repo_id.replace("/", "--")
        candidates = [HF_CACHE / f"models--{slug}"]
        if ckpt_name == "english":
            # bundled under convaiinnovations/laya, subfolder=None -> repo root
            sub = None
        elif ckpt_name == "multilingual":
            sub = "multilingual"
        elif ckpt_name == "typed-decisions":
            sub = "typed-decisions"
        else:
            sub = None

        bundled = HF_BUNDLE_REPO_DIR
        found_at: Optional[Path] = None
        for snap in bundled.glob("snapshots/*") if bundled.exists() else []:
            if sub is None:
                found_at = snap
                break
            if (snap / sub).exists():
                found_at = snap / sub
                break
        standalone = HF_STANDALONE_DIRS[ckpt_name]
        if found_at is None and standalone.exists():
            for snap in standalone.glob("snapshots/*"):
                found_at = snap
                break
        if found_at is None:
            out.append(
                _warn(
                    f"checkpoint:{ckpt_name}",
                    f"{repo_id} ({sub or 'root'}) not cached -- Router will download on first request",
                    repo=repo_id,
                    subfolder=sub,
                )
            )
        else:
            # quick size hint -- the snapshot dir is at least the size of weights.
            try:
                size_bytes = sum(p.stat().st_size for p in found_at.rglob("*") if p.is_file())
            except OSError:
                size_bytes = 0
            out.append(
                _ok(
                    f"checkpoint:{ckpt_name}",
                    f"{repo_id} ({sub or 'root'}) cached",
                    path=str(found_at),
                    size_mb=round(size_bytes / 1024 / 1024, 1),
                )
            )
    return out


def check_torch_and_device() -> List[Dict[str, Any]]:
    """Is torch installed? Is CUDA available? Will Laya run on GPU or CPU?"""
    try:
        torch = importlib.import_module("torch")
    except Exception:  # noqa: BLE001
        return [
            _warn(
                "torch",
                "torch not importable -- the Laya SDK may need it; install with `pip install torch`",
            )
        ]
    version = getattr(torch, "__version__", "unknown")
    cuda = bool(getattr(torch.cuda, "is_available", lambda: False)())
    if cuda:
        device_name = torch.cuda.get_device_name(0)
        try:
            # mem_get_info itself throws when VRAM is exhausted (e.g. all
            # checkpoints resident on a small card) -- the doctor must
            # report that, not crash.
            free_mem = torch.cuda.mem_get_info(0)[0] / 1024 ** 3
        except Exception:  # noqa: BLE001
            free_mem = 0.0
        if free_mem < 0.5:
            return [
                _ok(
                    "torch",
                    f"torch {version} installed",
                    version=version,
                ),
                _warn(
                    "gpu",
                    f"CUDA available: {device_name} but VRAM is (nearly) full "
                    f"({free_mem:.1f} GB free) -- if servers fail to load, "
                    f"set LAYA_DEVICE=cpu and/or GLINER_DEVICE=cpu",
                    device=device_name,
                    free_memory_gb=round(free_mem, 1),
                ),
            ]
        return [
            _ok(
                "torch",
                f"torch {version} installed",
                version=version,
            ),
            _ok(
                "gpu",
                f"CUDA available: {device_name} ({free_mem:.1f} GB free)",
                device=device_name,
                free_memory_gb=round(free_mem, 1),
            ),
        ]
    return [
        _ok("torch", f"torch {version} installed (CPU mode)", version=version),
        _warn("gpu", "no CUDA GPU detected -- Laya will run on CPU (~200 ms/call)", hint="set LAYA_DEVICE=cpu explicitly to silence this"),
    ]


def check_disk_for_models() -> Dict[str, Any]:
    """Is there enough free disk to hold all 3 checkpoints (~1.7 GB)?"""
    try:
        usage = shutil.disk_usage(str(INSTALL_DIR.parent if INSTALL_DIR.exists() else Path.home()))
    except Exception as exc:  # noqa: BLE001
        return _warn("disk", f"could not read disk usage: {exc!r}")
    free_gb = usage.free / 1024 ** 3
    if free_gb >= 3.0:
        return _ok("disk", f"{free_gb:.1f} GB free at {usage.free and str(INSTALL_DIR.parent)}", free_gb=round(free_gb, 1))
    if free_gb >= 1.8:
        return _warn("disk", f"only {free_gb:.1f} GB free -- tight for 3 checkpoints", free_gb=round(free_gb, 1), required_gb=3.0)
    return _fail("disk", f"only {free_gb:.1f} GB free -- not enough for 3 checkpoints (~1.7 GB)", free_gb=round(free_gb, 1), required_gb=3.0)


def check_memory_for_inference() -> Dict[str, Any]:
    """Best-effort check that the system has enough RAM to host all 3 checkpoints resident."""
    try:
        import psutil  # type: ignore

        avail = psutil.virtual_memory().available / 1024 ** 3
        total = psutil.virtual_memory().total / 1024 ** 3
    except Exception:  # noqa: BLE001
        return _skip("memory", "psutil not installed -- cannot read system memory")
    if avail >= 6.0:
        return _ok("memory", f"{avail:.1f} GB available of {total:.1f} GB total", available_gb=round(avail, 1), total_gb=round(total, 1))
    if avail >= 3.0:
        return _warn(
            "memory",
            f"{avail:.1f} GB available -- enough for 1 checkpoint at a time, not all 3 resident",
            available_gb=round(avail, 1),
            total_gb=round(total, 1),
            required_gb=6.0,
        )
    return _fail(
        "memory",
        f"{avail:.1f} GB available -- too little to host any Laya checkpoint",
        available_gb=round(avail, 1),
        total_gb=round(total, 1),
        required_gb=6.0,
    )


def check_install_dir() -> Dict[str, Any]:
    """Is the install dir present and does it have the expected layout?"""
    if not INSTALL_DIR.exists():
        return _fail(
            "install-dir",
            f"{INSTALL_DIR} does not exist -- run ./install.sh",
            path=str(INSTALL_DIR),
        )
    expected = {
        "py/laya_server.py": "Python server source",
        "py/download_models.py": "Pre-download helper",
        "dist/index.js": "Compiled MCP server (run npm run build)",
        "package.json": "Node manifest",
    }
    missing = [p for p in expected if not (INSTALL_DIR / p).exists()]
    if missing:
        return _fail(
            "install-dir",
            f"{INSTALL_DIR} is incomplete -- missing {missing}",
            path=str(INSTALL_DIR),
            missing=missing,
        )
    return _ok("install-dir", f"{INSTALL_DIR} looks complete", path=str(INSTALL_DIR))


def check_mcp_server_reachable(host: str, port: int) -> Dict[str, Any]:
    """Can we reach the Python HTTP server (i.e. start_laya.sh is running)?"""
    url = f"http://{host}:{port}/health"
    started = time.time()
    try:
        import urllib.request

        with urllib.request.urlopen(url, timeout=2) as r:
            body = json.loads(r.read())
        latency_ms = int((time.time() - started) * 1000)
        if r.status != 200:
            return _fail(
                "laya-server",
                f"GET {url} returned HTTP {r.status}",
                url=url,
                latency_ms=latency_ms,
            )
        if not body.get("ready"):
            return _warn(
                "laya-server",
                f"GET {url} returned ready=false: {body.get('error', 'no error detail')}",
                url=url,
                latency_ms=latency_ms,
                detail=body,
            )
        return _ok(
            "laya-server",
            f"GET {url} reachable in {latency_ms} ms",
            url=url,
            latency_ms=latency_ms,
            loaded=body.get("loaded"),
            laya_sdk_version=body.get("laya_sdk_version"),
        )
    except (urllib.error.URLError, socket.timeout, ConnectionRefusedError, OSError) as exc:
        return _warn(
            "laya-server",
            f"cannot reach {url}: {exc}. start it with $HOME/laya-mcp/start_laya.sh",
            url=url,
            hint="$HOME/laya-mcp/start_laya.sh",
        )
    except Exception as exc:  # noqa: BLE001
        return _fail("laya-server", f"unexpected error reaching {url}: {exc!r}", url=url)


def check_live_predict(host: str, port: int) -> Dict[str, Any]:
    """Send one trivial /predict call to make sure the Router is wired end-to-end."""
    url = f"http://{host}:{port}/predict"
    payload = {
        "state": "smoke test",
        "questions": {
            "smoke": {
                "type": "noul",
                "instructions": "Is this text non-empty?",
                "criteria": {"true": "non-empty", "false": "empty"},
            }
        },
    }
    started = time.time()
    try:
        import urllib.request

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            body = json.loads(r.read())
        latency_ms = int((time.time() - started) * 1000)
        if r.status != 200 or "answers" not in body:
            return _fail(
                "live-predict",
                f"POST {url} returned HTTP {r.status} or missing answers",
                url=url,
                latency_ms=latency_ms,
            )
        return _ok(
            "live-predict",
            f"POST {url} ok in {latency_ms} ms",
            url=url,
            latency_ms=latency_ms,
            routing=body.get("routing"),
        )
    except Exception as exc:  # noqa: BLE001
        return _fail("live-predict", f"POST {url} failed: {exc!r}", url=url)


GLINER_MODEL_ID = "fastino/gliner2.5-multi-v1"
GLINER_CACHE_DIR = HF_HUB / "models--fastino--gliner2.5-multi-v1"

# Smoke sentence in Spanish. Verified 2026-09-20 against the real
# checkpoint: all three entity types found with confidence > 0.95.
GLINER_SMOKE_TEXT = "María García trabaja en Acme España en Madrid."
GLINER_SMOKE_EXPECTED = {"persona", "organización", "lugar"}


def check_gliner_package() -> Dict[str, Any]:
    """Is the gliner2 SDK importable? Absent means the user did not opt in -- skip, don't fail."""
    try:
        spec = importlib.util.find_spec("gliner2")
        if spec is None:
            return _skip(
                "gliner-sdk",
                "gliner2 not installed -- GLiNER features opt-in via install.sh --with-gliner",
                install_hint="pip install -r py/requirements-gliner.txt",
            )
        gliner2 = importlib.import_module("gliner2")
        has_auto = hasattr(gliner2, "AutoExtractor")
        if not has_auto:
            return _fail("gliner-sdk", "gliner2 installed but AutoExtractor is missing", version=_pkg_version("gliner2"))
        return _ok(
            "gliner-sdk",
            f"gliner2 {_pkg_version('gliner2') or 'unknown'} installed with AutoExtractor",
            version=_pkg_version("gliner2"),
        )
    except Exception as exc:  # noqa: BLE001
        return _fail("gliner-sdk", f"failed to import gliner2: {exc!r}")


def check_gliner_checkpoint() -> Dict[str, Any]:
    """Is the GLiNER2.5 multilingual checkpoint cached? Skip when the SDK is absent."""
    if importlib.util.find_spec("gliner2") is None:
        return _skip("gliner-checkpoint", "gliner2 not installed -- skipping checkpoint check")
    found_at: Optional[Path] = None
    if GLINER_CACHE_DIR.exists():
        for snap in GLINER_CACHE_DIR.glob("snapshots/*"):
            found_at = snap
            break
    if found_at is None:
        return _warn(
            "gliner-checkpoint",
            f"{GLINER_MODEL_ID} not cached -- server will download ~594 MB on first request",
            repo=GLINER_MODEL_ID,
        )
    try:
        size_bytes = sum(p.stat().st_size for p in found_at.rglob("*") if p.is_file())
    except OSError:
        size_bytes = 0
    return _ok(
        "gliner-checkpoint",
        f"{GLINER_MODEL_ID} cached",
        path=str(found_at),
        size_mb=round(size_bytes / 1024 / 1024, 1),
    )


def check_gliner_server_reachable(host: str, port: int) -> Dict[str, Any]:
    """Can we reach the gliner-server? Skip when the SDK is absent (not opted in)."""
    if importlib.util.find_spec("gliner2") is None:
        return _skip("gliner-server", "gliner2 not installed -- gliner-server is opt-in")
    url = f"http://{host}:{port}/health"
    started = time.time()
    try:
        import urllib.request

        with urllib.request.urlopen(url, timeout=2) as r:
            body = json.loads(r.read())
        latency_ms = int((time.time() - started) * 1000)
        if r.status != 200:
            return _fail("gliner-server", f"GET {url} returned HTTP {r.status}", url=url, latency_ms=latency_ms)
        if not body.get("ready"):
            return _warn(
                "gliner-server",
                f"GET {url} returned ready=false: {body.get('error', 'no error detail')}",
                url=url,
                latency_ms=latency_ms,
            )
        return _ok(
            "gliner-server",
            f"GET {url} reachable in {latency_ms} ms",
            url=url,
            latency_ms=latency_ms,
            model=body.get("model"),
            device=body.get("device"),
        )
    except (urllib.error.URLError, socket.timeout, ConnectionRefusedError, OSError) as exc:
        return _warn(
            "gliner-server",
            f"cannot reach {url}: {exc}. start it with $HOME/laya-mcp/start_gliner.sh",
            url=url,
            hint="$HOME/laya-mcp/start_gliner.sh",
        )
    except Exception as exc:  # noqa: BLE001
        return _fail("gliner-server", f"unexpected error reaching {url}: {exc!r}", url=url)


def check_gliner_live_spanish(host: str, port: int) -> Dict[str, Any]:
    """End-to-end Spanish extraction smoke test against the running gliner-server."""
    if importlib.util.find_spec("gliner2") is None:
        return _skip("gliner-spanish", "gliner2 not installed -- skipping live Spanish smoke test")
    url = f"http://{host}:{port}/extract_entities"
    payload = {
        "text": GLINER_SMOKE_TEXT,
        "labels": ["persona", "organización", "lugar"],
    }
    started = time.time()
    try:
        import urllib.request

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            body = json.loads(r.read())
        latency_ms = int((time.time() - started) * 1000)
        if r.status != 200:
            return _fail("gliner-spanish", f"POST {url} returned HTTP {r.status}", url=url)
        entities = body.get("entities", {}) if isinstance(body, dict) else {}
        found = {etype for etype, spans in entities.items() if spans}
        missing = GLINER_SMOKE_EXPECTED - found
        if missing:
            return _fail(
                "gliner-spanish",
                f"Spanish smoke test missed entity types: {sorted(missing)}",
                url=url,
                latency_ms=latency_ms,
                found=sorted(found),
            )
        return _ok(
            "gliner-spanish",
            f"Spanish smoke test ok in {latency_ms} ms (persona/organización/lugar found)",
            url=url,
            latency_ms=latency_ms,
        )
    except Exception as exc:  # noqa: BLE001
        return _fail("gliner-spanish", f"POST {url} failed: {exc!r}", url=url)


def check_mcp_server_starts() -> Dict[str, Any]:
    """Spawn the MCP server briefly to confirm it boots without errors."""
    import subprocess

    dist = INSTALL_DIR / "dist" / "index.js"
    if not dist.exists():
        return _skip("mcp-server-boot", f"{dist} missing -- run npm run build")
    try:
        proc = subprocess.Popen(
            ["node", str(dist)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "LAYA_URL": "http://127.0.0.1:1"},  # force unreachable so it logs but does not hang
        )
        try:
            out, err = proc.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
        finally:
            if proc.poll() is None:
                proc.kill()
        # We expect the server to print its startup banner on stderr and stay alive.
        # Killing it is success: it did boot.
        return _ok("mcp-server-boot", f"{dist.name} booted and was reachable for stdio", stderr_tail=err.decode(errors="ignore")[-200:])
    except FileNotFoundError:
        return _fail("mcp-server-boot", f"{dist} not found")
    except Exception as exc:  # noqa: BLE001
        return _fail("mcp-server-boot", f"failed to spawn {dist}: {exc!r}")


# -- fase-8-final T3: opt-in sections (real data only, never invented) --------
#
# --models:     probe GET /models live; when the backend is down report
#               config+disk only (expected repos, HF cache paths, env pins).
#               Revisions are NEVER invented: live nulls stay null, disk
#               snapshots report path+size only.
# --policy:     report the effective LAYA_MODE*/LAYA_POLICY_* env verbatim +
#               validity. The registry lives in TS (src/policy/loader.ts);
#               thresholds are NOT duplicated here (see the note in detail).
# --mcp:        boot dist/index.js over stdio and run MCP initialize +
#               tools/list (raw JSON-RPC, stdlib only). Reuses the same
#               dist-missing skip as mcp-server-boot. Backend down is fine:
#               tools/list then honestly returns [laya_capabilities].
# --benchmark:  run `node evals/bench.mjs --json` live when the environment
#               allows (node + dist + timeout); otherwise report the last
#               versioned evals/results/v1 run with provenance. Numbers are
#               only ever quoted from a real run -- never invented.
# Every function below never raises: backend down / config absent produce
# honest warn/skip verdicts, not throws.


def _http_get_json(url: str, timeout: float) -> Tuple[int, Any]:
    """GET url and parse the body as JSON. Raises on any transport error."""
    import urllib.request

    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.status, json.loads(r.read())


def check_models_inventory(host: str, port: int) -> Dict[str, Any]:
    """Live GET /models inventory, or config+disk when the backend is down."""
    url = f"http://{host}:{port}/models"
    try:
        status, body = _http_get_json(url, timeout=3)
    except Exception as exc:  # noqa: BLE001 -- backend down is a verdict, not a throw
        snapshots: Dict[str, str] = {}
        for ckpt_name, repo_id in EXPECTED_CHECKPOINTS:
            slug = repo_id.replace("/", "--")
            snap_dir = HF_HUB / f"models--{slug}" / "snapshots"
            snapshots[ckpt_name] = str(snap_dir) if snap_dir.exists() else "not cached"
        return _warn(
            "models-inventory",
            f"laya-server unreachable at {url} -- reporting config+disk only (no live data; revisions never invented)",
            url=url,
            error=f"{exc!r}",
            expected_repos=[repo for _, repo in EXPECTED_CHECKPOINTS],
            snapshot_dirs=snapshots,
            hf_cache=str(HF_CACHE),
            env_pins={
                "LAYA_MODEL": os.environ.get("LAYA_MODEL", "(unset; default convaiinnovations/laya-typed-decisions)"),
                "LAYA_MODEL_REVISION": os.environ.get("LAYA_MODEL_REVISION", "(unset; unpinned)"),
                "GLINER_MODEL_REVISION": os.environ.get("GLINER_MODEL_REVISION", "(unset; unpinned)"),
            },
            tokenizer="unknown",
            tokenizer_note="neither GET /models nor laya_capabilities exposes a tokenizer; "
            "one would only appear if the backend ever publishes it",
        )
    if status != 200 or not isinstance(body, dict) or "models" not in body:
        return _fail(
            "models-inventory",
            f"GET {url} returned HTTP {status} or a body without 'models'",
            url=url,
            http_status=status,
        )
    models = body.get("models") or []
    names = [m.get("name", "?") for m in models if isinstance(m, dict)]
    loaded = [m.get("name", "?") for m in models if isinstance(m, dict) and m.get("loaded")]
    # Revisions come from the wire verbatim (always null + unpinned by
    # server design -- py/laya_server.py models_info). Unknown stays unknown.
    summary = [
        {
            "name": m.get("name"),
            "loaded": bool(m.get("loaded")),
            "revision": m.get("revision"),  # null by design, never invented
            "revision_source": m.get("revision_source", "unknown"),
            "device": m.get("device", "unknown"),
        }
        for m in models
        if isinstance(m, dict)
    ]
    return _ok(
        "models-inventory",
        f"GET {url} live: {len(models)} checkpoints ({', '.join(names)}), loaded={loaded or 'none'}",
        url=url,
        service=body.get("service"),
        server_version=(body.get("versions") or {}).get("server") if isinstance(body.get("versions"), dict) else None,
        models=summary,
        tokenizer="unknown",
        tokenizer_note="neither GET /models nor laya_capabilities exposes a tokenizer; "
        "one would only appear if the backend ever publishes it",
    )


# Valid global/per-tool policy modes (src/policy/mode.ts). Anything else
# falls back to observe -- the doctor reports the raw value, it never
# normalizes it away.
_POLICY_MODES = ("observe", "shadow", "enforce")

# Numeric cut-point overrides (src/policy/thresholds.ts THRESHOLD_ENV_VARS).
# Reported verbatim + parse-validity only; defaults live in TS and are NOT
# duplicated here.
_POLICY_NUMERIC_VARS = (
    "LAYA_POLICY_SCREEN_BLOCK",
    "LAYA_POLICY_SCREEN_REVIEW",
    "LAYA_POLICY_SCREEN_SUBSTANCE_SKIP",
    "LAYA_POLICY_CLAIM_VERIFIED",
    "LAYA_POLICY_CLAIM_CONTRADICTED",
    "LAYA_POLICY_REVIEW_AUTO",
    "LAYA_POLICY_REVIEW_MIN",
    "LAYA_POLICY_REQUIRE_SUPPORT",
)


def check_policy_effective() -> Dict[str, Any]:
    """Effective LAYA_MODE*/LAYA_POLICY_* env (verbatim) + registry note."""
    mode = os.environ.get("LAYA_MODE", "(unset; default observe)")
    per_tool = {k: v for k, v in os.environ.items() if k.startswith("LAYA_MODE_")}
    numeric = {k: os.environ.get(k, "(unset)") for k in _POLICY_NUMERIC_VARS}
    secrets = os.environ.get("LAYA_POLICY_SECRET_TYPES", "(unset)")
    revisions = {
        "LAYA_MODEL_REVISION": os.environ.get("LAYA_MODEL_REVISION", "(unset; unpinned)"),
        "GLINER_MODEL_REVISION": os.environ.get("GLINER_MODEL_REVISION", "(unset; unpinned)"),
    }
    invalid: List[str] = []
    if "LAYA_MODE" in os.environ and os.environ["LAYA_MODE"] not in _POLICY_MODES:
        invalid.append(f"LAYA_MODE={os.environ['LAYA_MODE']!r} (falls back to observe)")
    for k in sorted(per_tool):
        if per_tool[k] not in _POLICY_MODES:
            invalid.append(f"{k}={per_tool[k]!r} (falls back to observe)")
    for k in _POLICY_NUMERIC_VARS:
        raw = os.environ.get(k)
        if raw is not None:
            try:
                float(raw)
            except ValueError:
                invalid.append(f"{k}={raw!r} (unparseable; falls back to the v1 default)")
    detail = {
        "LAYA_MODE": mode,
        "per_tool_modes": per_tool or "(none)",
        "numeric_overrides": numeric,
        "LAYA_POLICY_SECRET_TYPES": secrets,
        "revision_pins": revisions,
        "registry": "TS-only: src/policy/loader.ts (14 policies @1.0.0); "
        "thresholds live there and are not duplicated here -- "
        "see laya_capabilities / EVALUATION.md for the live view",
    }
    if invalid:
        return _warn(
            "policy-effective",
            f"policy env has {len(invalid)} invalid entr{'y' if len(invalid) == 1 else 'ies'} (each falls back; nothing crashes): "
            + "; ".join(invalid),
            invalid=invalid,
            **detail,
        )
    n_overrides = len(per_tool) + sum(1 for k in _POLICY_NUMERIC_VARS if k in os.environ)
    return _ok(
        "policy-effective",
        f"policy env clean: LAYA_MODE={mode}, {n_overrides} override(s), 0 invalid (registry: TS src/policy/loader.ts)",
        **detail,
    )


_MCP_PROTOCOL_VERSION = "2025-11-25"  # newest accepted by the bundled SDK 1.30.0


def _mcp_tools_list(dist: Path, timeout_s: float) -> Tuple[Optional[List[str]], Optional[str]]:
    """Speak MCP initialize + tools/list over stdio. Returns (names, error).

    Raw newline-delimited JSON-RPC (stdlib only -- no MCP SDK in Python).
    Any failure returns (None, reason); never raises past socket/subprocess
    errors the caller already handles... in fact never raises at all.
    """
    import queue
    import subprocess
    import threading

    try:
        proc = subprocess.Popen(
            ["node", str(dist)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ},
        )
    except FileNotFoundError as exc:
        return None, f"node not found: {exc!r}"
    except Exception as exc:  # noqa: BLE001
        return None, f"failed to spawn {dist}: {exc!r}"

    lines: "queue.Queue[str]" = queue.Queue()

    def _reader() -> None:
        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                lines.put(raw.decode(errors="ignore"))
        except Exception:  # noqa: BLE001 -- reader thread must never kill the check
            pass

    reader = threading.Thread(target=_reader, daemon=True)
    reader.start()
    deadline = time.time() + timeout_s

    def _send(obj: Dict[str, Any]) -> None:
        assert proc.stdin is not None
        proc.stdin.write((json.dumps(obj) + "\n").encode())
        proc.stdin.flush()

    def _wait_for(rid: int) -> Optional[Dict[str, Any]]:
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            try:
                raw = lines.get(timeout=min(remaining, 5.0))
            except queue.Empty:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if isinstance(msg, dict) and msg.get("id") == rid:
                return msg

    try:
        _send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": _MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "laya-doctor", "version": "0"},
                },
            }
        )
        init = _wait_for(1)
        if init is None:
            return None, f"no initialize response within {timeout_s:g}s"
        if "error" in init:
            return None, f"initialize rejected: {init['error']}"
        _send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        _send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        listed = _wait_for(2)
        if listed is None:
            return None, f"no tools/list response within {timeout_s:g}s"
        if "error" in listed:
            return None, f"tools/list rejected: {listed['error']}"
        tools = ((listed.get("result") or {}).get("tools")) or []
        names = [t.get("name", "?") for t in tools if isinstance(t, dict)]
        return names, None
    except Exception as exc:  # noqa: BLE001
        return None, f"stdio conversation failed: {exc!r}"
    finally:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:  # noqa: BLE001
                pass


def check_mcp_tools_list(timeout_s: float = 30.0) -> Dict[str, Any]:
    """Boot the MCP server over stdio and run tools/list (real data)."""
    dist = INSTALL_DIR / "dist" / "index.js"
    if not dist.exists():
        return _skip("mcp-tools-list", f"{dist} missing -- run npm run build")
    names, error = _mcp_tools_list(dist, timeout_s)
    if error is not None:
        if error.startswith("node not found"):
            return _fail("mcp-tools-list", error, dist=str(dist))
        return _warn(
            "mcp-tools-list",
            f"{dist.name} spawned but tools/list did not complete: {error} "
            "(see mcp-server-boot for the boot verdict)",
            dist=str(dist),
            error=error,
        )
    assert names is not None
    if not names:
        return _warn(
            "mcp-tools-list",
            f"{dist.name} booted but tools/list advertised 0 tools -- current source "
            "(src/index.ts) always advertises at least laya_capabilities when the backend "
            "is down, so this installed dist is likely stale; rebuild (npm run build) or reinstall",
            dist=str(dist),
            tools=names,
        )
    degraded = names == ["laya_capabilities"]
    return _ok(
        "mcp-tools-list",
        f"stdio tools/list: {len(names)} tool(s) ({', '.join(names)})"
        + (" -- backend not ready, only the meta tool is advertised" if degraded else ""),
        dist=str(dist),
        tools=names,
        degraded_backend=degraded,
    )


def _repo_root() -> Path:
    """Checkout root for the doctor.py on disk (evals/results live here)."""
    return Path(__file__).resolve().parent.parent


def check_benchmark(bench_timeout_s: float = 120.0) -> Dict[str, Any]:
    """Live `node evals/bench.mjs --json` when feasible, else versioned results.

    Live path needs node + dist + evals/bench.mjs and must finish within
    bench_timeout_s. Anything else -- timeout, missing files, unparsable
    output -- falls back to the last versioned evals/results/v1 run quoted
    with provenance. No numbers are ever invented.
    """
    import subprocess

    root = _repo_root()
    bench_mjs = root / "evals" / "bench.mjs"
    results_dir = root / "evals" / "results" / "v1"
    if (root / "dist" / "index.js").exists() is False:
        dist_note = "dist/index.js missing -- run npm run build before a live bench"
    else:
        dist_note = "dist/index.js present"
    if bench_mjs.exists() and shutil.which("node") and (root / "dist" / "index.js").exists():
        try:
            proc = subprocess.run(
                ["node", str(bench_mjs), "--json"],
                cwd=str(root),
                capture_output=True,
                text=True,
                timeout=bench_timeout_s,
            )
            rep = json.loads(proc.stdout)
            prims = rep.get("primitives") or []
            sweep = rep.get("rerank_sweep") or []
            return _ok(
                "benchmark",
                f"live bench: {len(prims)} primitives + {len(sweep)} rerank rows "
                "(stub ceiling -- harness plumbing, NOT backend quality)",
                mode="live",
                command="node evals/bench.mjs --json",
                timeout_s=bench_timeout_s,
                primitives=len(prims),
                rerank_rows=len(sweep),
                method=rep.get("method"),
            )
        except Exception as exc:  # noqa: BLE001 -- timeout/noise falls back to versioned
            live_error = f"{exc!r}"
    else:
        live_error = f"live bench not attempted ({dist_note}; node={bool(shutil.which('node'))})"
    # -- versioned fallback: quote evals/results/v1 with provenance ---------
    manifest_p = results_dir / "manifest.json"
    bench_p = results_dir / "bench.json"
    try:
        manifest = json.loads(manifest_p.read_text(encoding="utf-8"))
        bench = json.loads(bench_p.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return _skip(
            "benchmark",
            f"no live bench ({live_error}) and no versioned results at {results_dir}: {exc!r} "
            "-- run node evals/bench.mjs --save",
            live_error=live_error,
            results_dir=str(results_dir),
        )
    prims = bench.get("primitives") or []
    sweep = bench.get("rerank_sweep") or []
    return _ok(
        "benchmark",
        f"versioned results {results_dir.name} (commit {manifest.get('commit_short')}, "
        f"{manifest.get('date')}, model {manifest.get('model')}): "
        f"{len(prims)} primitives + {len(sweep)} rerank rows "
        "(stub ceiling -- harness plumbing, NOT backend quality)",
        mode="versioned",
        live_error=live_error,
        manifest=str(manifest_p),
        commit=manifest.get("commit"),
        date=manifest.get("date"),
        model=manifest.get("model"),
        model_revision=manifest.get("model_revision"),
        tokenizer=manifest.get("tokenizer"),
        tokenizer_note=manifest.get("tokenizer_note"),
        primitives=len(prims),
        rerank_rows=len(sweep),
        method=manifest.get("method"),
    )


def _default_opencode_cfg() -> Path:
    """Resolve the effective global opencode.json.

    Honors OPENCODE_JSON first, then OPENCODE_CONFIG_DIR (which redirects
    the whole config dir, e.g. managed setups), then the standard location.
    """
    override = os.environ.get("OPENCODE_JSON")
    if override:
        return Path(override).expanduser()
    cfg_dir = os.environ.get("OPENCODE_CONFIG_DIR")
    if cfg_dir:
        return Path(cfg_dir).expanduser() / "opencode.json"
    return Path.home() / ".config" / "opencode" / "opencode.json"


def _find_laya_entry(data: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], str]:
    """Return (entry, shape) for the laya MCP server.

    Prefers the native V2 shape (mcp.servers.laya), falls back to the
    legacy V1 shape (mcp.laya). Returns (None, "") when absent.
    """
    mcp = data.get("mcp") or {}
    if isinstance(mcp, dict):
        servers = mcp.get("servers") or {}
        if isinstance(servers, dict) and isinstance(servers.get("laya"), dict):
            return servers["laya"], "mcp.servers.laya"
        if isinstance(mcp.get("laya"), dict):
            return mcp["laya"], "mcp.laya (legacy V1)"
    return None, ""


def _entry_disabled(entry: Dict[str, Any]) -> Tuple[bool, str]:
    """Return (disabled, field) honoring V2 `disabled` and legacy `enabled`."""
    if "disabled" in entry:
        return bool(entry["disabled"]), "disabled"
    if "enabled" in entry:
        return not bool(entry["enabled"]), "enabled (legacy V1)"
    return False, "(default)"


def _redact_env(env: Any) -> Any:
    """Redact secret-looking values from an MCP environment dict.

    Doctor reports travel in --json output, CI logs and the GET /doctor
    endpoint (localhost only, but still logged). Environment maps in
    opencode.json may carry tokens/keys, so values whose key looks secret
    are replaced with "[redacted]" -- names and non-secret values stay
    verbatim for debuggability. Non-dict input passes through untouched.
    """
    if not isinstance(env, dict):
        return env
    redacted: Dict[str, Any] = {}
    for k, v in env.items():
        kl = str(k).lower()
        if any(s in kl for s in ("token", "secret", "key", "password", "passwd", "auth", "bearer", "credential", "private")):
            redacted[k] = "[redacted]"
        else:
            redacted[k] = v
    return redacted


def check_optional_agent_configs() -> List[Dict[str, Any]]:
    """Are the optional opencode.json / Claude / Codex MCP entries present and well-formed?"""
    out: List[Dict[str, Any]] = []
    cfg = _default_opencode_cfg()
    if not cfg.exists():
        out.append(_skip("opencode-config", f"{cfg} does not exist -- MCP server is fully optional"))
        return out
    try:
        import json

        with cfg.open(encoding="utf-8") as f:
            data = json.load(f)
        mcp_laya, shape = _find_laya_entry(data)
        if not mcp_laya:
            out.append(
                _skip(
                    "opencode-config",
                    f"{cfg} exists but no {shape or 'mcp.servers.laya'} entry -- agent will not see laya-mcp tools",
                    path=str(cfg),
                )
            )
            return out
        disabled, field = _entry_disabled(mcp_laya)
        if disabled:
            out.append(
                _warn(
                    "opencode-config",
                    f"{shape} is configured but {field} disables it -- "
                    + ("set disabled=false" if field == "disabled" else "set enabled=true"),
                    path=str(cfg),
                )
            )
            return out
        return [
            _ok(
                "opencode-config",
                f"{shape} registered in {cfg}",
                command=mcp_laya.get("command"),
                env=_redact_env(mcp_laya.get("environment", {})),
            )
        ]
    except Exception as exc:  # noqa: BLE001
        return [_warn("opencode-config", f"could not parse {cfg}: {exc!r}", path=str(cfg))]


# -- aggregate --------------------------------------------------------------


def run_doctor(
    laya_host: str = "127.0.0.1",
    laya_port: int = 8765,
    include_live_calls: bool = True,
    gliner_host: str = "127.0.0.1",
    gliner_port: int = 8766,
    include_models: bool = False,
    include_policy: bool = False,
    include_mcp: bool = False,
    include_benchmark: bool = False,
    mcp_timeout_s: float = 30.0,
    bench_timeout_s: float = 120.0,
) -> Dict[str, Any]:
    """Run every check and return the structured report."""
    checks: List[Dict[str, Any]] = []
    checks.append(check_laya_sdk())
    checks.append(check_laya_version_min())
    checks.extend(check_torch_and_device())
    checks.append(check_disk_for_models())
    checks.append(check_memory_for_inference())
    checks.append(check_install_dir())
    checks.extend(check_checkpoints_present())
    checks.append(check_gliner_package())
    checks.append(check_gliner_checkpoint())
    if include_live_calls:
        checks.append(check_mcp_server_reachable(laya_host, laya_port))
        checks.append(check_live_predict(laya_host, laya_port))
        checks.append(check_gliner_server_reachable(gliner_host, gliner_port))
        checks.append(check_gliner_live_spanish(gliner_host, gliner_port))
    checks.append(check_mcp_server_starts())
    checks.extend(check_optional_agent_configs())
    # Fase-8-final T3 opt-in sections: real data only, never invented.
    # Backend down / config absent yield honest warn/skip, never throws.
    if include_models:
        checks.append(check_models_inventory(laya_host, laya_port))
    if include_policy:
        checks.append(check_policy_effective())
    if include_mcp:
        checks.append(check_mcp_tools_list(timeout_s=mcp_timeout_s))
    if include_benchmark:
        checks.append(check_benchmark(bench_timeout_s=bench_timeout_s))

    summary = {
        "pass": sum(1 for c in checks if c["status"] == "pass"),
        "warn": sum(1 for c in checks if c["status"] == "warn"),
        "fail": sum(1 for c in checks if c["status"] == "fail"),
        "skip": sum(1 for c in checks if c["status"] == "skip"),
    }
    summary["total"] = sum(summary.values())
    ok = summary["fail"] == 0

    return {
        "ok": ok,
        "summary": summary,
        "checks": checks,
        "checked_at": time.time(),
        "install_dir": str(INSTALL_DIR),
        "hf_cache": str(HF_CACHE),
        "python": sys.version.split()[0],
        "platform": sys.platform,
    }


# -- CLI --------------------------------------------------------------------

import json


def main() -> int:
    # Windows consoles default to cp1252, which cannot print the ✓/✗/!
    # markers -- force UTF-8 so the human report never crashes (modern
    # terminals render it; legacy ones show mojibake instead of a traceback).
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    import argparse

    parser = argparse.ArgumentParser(
        description="Diagnose laya-mcp: Laya SDK, downloaded checkpoints, server, MCP bundle, optional configs."
    )
    parser.add_argument("--host", default="127.0.0.1", help="laya-server host")
    parser.add_argument("--port", type=int, default=8765, help="laya-server port")
    parser.add_argument("--gliner-host", default="127.0.0.1", help="gliner-server host")
    parser.add_argument("--gliner-port", type=int, default=8766, help="gliner-server port")
    parser.add_argument(
        "--no-live",
        action="store_true",
        help="skip the live /health and /predict probes (useful in CI without the server running)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="emit JSON instead of a human-readable summary",
    )
    parser.add_argument(
        "--fail-on",
        choices=("fail", "warn"),
        default="fail",
        help="exit non-zero when checks at this level or worse are present (default: fail)",
    )
    parser.add_argument(
        "--models",
        action="store_true",
        help="probe live GET /models inventory; when the backend is down, report "
        "config+disk only (expected repos, HF cache paths, env pins) -- revisions are never invented",
    )
    parser.add_argument(
        "--policy",
        action="store_true",
        help="report the effective LAYA_MODE / LAYA_MODE_<TOOL> / LAYA_POLICY_* env verbatim + validity; "
        "the policy registry lives in TS (src/policy/loader.ts) and thresholds are not duplicated here",
    )
    parser.add_argument(
        "--mcp",
        action="store_true",
        help="boot dist/index.js over stdio and run MCP initialize + tools/list (real tool names; "
        "backend down honestly yields [laya_capabilities])",
    )
    parser.add_argument(
        "--benchmark",
        action="store_true",
        help="run live `node evals/bench.mjs --json` when the environment allows (node + dist + timeout); "
        "otherwise quote the last versioned evals/results/v1 run with provenance -- numbers never invented",
    )
    parser.add_argument(
        "--mcp-timeout-s",
        type=float,
        default=30.0,
        help="stdio tools/list budget in seconds (default: 30)",
    )
    parser.add_argument(
        "--bench-timeout-s",
        type=float,
        default=120.0,
        help="live bench budget in seconds before falling back to versioned results (default: 120)",
    )
    args = parser.parse_args()

    report = run_doctor(
        laya_host=args.host,
        laya_port=args.port,
        include_live_calls=not args.no_live,
        gliner_host=args.gliner_host,
        gliner_port=args.gliner_port,
        include_models=args.models,
        include_policy=args.policy,
        include_mcp=args.mcp,
        include_benchmark=args.benchmark,
        mcp_timeout_s=args.mcp_timeout_s,
        bench_timeout_s=args.bench_timeout_s,
    )

    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        _print_human(report)

    threshold = {"fail": 2, "warn": 1}[args.fail_on]
    return threshold if not report["ok"] else 0


def _print_human(report: Dict[str, Any]) -> None:
    s = report["summary"]
    ok_marker = "OK" if report["ok"] else "FAIL"
    print(f"\n[ laya-mcp doctor ]  [{ok_marker}]  {s['pass']} pass  {s['warn']} warn  {s['fail']} fail  {s['skip']} skip")
    print(f"  install_dir: {report['install_dir']}")
    print(f"  hf_cache:    {report['hf_cache']}")
    print(f"  python:      {report['python']}  platform: {report['platform']}\n")

    symbols = {"pass": "✓", "warn": "!", "fail": "✗", "skip": "-"}
    for c in report["checks"]:
        sym = symbols[c["status"]]
        line = f"  {sym} [{c['status'].upper():4}] {c['name']:<22}  {c['message']}"
        print(line)

    print()
    fails = [c for c in report["checks"] if c["status"] == "fail"]
    warns = [c for c in report["checks"] if c["status"] == "warn"]
    if fails:
        print("FAILURES -- laya-mcp will not work until these are fixed:")
        for c in fails:
            print(f"  - {c['name']}: {c['message']}")
        print()
    if warns and not fails:
        print("WARNINGS -- check these to be sure laya-mcp works for your workload:")
        for c in warns:
            print(f"  - {c['name']}: {c['message']}")
        print()


if __name__ == "__main__":
    sys.exit(main())
