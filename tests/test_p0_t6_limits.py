"""Real-behavior tests for T6 (configurable input limits + structured errors).

No heavy models, no GPU, no network, no `pip install laya`: the Laya
`Router` and GLiNER `AutoExtractor` constructors are faked at the import
level (same technique as tests/test_p0_t4t5_robustness.py). Everything else
-- the real pydantic validators, the real _InputTooLarge -> 413 handler,
the real FastAPI routes -- is production code, driven over HTTP via
fastapi TestClient.

Each limit is probed just-under (passes validation, reaches the fake model
-> 200) and just-over (413 with the structured body
{code, field, limit, actual, hint}). Over-limit requests must NOT touch the
model constructor: validation runs before load.

Run from the repo root:
    python -m unittest tests.test_p0_t6_limits -v
"""
import importlib.util
import os
import sys
import types
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load(name, relpath):
    spec = importlib.util.spec_from_file_location(name, REPO_ROOT / relpath)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


laya_server = _load("t6_laya_server", "py/laya_server.py")
gliner_server = _load("t6_gliner_server", "py/gliner_server.py")

from fastapi.testclient import TestClient  # noqa: E402


# -- fakes (accept everything; limits are what is under test) -----------------


class FakeLayaRouter:
    calls = 0

    def __init__(self, **kwargs):
        type(self).calls += 1
        self.loaded = ["english"]

    def predict(self, state, questions, **kwargs):
        return {"answers": {}, "confidence": {}, "routing": {}, "usage": {}}


class FakeExtractor:
    calls = 0

    @classmethod
    def from_pretrained(cls, *args, **kwargs):
        cls.calls += 1
        return cls()

    def extract_entities(self, text, labels, include_confidence=True, include_spans=True):
        return {"entities": {}}

    def classify_text(self, text, tasks):
        return {}


def _install_fakes():
    laya_mod = types.ModuleType("laya")
    laya_mod.Router = FakeLayaRouter
    gliner_mod = types.ModuleType("gliner2")
    gliner_mod.AutoExtractor = FakeExtractor
    old_laya = sys.modules.get("laya")
    old_gliner = sys.modules.get("gliner2")
    sys.modules["laya"] = laya_mod
    sys.modules["gliner2"] = gliner_mod
    return old_laya, old_gliner


# Small limits so payloads stay tiny; the point is the boundary, not scale.
LAYA_ENV = {
    "LAYA_LIMITS_MAX_STATE_CHARS": "100",
    "LAYA_LIMITS_MAX_QUESTIONS": "4",
    "LAYA_LIMITS_MAX_BODY_CHARS": "1000",
}
GLINER_ENV = {
    "GLINER_LIMITS_MAX_TEXT_CHARS": "100",
    "GLINER_LIMITS_MAX_LABELS": "3",
    "GLINER_LIMITS_MAX_TASKS": "2",
    "GLINER_LIMITS_MAX_EXTRA_TYPES": "2",
    "GLINER_LIMITS_MAX_BODY_CHARS": "1000",
}


class _Env:
    def __init__(self, overrides):
        self.overrides = overrides
        self.saved = {}

    def __enter__(self):
        for k, v in self.overrides.items():
            self.saved[k] = os.environ.get(k)
            os.environ[k] = v
        return self

    def __exit__(self, *exc):
        for k, old in self.saved.items():
            if old is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = old


class T6Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._old_mods = _install_fakes()

    @classmethod
    def tearDownClass(cls):
        old_laya, old_gliner = cls._old_mods
        if old_laya is None:
            sys.modules.pop("laya", None)
        else:
            sys.modules["laya"] = old_laya
        if old_gliner is None:
            sys.modules.pop("gliner2", None)
        else:
            sys.modules["gliner2"] = old_gliner

    def setUp(self):
        self._env = _Env({**LAYA_ENV, **GLINER_ENV})
        self._env.__enter__()
        FakeLayaRouter.calls = 0
        FakeExtractor.calls = 0
        self._old_router = laya_server.router
        self._old_holder = gliner_server.holder
        laya_server.router = laya_server._RouterHolder()
        gliner_server.holder = gliner_server._ExtractorHolder()
        self.laya = TestClient(laya_server.app)
        self.gliner = TestClient(gliner_server.app)

    def tearDown(self):
        laya_server.router = self._old_router
        gliner_server.holder = self._old_holder
        self._env.__exit__(None, None, None)

    def assertTooLarge(self, response, field, limit, actual):
        self.assertEqual(response.status_code, 413, response.text)
        body = response.json()
        self.assertEqual(body["code"], "input_too_large")
        self.assertEqual(body["field"], field)
        self.assertEqual(body["limit"], limit)
        self.assertEqual(body["actual"], actual)
        self.assertTrue(body["hint"], "hint must guide the caller to shrink the payload")


