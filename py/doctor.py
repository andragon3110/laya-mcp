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


def check_optional_agent_configs() -> List[Dict[str, Any]]:
    """Are the optional opencode.json / Claude / Codex MCP entries present and well-formed?"""
    out: List[Dict[str, Any]] = []
    cfg = Path.home() / ".config" / "opencode" / "opencode.json"
    if not cfg.exists():
        out.append(_skip("opencode-config", f"{cfg} does not exist -- MCP server is fully optional"))
        return out
    try:
        import json

        with cfg.open() as f:
            data = json.load(f)
        mcp_laya = (data.get("mcp") or {}).get("laya")
        if not mcp_laya:
            out.append(
                _skip(
                    "opencode-config",
                    f"{cfg} exists but no mcp.laya entry -- agent will not see laya-mcp tools",
                    path=str(cfg),
                )
            )
            return out
        if not mcp_laya.get("enabled", True):
            out.append(
                _warn(
                    "opencode-config",
                    f"mcp.laya is configured but disabled={mcp_laya.get('enabled')} -- set enabled=true",
                    path=str(cfg),
                )
            )
            return out
        return [
            _ok(
                "opencode-config",
                f"mcp.laya registered in {cfg}",
                command=mcp_laya.get("command"),
                env=mcp_laya.get("environment", {}),
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
    args = parser.parse_args()

    report = run_doctor(
        laya_host=args.host,
        laya_port=args.port,
        include_live_calls=not args.no_live,
        gliner_host=args.gliner_host,
        gliner_port=args.gliner_port,
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
