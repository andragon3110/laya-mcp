"""Fase-8-final T3 tests: doctor --models/--policy/--mcp/--benchmark plus
download_models --revision.

Offline only: backend down / config absent must yield honest warn/skip
verdicts, never throws. No network, no models, no GPU, stdlib only.

Run from the repo root:
    python -m unittest tests.test_doctor_t3 -v
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relpath)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


doctor = _load("laya_doctor_t3", "py/doctor.py")


def _scrub_laya_env(testcase):
    """Remove every LAYA_*/GLINER_* knob, restoring afterwards."""
    saved = dict(os.environ)
    for k in [k for k in os.environ if k.startswith(("LAYA_", "GLINER_"))]:
        del os.environ[k]
    testcase.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))


class ModelsTest(unittest.TestCase):
    def test_backend_down_warns_never_throws_never_invents(self):
        # Port 1 refuses immediately: no backend, no waiting.
        c = doctor.check_models_inventory("127.0.0.1", 1)
        self.assertEqual(c["status"], "warn")
        self.assertIn("config+disk", c["message"])
        blob = json.dumps(c)
        self.assertNotIn("revision_source\": \"backend", blob)
        self.assertIn("unpinned", blob)  # env pins reported verbatim
        self.assertEqual(c["detail"]["tokenizer"], "unknown")

    def test_live_null_revision_stays_null(self):
        payload = {
            "service": "laya-server",
            "versions": {"server": "9.9.9-test", "laya_sdk": "0.0.0"},
            "models": [
                {
                    "name": "english",
                    "repo": "convaiinnovations/laya",
                    "loaded": False,
                    "revision": None,
                    "revision_source": "unpinned",
                    "device": "cpu",
                    "circuit": "closed",
                }
            ],
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):  # silence
                pass

        srv = HTTPServer(("127.0.0.1", 0), Handler)
        port = srv.server_address[1]
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        try:
            c = doctor.check_models_inventory("127.0.0.1", port)
        finally:
            srv.shutdown()
        self.assertEqual(c["status"], "pass")
        self.assertEqual(len(c["detail"]["models"]), 1)
        self.assertIsNone(c["detail"]["models"][0]["revision"])
        self.assertEqual(c["detail"]["models"][0]["revision_source"], "unpinned")


class PolicyTest(unittest.TestCase):
    def test_clean_env_passes_with_defaults(self):
        _scrub_laya_env(self)
        c = doctor.check_policy_effective()
        self.assertEqual(c["status"], "pass")
        self.assertIn("0 invalid", c["message"])
        self.assertIn("observe", c["detail"]["LAYA_MODE"])
        self.assertIn("src/policy/loader.ts", c["detail"]["registry"])

    def test_invalid_mode_warns_with_fallback(self):
        _scrub_laya_env(self)
        os.environ["LAYA_MODE"] = "bogus"
        os.environ["LAYA_MODE_LAYA_SCREEN"] = "also-bogus"
        c = doctor.check_policy_effective()
        self.assertEqual(c["status"], "warn")
        self.assertIn("falls back to observe", c["message"])
        self.assertEqual(len(c["detail"]["invalid"]), 2)

    def test_invalid_numeric_warns_with_fallback(self):
        _scrub_laya_env(self)
        os.environ["LAYA_POLICY_SCREEN_BLOCK"] = "not-a-number"
        c = doctor.check_policy_effective()
        self.assertEqual(c["status"], "warn")
        self.assertIn("LAYA_POLICY_SCREEN_BLOCK", c["message"])
        self.assertIn("v1 default", c["message"])

    def test_valid_overrides_stay_pass(self):
        _scrub_laya_env(self)
        os.environ["LAYA_MODE"] = "shadow"
        os.environ["LAYA_POLICY_SCREEN_BLOCK"] = "0.9"
        c = doctor.check_policy_effective()
        self.assertEqual(c["status"], "pass")
        self.assertEqual(c["detail"]["LAYA_MODE"], "shadow")


class McpTest(unittest.TestCase):
    def test_dist_missing_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(doctor, "INSTALL_DIR", Path(tmp)):
                c = doctor.check_mcp_tools_list(timeout_s=5)
        self.assertEqual(c["status"], "skip")
        self.assertIn("npm run build", c["message"])

    def test_repo_dist_lists_capabilities_offline(self):
        # The repo's own dist (current source) over stdio with the backend
        # down must honestly advertise [laya_capabilities] -- never throw.
        dist = REPO_ROOT / "dist" / "index.js"
        if not dist.exists():
            self.skipTest("dist/index.js not built")
        with mock.patch.object(doctor, "INSTALL_DIR", REPO_ROOT):
            c = doctor.check_mcp_tools_list(timeout_s=30)
        self.assertEqual(c["status"], "pass", c)
        self.assertIn("laya_capabilities", c["detail"]["tools"])
        self.assertTrue(c["detail"]["degraded_backend"])


class BenchmarkTest(unittest.TestCase):
    def test_versioned_fallback_quotes_provenance(self):
        # timeout=0 forces the versioned path deterministically (no live
        # bench can finish in zero seconds).
        c = doctor.check_benchmark(bench_timeout_s=0)
        v1 = REPO_ROOT / "evals" / "results" / "v1"
        if not (v1 / "manifest.json").exists():
            self.skipTest("no versioned results")
        self.assertEqual(c["status"], "pass", c)
        self.assertEqual(c["detail"]["mode"], "versioned")
        manifest = json.loads((v1 / "manifest.json").read_text(encoding="utf-8"))
        bench = json.loads((v1 / "bench.json").read_text(encoding="utf-8"))
        self.assertEqual(c["detail"]["commit"], manifest["commit"])
        self.assertEqual(c["detail"]["primitives"], len(bench["primitives"]))
        self.assertEqual(c["detail"]["rerank_rows"], len(bench["rerank_sweep"]))
        self.assertEqual(c["detail"]["tokenizer"], "unknown")

    def test_missing_results_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(doctor, "_repo_root", lambda: Path(tmp)):
                c = doctor.check_benchmark(bench_timeout_s=0)
        self.assertEqual(c["status"], "skip")
        self.assertIn("bench.mjs --save", c["message"])


class DownloadRevisionTest(unittest.TestCase):
    def _fake_hf(self, calls):
        import types

        fake = types.ModuleType("huggingface_hub")
        fake.snapshot_download = lambda **kw: calls.append(kw) or "/fake/snap"  # noqa: E731
        return fake

    def test_revision_flag_threads_through(self):
        calls = []
        dl = _load("laya_dl_t3a", "py/download_models.py")
        with mock.patch.dict(sys.modules, {"huggingface_hub": self._fake_hf(calls)}):
            with mock.patch.object(sys, "argv", ["download_models.py", "--revision", "abc123"]):
                rc = dl.main()
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["revision"], "abc123")

    def test_absent_revision_is_honest_unpinned(self):
        calls = []
        dl = _load("laya_dl_t3b", "py/download_models.py")
        with mock.patch.dict(sys.modules, {"huggingface_hub": self._fake_hf(calls)}):
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("LAYA_MODEL_REVISION", None)
                with mock.patch.object(sys, "argv", ["download_models.py"]):
                    import io
                    from contextlib import redirect_stdout

                    buf = io.StringIO()
                    with redirect_stdout(buf):
                        rc = dl.main()
        self.assertEqual(rc, 0)
        self.assertIsNone(calls[0]["revision"])
        self.assertIn("revision=unpinned", buf.getvalue())


class RunDoctorFlagsTest(unittest.TestCase):
    def test_all_new_flags_offline_no_throw(self):
        _scrub_laya_env(self)
        with mock.patch.object(doctor, "INSTALL_DIR", REPO_ROOT):
            report = doctor.run_doctor(
                laya_host="127.0.0.1",
                laya_port=1,  # refused: exercises the down-paths
                include_live_calls=False,
                include_models=True,
                include_policy=True,
                include_mcp=True,
                include_benchmark=True,
                mcp_timeout_s=30,
                bench_timeout_s=1,
            )
        names = [c["name"] for c in report["checks"]]
        for want in ("models-inventory", "policy-effective", "mcp-tools-list", "benchmark"):
            self.assertIn(want, names)
        for c in report["checks"]:
            self.assertIn(c["status"], ("pass", "warn", "fail", "skip"))

    def test_help_documents_new_flags(self):
        proc = subprocess.run(
            [sys.executable, str(REPO_ROOT / "py" / "doctor.py"), "--help"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0)
        for flag in ("--models", "--policy", "--mcp", "--benchmark", "--bench-timeout-s", "--mcp-timeout-s"):
            self.assertIn(flag, proc.stdout)


if __name__ == "__main__":
    unittest.main()
