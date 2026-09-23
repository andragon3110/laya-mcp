"""Real-behavior tests for T4 (load retry/backoff/circuit/reload) + T5 (concurrency).

No heavy models, no GPU, no network, no `pip install laya`: the Laya
`Router` and GLiNER `AutoExtractor` constructors are faked at the import
level (sys.modules patching -- the servers import them lazily inside
_do_load, so fakes slot in exactly where the real SDK would). Everything
else -- holders, backoff gate, circuit, locks, semaphore, FastAPI routes,
503 bodies/headers -- is the real production code, driven over HTTP via
fastapi TestClient.

Run from the repo root:
    python -m unittest tests.test_p0_t4t5_robustness -v
"""
import importlib.util
import os
import sys
import threading
import time
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


laya_server = _load("t4t5_laya_server", "py/laya_server.py")
gliner_server = _load("t4t5_gliner_server", "py/gliner_server.py")

from fastapi.testclient import TestClient  # noqa: E402


# -- fakes -------------------------------------------------------------------

class FakeLayaRouter:
    """Stands in for laya.Router. Behaviour is scripted per test."""

    outcomes = None  # list: Exception instance to raise, or "ok"
    calls = 0
    predict_calls = 0
    gate = None  # optional threading.Event predict() waits on

    def __init__(self, **kwargs):
        type(self).calls += 1
        outcome = type(self).outcomes[type(self).calls - 1] if type(self).outcomes else "ok"
        if isinstance(outcome, BaseException):
            raise outcome
        self.loaded = ["english"]

    def predict(self, state, questions, **kwargs):
        type(self).predict_calls += 1
        if type(self).gate is not None:
            assert type(self).gate.wait(timeout=10), "predict gate never released"
        return {
            "answers": {"q1": {"label": "yes", "confidence": 0.9}},
            "confidence": {},
            "routing": {},
            "usage": {},
        }


class FakeExtractor:
    """Stands in for gliner2.AutoExtractor."""

    outcomes = None
    calls = 0
    extract_calls = 0
    gate = None

    @classmethod
    def from_pretrained(cls, *args, **kwargs):
        cls.calls += 1
        outcome = cls.outcomes[cls.calls - 1] if cls.outcomes else "ok"
        if isinstance(outcome, BaseException):
            raise outcome
        return cls()

    def extract_entities(self, text, labels, include_confidence=True, include_spans=True):
        type(self).extract_calls += 1
        if type(self).gate is not None:
            assert type(self).gate.wait(timeout=10), "extract gate never released"
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


