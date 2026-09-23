"""Real-behavior gap-closure tests for T7 (coverage of list §5).

Covers ONLY what tests/test_p0_t4t5_robustness.py (14/14) and
tests/test_p0_t6_limits.py (11/11) demonstrably do not assert
(verified by grep before writing — see mapping in each docstring):

  T7a readiness-after-load shape: /ready 200 + loaded non-empty +
      per-checkpoint failed list (partial checkpoint success does not
      block the process) + /models per-checkpoint loaded flags.
      (T4 asserts ready-200-after-recovery but never the loaded/failed
      shape; T4 gliner recovery never asserts ready status 200 at all.)
  T7b no duplicate loading: a second successful inference reuses the
      loaded backend (constructor calls stay 1 on both servers).
      (T4/T5 never assert constructor-call stability across inferences.)
  T7c inference-time model failure (backend loaded, forward pass raises):
      RuntimeError -> structured 503 + Retry-After without poisoning the
      holder (next ok call is 200, no rebuild); unexpected error -> 500.
      (T4 only fails the CONSTRUCTOR; no test touches the 500 path.)
  T7d mixed concurrent inference: laya + gliner inferring at the same
      time all answer 200 with exact call counts (no cross-talk).
      (T4 independence test is sequential and failure-only; T5
      saturation is per-server.)

Already covered — cited, NOT duplicated here:
  - liveness with backend down (/live 200 both servers): T4
    test_fail_always_attempts_eq_max_then_failfast /
    test_fail_always_opens_circuit_live_stays_200.
  - recovery after error-TTL expiry WITHOUT /reload: T4
    test_error_ttl_expiry_allows_fresh_attempt.
  - body-total guard firing while per-field parts pass: T6
    test_body_total_413s_when_parts_are_individually_fine /
    test_gliner_body_total_413s.

Same technique as T4/T5/T6: fake `laya.Router` / `gliner2.AutoExtractor`
constructors at the import level; everything else is production code
driven over HTTP via fastapi TestClient. No heavy models, no GPU, no
network, no `pip install laya`.

Run from the repo root:
    python -m unittest tests.test_p0_t7_gaps -v
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


laya_server = _load("t7_laya_server", "py/laya_server.py")
gliner_server = _load("t7_gliner_server", "py/gliner_server.py")

from fastapi.testclient import TestClient  # noqa: E402


# -- fakes -------------------------------------------------------------------


class FakeLayaRouter:
    calls = 0
    predict_calls = 0
    predict_exc = None  # when set, predict() raises it (inference failure)

    def __init__(self, **kwargs):
        type(self).calls += 1
        # Partial checkpoint load by construction: only `english` is up.
        # This is the "success partiel" shape snapshot() must report
        # without blocking the process.
        self.loaded = ["english"]

    def predict(self, state, questions, **kwargs):
        type(self).predict_calls += 1
        if type(self).predict_exc is not None:
            raise type(self).predict_exc
        return {
            "answers": {"q1": {"label": "yes", "confidence": 0.9}},
            "confidence": {},
            "routing": {},
            "usage": {},
        }


class FakeExtractor:
    calls = 0
    extract_calls = 0
    extract_exc = None

    @classmethod
    def from_pretrained(cls, *args, **kwargs):
        cls.calls += 1
        return cls()

    def extract_entities(self, text, labels, include_confidence=True, include_spans=True):
        type(self).extract_calls += 1
        if type(self).extract_exc is not None:
            raise type(self).extract_exc
        return {"entities": {"persona": [{"text": "Ana", "start": 0, "end": 3, "confidence": 0.9}]}}

    def classify_text(self, text, tasks):
        return {"intent": "ok"}


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


class T7Base(unittest.TestCase):
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
        self._env = _Env({})
        self._env.__enter__()
        FakeLayaRouter.calls = 0
        FakeLayaRouter.predict_calls = 0
        FakeLayaRouter.predict_exc = None
        FakeExtractor.calls = 0
        FakeExtractor.extract_calls = 0
        FakeExtractor.extract_exc = None
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


class TestT7aReadinessAfterLoad(T7Base):
    def test_laya_ready_200_reports_partial_checkpoints(self):
        r = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        self.assertEqual(r.status_code, 200, r.text)
        ready = self.laya.get("/ready")
        self.assertEqual(ready.status_code, 200, ready.text)
        body = ready.json()
        self.assertEqual(body["status"], "ready")
        self.assertTrue(body["ready"])
        # Fake backend loaded only `english`: readiness must say so and
        # list the other checkpoints as failed/not-loaded — the process
        # serves instead of hiding a partial backend.
        self.assertEqual(body["loaded"], ["english"])
        failed_names = {f["name"] for f in body["failed"]}
        self.assertEqual(failed_names, {"multilingual", "typed-decisions"})
        self.assertEqual(body["circuit"], "closed")
        self.assertNotIn("retry-after", ready.headers)

    def test_laya_models_marks_per_checkpoint_loaded_flags(self):
        self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        models = self.gliner.get("/models")  # sanity: other server untouched
        self.assertEqual(models.status_code, 200)
        body = self.laya.get("/models").json()
        self.assertEqual(body["service"], "laya-server")
        flags = {m["name"]: m["loaded"] for m in body["models"]}
        self.assertEqual(flags, {"english": True, "multilingual": False, "typed-decisions": False})
        for m in body["models"]:
            self.assertIsNone(m["revision"])
            self.assertEqual(m["revision_source"], "unpinned")
            self.assertEqual(m["circuit"], "closed")

    def test_gliner_ready_200_reports_loaded_model(self):
        r = self.gliner.post(
            "/extract_entities", json={"text": "hola Ana", "labels": ["persona"]}
        )
        self.assertEqual(r.status_code, 200, r.text)
        ready = self.gliner.get("/ready")
        self.assertEqual(ready.status_code, 200, ready.text)
        body = ready.json()
        self.assertTrue(body["ready"])
        self.assertEqual(len(body["loaded"]), 1)
        self.assertEqual(body["failed"], [])
        self.assertEqual(body["circuit"], "closed")
        self.assertNotIn("retry-after", ready.headers)
        models = self.gliner.get("/models").json()
        self.assertTrue(models["models"][0]["loaded"])


class TestT7bNoDuplicateLoading(T7Base):
    def test_second_inference_reuses_loaded_backend(self):
        for _ in range(2):
            r = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(FakeLayaRouter.calls, 1)
        self.assertEqual(FakeLayaRouter.predict_calls, 2)
        for _ in range(2):
            r = self.gliner.post(
                "/extract_entities", json={"text": "hola Ana", "labels": ["persona"]}
            )
            self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(FakeExtractor.calls, 1)
        self.assertEqual(FakeExtractor.extract_calls, 2)


class TestT7cInferenceTimeModelFailure(T7Base):
    def test_laya_runtime_error_503_then_recovers_without_rebuild(self):
        ok = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        self.assertEqual(ok.status_code, 200, ok.text)
        FakeLayaRouter.predict_exc = RuntimeError("vram flake mid-forward")
        r = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        self.assertEqual(r.status_code, 503, r.text)
        self.assertIn("retry-after", r.headers)
        # An inference failure must not poison the holder: the backend is
        # still loaded, the constructor is not retried, the next ok call
        # succeeds.
        FakeLayaRouter.predict_exc = None
        r = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(FakeLayaRouter.calls, 1)

    def test_gliner_runtime_error_503_with_retry_after(self):
        ok = self.gliner.post(
            "/extract_entities", json={"text": "hola Ana", "labels": ["persona"]}
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        FakeExtractor.extract_exc = RuntimeError("extractor flake")
        r = self.gliner.post(
            "/extract_entities", json={"text": "hola Ana", "labels": ["persona"]}
        )
        self.assertEqual(r.status_code, 503, r.text)
        self.assertIn("retry-after", r.headers)
        self.assertEqual(FakeExtractor.calls, 1)

    def test_unexpected_inference_error_is_structured_500(self):
        ok = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        self.assertEqual(ok.status_code, 200, ok.text)
        FakeLayaRouter.predict_exc = ValueError("bad tensor shape")
        r = self.laya.post("/predict", json={"state": "s", "questions": {"q1": {}}})
        self.assertEqual(r.status_code, 500, r.text)
        self.assertIn("prediction error", r.json()["detail"])


class TestT7dMixedConcurrentInference(T7Base):
    def test_laya_and_gliner_infer_concurrently_all_200(self):
        # Headroom above the worker count so the inflight bound (covered
        # by T5) cannot turn this into saturation 503s: what is under
        # test here is cross-server concurrency, not the bound.
        os.environ["LAYA_MAX_INFLIGHT"] = "8"
        os.environ["GLINER_MAX_INFLIGHT"] = "8"
        # ONE event loop via httpx ASGI transport + asyncio.gather. Thread
        # + TestClient concurrency was tried first and hangs deterministically:
        # each TestClient owns its own portal/loop while the holders cache
        # ONE asyncio.Lock/Semaphore documented as single-loop-only — a
        # second loop blocking on them deadlocks. Production likewise runs
        # one loop (uvicorn), so single-loop gather is the faithful shape.
        import asyncio

        import httpx

        async def run():
            ltransport = httpx.ASGITransport(app=laya_server.app)
            gtransport = httpx.ASGITransport(app=gliner_server.app)
            async with (
                httpx.AsyncClient(transport=ltransport, base_url="http://t") as lc,
                httpx.AsyncClient(transport=gtransport, base_url="http://t") as gc,
            ):

                async def lp():
                    return await lc.post(
                        "/predict", json={"state": "s", "questions": {"q1": {}}}
                    )

                async def gp():
                    return await gc.post(
                        "/extract_entities",
                        json={"text": "hola Ana", "labels": ["persona"]},
                    )

                return await asyncio.gather(
                    *[lp() for _ in range(4)], *[gp() for _ in range(4)]
                )

        results = asyncio.run(run())
        self.assertEqual(len(results), 8)
        self.assertTrue(
            all(r.status_code == 200 for r in results),
            [r.status_code for r in results],
        )
        self.assertEqual(FakeLayaRouter.predict_calls, 4)
        self.assertEqual(FakeExtractor.extract_calls, 4)


if __name__ == "__main__":
    unittest.main()