class TestT6LayaPredictLimits(T6Base):
    def test_state_just_under_passes_just_over_413s(self):
        r = self.laya.post("/predict", json={"state": "x" * 100, "questions": {"q1": {}}})
        self.assertEqual(r.status_code, 200, r.text)
        before = FakeLayaRouter.calls
        r = self.laya.post("/predict", json={"state": "x" * 101, "questions": {"q1": {}}})
        self.assertTooLarge(r, "state", 100, 101)
        self.assertIn("LAYA_LIMITS_MAX_STATE_CHARS", r.json()["hint"])
        # Validation runs BEFORE load: the constructor was never touched.
        self.assertEqual(FakeLayaRouter.calls, before)

    def test_structured_state_measured_as_json(self):
        ok_state = {"k": "x" * 90}  # json ~98 chars: under 100
        r = self.laya.post("/predict", json={"state": ok_state, "questions": {}})
        self.assertEqual(r.status_code, 200, r.text)
        big_state = {"k": "x" * 95}  # json ~103 chars: over 100
        r = self.laya.post("/predict", json={"state": big_state, "questions": {}})
        self.assertEqual(r.status_code, 413, r.text)
        self.assertEqual(r.json()["field"], "state")

    def test_questions_just_under_passes_just_over_413s(self):
        r = self.laya.post(
            "/predict",
            json={"state": "s", "questions": {f"q{i}": {} for i in range(4)}},
        )
        self.assertEqual(r.status_code, 200, r.text)
        r = self.laya.post(
            "/predict",
            json={"state": "s", "questions": {f"q{i}": {} for i in range(5)}},
        )
        self.assertTooLarge(r, "questions", 4, 5)
        self.assertIn("LAYA_LIMITS_MAX_QUESTIONS", r.json()["hint"])

    def test_body_total_413s_when_parts_are_individually_fine(self):
        # state (100) and question count (4) each pass; the JSON total (~1400)
        # exceeds the 1000-char body guard.
        questions = {f"q{i}": {"criteria": "y" * 300} for i in range(4)}
        r = self.laya.post("/predict", json={"state": "x" * 100, "questions": questions})
        self.assertEqual(r.status_code, 413, r.text)
        body = r.json()
        self.assertEqual(body["field"], "body")
        self.assertEqual(body["limit"], 1000)
        self.assertGreater(body["actual"], 1000)
        self.assertIn("LAYA_LIMITS_MAX_BODY_CHARS", body["hint"])

    def test_limits_configurable_via_env(self):
        # The same 100-char state that passed above now fails when the env
        # override shrinks the cap: no module reload involved.
        os.environ["LAYA_LIMITS_MAX_STATE_CHARS"] = "10"
        r = self.laya.post("/predict", json={"state": "x" * 100, "questions": {}})
        self.assertTooLarge(r, "state", 10, 100)


class TestT6GlinerLimits(T6Base):
    def test_extract_text_boundary(self):
        r = self.gliner.post("/extract_entities", json={"text": "t" * 100, "labels": ["a"]})
        self.assertEqual(r.status_code, 200, r.text)
        before = FakeExtractor.calls
        r = self.gliner.post("/extract_entities", json={"text": "t" * 101, "labels": ["a"]})
        self.assertTooLarge(r, "text", 100, 101)
        self.assertIn("GLINER_LIMITS_MAX_TEXT_CHARS", r.json()["hint"])
        self.assertEqual(FakeExtractor.calls, before)

    def test_extract_labels_list_and_map_boundaries(self):
        r = self.gliner.post("/extract_entities", json={"text": "t", "labels": ["a", "b", "c"]})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.gliner.post(
            "/extract_entities", json={"text": "t", "labels": ["a", "b", "c", "d"]}
        )
        self.assertTooLarge(r, "labels", 3, 4)
        # {name: description} maps count by keys too.
        r = self.gliner.post(
            "/extract_entities",
            json={"text": "t", "labels": {"a": "A", "b": "B", "c": "C", "d": "D"}},
        )
        self.assertTooLarge(r, "labels", 3, 4)

    def test_classify_tasks_boundary(self):
        r = self.gliner.post("/classify", json={"text": "t", "tasks": {"a": 1, "b": 2}})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.gliner.post("/classify", json={"text": "t", "tasks": {"a": 1, "b": 2, "c": 3}})
        self.assertTooLarge(r, "tasks", 2, 3)
        self.assertIn("GLINER_LIMITS_MAX_TASKS", r.json()["hint"])

    def test_pii_extra_types_boundary(self):
        r = self.gliner.post("/pii_scan", json={"text": "t", "extra_types": ["a", "b"]})
        self.assertEqual(r.status_code, 200, r.text)
        r = self.gliner.post("/pii_scan", json={"text": "t", "extra_types": ["a", "b", "c"]})
        self.assertTooLarge(r, "extra_types", 2, 3)

    def test_gliner_body_total_413s(self):
        # text (100) and label count (2) each pass; long label strings push
        # the JSON total over the 1000-char body guard.
        r = self.gliner.post(
            "/extract_entities", json={"text": "t" * 100, "labels": ["a" * 500, "b" * 500]}
        )
        self.assertEqual(r.status_code, 413, r.text)
        self.assertEqual(r.json()["field"], "body")
        self.assertIn("GLINER_LIMITS_MAX_BODY_CHARS", r.json()["hint"])

    def test_gliner_limits_configurable_via_env(self):
        os.environ["GLINER_LIMITS_MAX_LABELS"] = "1"
        r = self.gliner.post("/extract_entities", json={"text": "t", "labels": ["a", "b"]})
        self.assertTooLarge(r, "labels", 1, 2)


if __name__ == "__main__":
    unittest.main()