LAYA_ENV = {
    "LAYA_LOAD_RETRY_BASE_S": "0.02",
    "LAYA_LOAD_RETRY_FACTOR": "2.0",
    "LAYA_LOAD_RETRY_CAP_S": "60.0",
    "LAYA_LOAD_RETRY_MAX": "3",
    "LAYA_LOAD_CIRCUIT_THRESHOLD": "2",
    "LAYA_LOAD_CIRCUIT_COOLDOWN_S": "0.25",
    "LAYA_LOAD_ERROR_TTL_S": "300.0",
    "LAYA_MAX_INFLIGHT": "4",
}
GLINER_ENV = {
    "GLINER_LOAD_RETRY_BASE_S": "0.02",
    "GLINER_LOAD_RETRY_FACTOR": "2.0",
    "GLINER_LOAD_RETRY_CAP_S": "60.0",
    "GLINER_LOAD_RETRY_MAX": "3",
    "GLINER_LOAD_CIRCUIT_THRESHOLD": "2",
    "GLINER_LOAD_CIRCUIT_COOLDOWN_S": "0.25",
    "GLINER_LOAD_ERROR_TTL_S": "300.0",
    "GLINER_MAX_INFLIGHT": "4",
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


class T4T5Base(unittest.TestCase):
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
        FakeLayaRouter.predict_calls = 0
        FakeLayaRouter.gate = None
        FakeLayaRouter.outcomes = None
        FakeExtractor.calls = 0
        FakeExtractor.extract_calls = 0
        FakeExtractor.gate = None
        FakeExtractor.outcomes = None
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

    def _predict(self):
        return self.laya.post("/predict", json={"state": "s", "questions": {}})

    def _extract(self):
        return self.gliner.post(
            "/extract_entities", json={"text": "hola Ana", "labels": ["persona"]}
        )


# -- T4: failure tracking / backoff / circuit / reload ------------------------

class TestT4LayaLoadRecovery(T4T5Base):
    def test_fail_twice_then_ok_clears_state(self):
        FakeLayaRouter.outcomes = [RuntimeError("vram"), RuntimeError("vram"), "ok"]
        self.assertEqual(self._predict().status_code, 503)  # attempt 1
        time.sleep(0.08)  # > backoff(~0.02s) after attempt 1
        self.assertEqual(self._predict().status_code, 503)  # attempt 2
        time.sleep(0.15)  # > backoff(~0.04s) after attempt 2
        r = self._predict()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(FakeLayaRouter.calls, 3)
        ready = self.laya.get("/ready")
        self.assertEqual(ready.status_code, 200)
        body = ready.json()
        self.assertEqual(body["circuit"], "closed")
        self.assertEqual(body["load_attempts"], 0)  # cleared after success
        self.assertTrue(body["ready"])

    def test_fail_always_attempts_eq_max_then_failfast(self):
        FakeLayaRouter.outcomes = [RuntimeError("boom")] * 10
        t0 = time.time()
        for i in range(3):
            self.assertEqual(self._predict().status_code, 503)
            time.sleep(0.08 if i == 0 else 0.15)
        # Budget (MAX=3) exhausted with exactly 3 constructor calls.
        self.assertEqual(FakeLayaRouter.calls, 3)
        # Immediate retry: fail-fast WITHOUT touching the constructor.
        r = self._predict()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(FakeLayaRouter.calls, 3)
        self.assertIn("retry-after", r.headers)
        # Bounded time: three tiny backoffs, no aggressive loop.
        self.assertLess(time.time() - t0, 10)
        ready = self.laya.get("/ready")
        self.assertEqual(ready.status_code, 503)
        body = ready.json()
        self.assertEqual(body["circuit"], "open")  # threshold=2 <= 3 fails
        self.assertEqual(body["load_attempts"], 3)
        self.assertGreater(body["retry_after_seconds"], 0)
        self.assertIn("retry-after", ready.headers)
        # /live is unaffected by load failure: always 200.
        live = self.laya.get("/live")
        self.assertEqual(live.status_code, 200)
        self.assertTrue(live.json()["alive"])
        # /models stays 200 and exposes the circuit.
        models = self.laya.get("/models")
        self.assertEqual(models.status_code, 200)
        self.assertEqual(models.json()["circuit"], "open")

    def test_half_open_probe_after_cooldown(self):
        FakeLayaRouter.outcomes = [RuntimeError("boom")] * 10
        for i in range(3):
            self._predict()
            time.sleep(0.08 if i == 0 else 0.15)
        self.assertEqual(FakeLayaRouter.calls, 3)
        self._predict()  # immediate: fail-fast, still 3
        self.assertEqual(FakeLayaRouter.calls, 3)
        time.sleep(0.35)  # > cooldown 0.25: half-open probe may pass
        r = self._predict()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(FakeLayaRouter.calls, 4)  # probe attempted once

    def test_error_ttl_expiry_allows_fresh_attempt(self):
        os.environ["LAYA_LOAD_RETRY_BASE_S"] = "10"  # long backoff: no retry w/o TTL
        os.environ["LAYA_LOAD_ERROR_TTL_S"] = "0.25"
        FakeLayaRouter.outcomes = [RuntimeError("blip")] * 10
        self.assertEqual(self._predict().status_code, 503)
        self.assertEqual(FakeLayaRouter.calls, 1)
        self.assertEqual(self._predict().status_code, 503)  # fail-fast
        self.assertEqual(FakeLayaRouter.calls, 1)
        time.sleep(0.35)  # > TTL: cached error expires, fresh attempt
        self.assertEqual(self._predict().status_code, 503)
        self.assertEqual(FakeLayaRouter.calls, 2)
        body = self.laya.get("/ready").json()
        self.assertEqual(body["load_attempts"], 1)  # counter restarted, not poisoned

    def test_reload_clears_state_and_retries(self):
        os.environ["LAYA_LOAD_RETRY_BASE_S"] = "10"  # immediate retry would fail-fast
        FakeLayaRouter.outcomes = [RuntimeError("boom"), "ok"]
        self.assertEqual(self._predict().status_code, 503)
        self.assertEqual(FakeLayaRouter.calls, 1)
        r = self.laya.post("/reload")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["status"], "reloaded")
        self.assertTrue(body["cleared_error"])
        self.assertEqual(body["cleared_attempts"], 1)
        self.assertEqual(body["circuit"], "closed")
        # Next use retries immediately instead of waiting out the backoff.
        self.assertEqual(self._predict().status_code, 200)
        self.assertEqual(FakeLayaRouter.calls, 2)
        self.assertEqual(self.laya.get("/ready").json()["circuit"], "closed")

    def test_success_ready_and_models_circuit_closed(self):
        FakeLayaRouter.outcomes = ["ok"]
        self.assertEqual(self._predict().status_code, 200)
        ready = self.laya.get("/ready").json()
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["circuit"], "closed")
        models = self.laya.get("/models").json()
        self.assertEqual(models["circuit"], "closed")
        self.assertEqual(models["models"][0]["circuit"], "closed")


