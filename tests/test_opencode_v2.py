"""Unit tests for the OpenCode V2 config layer (no network, no models).

Covers:
  - examples/opencode.snippet.json is valid JSON in native V2 shape.
  - doctor.check_optional_agent_configs detects V2, legacy V1, disabled,
    missing-entry and missing-file states, resolving the config path via
    OPENCODE_JSON / OPENCODE_CONFIG_DIR.

Run from the repo root inside any Python venv (stdlib only):
    python -m unittest tests.test_opencode_v2 -v
"""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SNIPPET = REPO_ROOT / "examples" / "opencode.snippet.json"


def _load_doctor():
    spec = importlib.util.spec_from_file_location(
        "laya_doctor", REPO_ROOT / "py" / "doctor.py"
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


doctor = _load_doctor()


def _v2_entry(disabled=False):
    return {
        "mcp": {
            "servers": {
                "laya": {
                    "type": "local",
                    "command": ["node", "/abs/laya-mcp/dist/index.js"],
                    "environment": {"LAYA_URL": "http://127.0.0.1:8765"},
                    "disabled": disabled,
                }
            }
        }
    }


def _v1_entry(enabled=True):
    return {
        "mcp": {
            "laya": {
                "type": "local",
                "command": ["node", "/abs/laya-mcp/dist/index.js"],
                "enabled": enabled,
            }
        }
    }


class SnippetTest(unittest.TestCase):
    def test_snippet_is_native_v2(self):
        data = json.loads(SNIPPET.read_text(encoding="utf-8"))
        laya = data["mcp"]["servers"]["laya"]
        self.assertEqual(laya["type"], "local")
        self.assertIsInstance(laya["command"], list)
        self.assertIn("disabled", laya)
        # No legacy V1 leftovers.
        self.assertNotIn("enabled", laya)
        self.assertNotIn("laya", data["mcp"].get("servers", {}).get("servers", {}))
        self.assertNotIn("$HOME", json.dumps(laya))


class DoctorConfigTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old_json = os.environ.pop("OPENCODE_JSON", None)
        self.old_dir = os.environ.pop("OPENCODE_CONFIG_DIR", None)
        self.addCleanup(self._restore_env)

    def _restore_env(self):
        for key, val in (("OPENCODE_JSON", self.old_json), ("OPENCODE_CONFIG_DIR", self.old_dir)):
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val

    def _cfg(self, data):
        p = Path(self.tmp.name) / "opencode.json"
        p.write_text(json.dumps(data), encoding="utf-8")
        os.environ["OPENCODE_JSON"] = str(p)
        return p

    def _statuses(self):
        return [c["status"] for c in doctor.check_optional_agent_configs()]

    def test_v2_registered_pass(self):
        self._cfg(_v2_entry())
        out = doctor.check_optional_agent_configs()
        self.assertEqual([c["status"] for c in out], ["pass"])
        self.assertIn("mcp.servers.laya", out[0]["message"])

    def test_v2_disabled_warn(self):
        self._cfg(_v2_entry(disabled=True))
        self.assertEqual(self._statuses(), ["warn"])

    def test_v1_legacy_registered_pass(self):
        self._cfg(_v1_entry(enabled=True))
        out = doctor.check_optional_agent_configs()
        self.assertEqual([c["status"] for c in out], ["pass"])
        self.assertIn("legacy", out[0]["message"])

    def test_v1_legacy_disabled_warn(self):
        self._cfg(_v1_entry(enabled=False))
        self.assertEqual(self._statuses(), ["warn"])

    def test_missing_entry_skip(self):
        self._cfg({"mcp": {"servers": {}}})
        self.assertEqual(self._statuses(), ["skip"])

    def test_missing_file_skip(self):
        os.environ["OPENCODE_JSON"] = str(Path(self.tmp.name) / "nope.json")
        self.assertEqual(self._statuses(), ["skip"])

    def test_config_dir_resolution(self):
        cfg_dir = Path(self.tmp.name) / "cfgdir"
        cfg_dir.mkdir()
        (cfg_dir / "opencode.json").write_text(json.dumps(_v2_entry()), encoding="utf-8")
        os.environ["OPENCODE_CONFIG_DIR"] = str(cfg_dir)
        self.assertEqual(self._statuses(), ["pass"])


if __name__ == "__main__":
    sys.exit(not unittest.main(verbosity=2).result.wasSuccessful())