class TestT4GlinerLoadRecovery(T4T5Base):
    def test_fail_twice_then_ok_clears_state(self):
        FakeExtractor.outcomes = [RuntimeError("vram"), RuntimeError("vram"), "ok"]
        self.assertEqual(self._extract().status_code, 503)
        time.sleep(0.08)
        self.assertEqual(self._extract().status_code, 503)
        time.sleep(0.15)
        r = self._extract()
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(FakeExtractor.calls, 3)
        body = self.gliner.get("/ready").json()
        self.assertTrue(body["ready"])
        self.assertEqual(body["circuit"], "closed")
        self.assertEqual(body["load_attempts"], 0)

    def test_fail_always_opens_circuit_live_stays_200(self):
        FakeExtractor.outcomes = [RuntimeError("boom")] * 10
        for i in range(3):
            self.assertEqual(self._extract().status_code, 503)
            time.sleep(0.08 if i == 0 else 0.15)
        self.assertEqual(FakeExtractor.calls, 3)
        r = self._extract()
        self.assertEqual(r.status_code, 503)
        self.assertEqual(FakeExtractor.calls, 3)  # fail-fast
        self.assertIn("retry-after", r.headers)
        self.assertEqual(self.gliner.get("/ready").json()["circuit"], "open")
        self.assertEqual(self.gliner.get("/live").status_code, 200)
        self.assertEqual(self.gliner.get("/models").json()["circuit"], "open")

    def test_reload_clears_state_and_retries(self):
        os.environ["GLINER_LOAD_RETRY_BASE_S"] = "10"
        FakeExtractor.outcomes = [RuntimeError("boom"), "ok"]
        self.assertEqual(self._extract().status_code, 503)
        r = self.gliner.post("/reload")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()["cleared_error"])
        self.assertEqual(self._extract().status_code, 200)
        self.assertEqual(FakeExtractor.calls, 2)


class TestProcessIndependence(T4T5Base):
    def test_gliner_failure_does_not_affect_laya_and_vice_versa(self):
        # Both backends fail permanently: each process still answers liveness
        # and reports its own (independent) readiness. No shared state exists
        # between the two holders by construction (separate apps/ports).
        FakeLayaRouter.outcomes = [RuntimeError("laya-down")] * 5
        FakeExtractor.outcomes = [RuntimeError("gliner-down")] * 5
        self._predict()
        self._extract()
        self.assertEqual(self.laya.get("/live").status_code, 200)
        self.assertEqual(self.gliner.get("/live").status_code, 200)
        self.assertEqual(self.laya.get("/ready").status_code, 503)
        self.assertEqual(self.gliner.get("/ready").status_code, 503)
        self.assertIn("laya-down", self.laya.get("/ready").json()["reason"])
        self.assertIn("gliner-down", self.gliner.get("/ready").json()["reason"])


# -- T5: single-flight + bounded inference ------------------------------------

class TestT5SingleFlight(T4T5Base):
    def _run_threads(self, fn, n=10):
        errors = []
        results = [None] * n

        def target(i):
            try:
                results[i] = fn()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=target, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)
        self.assertEqual(errors, [])
        return results

    def test_laya_singleflight_10_threads_one_construction(self):
        FakeLayaRouter.outcomes = ["ok"] * 20
        orig = FakeLayaRouter.__init__

        def slow_init(self, **kwargs):
            time.sleep(0.15)  # widen the race window: all 10 threads pile in
            orig(self, **kwargs)

        FakeLayaRouter.__init__ = slow_init
        try:
            holder = laya_server._RouterHolder()
            results = self._run_threads(holder._ensure)
        finally:
            FakeLayaRouter.__init__ = orig
        self.assertEqual(FakeLayaRouter.calls, 1)
        self.assertTrue(all(r is results[0] for r in results))

    def test_gliner_singleflight_10_threads_one_construction(self):
        FakeExtractor.outcomes = ["ok"] * 20
        orig = FakeExtractor.from_pretrained

        @classmethod
        def slow_load(cls, *args, **kwargs):
            time.sleep(0.15)
            return orig(*args, **kwargs)

        FakeExtractor.from_pretrained = slow_load
        try:
            holder = gliner_server._ExtractorHolder()
            results = self._run_threads(holder._ensure)
        finally:
            FakeExtractor.from_pretrained = orig
        self.assertEqual(FakeExtractor.calls, 1)
        self.assertTrue(all(r is results[0] for r in results))


class TestT5InflightBound(T4T5Base):
    def test_laya_saturation_503_with_retry_after(self):
        os.environ["LAYA_MAX_INFLIGHT"] = "1"
        FakeLayaRouter.outcomes = ["ok"] * 5
        FakeLayaRouter.gate = threading.Event()
        holder = laya_server.router
        out = {}

        def occupier():
            out["status"] = self._predict().status_code

        t = threading.Thread(target=occupier)
        t.start()
        deadline = time.time() + 10
        while holder._inflight is None or not holder._inflight.locked():
            self.assertLess(time.time(), deadline, "inflight slot never occupied")
            time.sleep(0.01)
        # Saturated: immediate structured 503 + Retry-After, no queueing.
        r = self._predict()
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.headers.get("retry-after"), "1")
        body = r.json()
        self.assertEqual(body["code"], "inflight_saturated")
        self.assertEqual(body["limit"], 1)
        self.assertEqual(FakeLayaRouter.predict_calls, 1)  # no second inference ran
        FakeLayaRouter.gate.set()
        t.join(timeout=15)
        self.assertEqual(out.get("status"), 200)

    def test_gliner_saturation_503_with_retry_after(self):
        os.environ["GLINER_MAX_INFLIGHT"] = "1"
        FakeExtractor.outcomes = ["ok"] * 5
        FakeExtractor.gate = threading.Event()
        holder = gliner_server.holder
        out = {}

        def occupier():
            out["status"] = self._extract().status_code

        t = threading.Thread(target=occupier)
        t.start()
        deadline = time.time() + 10
        while holder._inflight is None or not holder._inflight.locked():
            self.assertLess(time.time(), deadline, "inflight slot never occupied")
            time.sleep(0.01)
        r = self._extract()
        self.assertEqual(r.status_code, 503, r.text)
        self.assertEqual(r.headers.get("retry-after"), "1")
        self.assertEqual(r.json()["code"], "inflight_saturated")
        self.assertEqual(FakeExtractor.extract_calls, 1)
        FakeExtractor.gate.set()
        t.join(timeout=15)
        self.assertEqual(out.get("status"), 200)


if __name__ == "__main__":
    unittest.main()
