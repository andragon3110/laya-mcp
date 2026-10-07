/**
 * Harness-spike-ready T4: pluggable live-backend adapter for score/bench.
 *
 * SCOPE (T4 only): resolve + probe a real backend (`laya-server` at
 * LAYA_URL plus the GLiNER sidecar at GLINER_URL) BEHIND AN EXPLICIT
 * OPT-IN, and adapt it to the `deps` shape the T3 suites already consume
 * (`fakeClient` factory + `makePiiCtx`). No weights, no model downloads,
 * no GLiNER2.5/Qwen3 integration (that is a later feature); this module
 * only moves judge calls from the oracle stub to a reachable backend.
 *
 * DEFAULT IS STUB: nothing here activates unless the caller passes the
 * explicit `--live` CLI flag or sets `LAYA_EVAL_LIVE=1` (truthy: 1/true/
 * yes/on, case-insensitive). There is no auto-detection, no fallback, and
 * no silent switch: without the opt-in every caller gets the stub path
 * exactly as before. With the opt-in but WITHOUT a reachable backend the
 * resolvers below report `reachable: false` and the CLIs exit 2 with the
 * probe table -- they NEVER silently fall back to the stub inside a live
 * run (a silent fallback would launder stub numbers as backend numbers).
 *
 * HONESTY (same vocabulary as src/evidence.ts + src/envelope.ts):
 * - `model_revision` is the operator pin (`LAYA_MODEL_REVISION`, blank
 *   counts as unset) else the first backend-reported non-null model
 *   revision, else the honest null with `revision_source: "unpinned"`.
 *   A hash is never invented.
 * - `tokenizer` is always the explicit string "unknown": no tool and no
 *   probe in `laya_capabilities` exposes a tokenizer (models carry
 *   name/repo/loaded/revision/device/circuit only).
 * - `device` is the live-probed `/ready` device, else the explicit
 *   string "unknown (live backend did not report a device)".
 * - Live golds stay the stub oracles (T5 owns the independent corpus):
 *   mismatches under `--live` measure backend-vs-oracle divergence, never
 *   backend quality. Expected, documented, not a failure of the adapter.
 *
 * Run from the repo root (no CLI here; score.mjs/bench.mjs own the flags):
 *   node --input-type=module -e "import('./evals/live-client.mjs').then(...)"
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");

export const LIVE_CLIENT_DEFAULTS = {
  /** CLI flag enabling the live backend. No flag, no live -- ever. */
  flag: "--live",
  /** Env equivalent of the flag (truthy: 1/true/yes/on, case-insensitive). */
  env: "LAYA_EVAL_LIVE",
  /** Backend base URL env + default (same default as src/client.ts). */
  urlEnv: "LAYA_URL",
  defaultUrl: "http://127.0.0.1:8765",
  /** GLiNER sidecar base URL env + default (same default as src/gliner.ts). */
  glinerUrlEnv: "GLINER_URL",
  glinerDefaultUrl: "http://127.0.0.1:8766",
  /** Operator revision pins (same names as src/evidence.ts). */
  revisionEnv: "LAYA_MODEL_REVISION",
  glinerRevisionEnv: "GLINER_MODEL_REVISION",
  /** Per-probe budget for the live /ready + /models calls (ms). */
  probeTimeoutMs: 1500,
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * Opt-in gate for the live backend. Pure function of argv/env so it is
 * testable without process globals; the CLIs pass the real ones. Never
 * true by default: only the explicit flag or a truthy env enables live.
 */
export function isLiveEnabled(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes(LIVE_CLIENT_DEFAULTS.flag)) return true;
  return TRUTHY.has(String(env[LIVE_CLIENT_DEFAULTS.env] ?? "").toLowerCase());
}

/** Base URL resolution (verbatim env or the src/ default; slash-trimmed). */
export function resolveLiveBaseUrl(env = process.env) {
  const raw = env[LIVE_CLIENT_DEFAULTS.urlEnv] ?? LIVE_CLIENT_DEFAULTS.defaultUrl;
  return String(raw).replace(/\/$/, "");
}

/** Sidecar base URL resolution (verbatim env or the src/ default). */
export function resolveLiveGlinerUrl(env = process.env) {
  const raw = env[LIVE_CLIENT_DEFAULTS.glinerUrlEnv] ?? LIVE_CLIENT_DEFAULTS.glinerDefaultUrl;
  return String(raw).replace(/\/$/, "");
}

/**
 * One JSON GET with a timeout. Returns { ok, status, body } and never
 * throws: unreachable/timeout/invalid-JSON all surface as ok:false with a
 * short reason (the CLIs print it; nothing is retried, nothing invented).
 */
export async function probeJson(url, { timeoutMs = LIVE_CLIENT_DEFAULTS.probeTimeoutMs, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok || res.status === 503, status: res.status, body };
  } catch (err) {
    return { ok: false, status: null, body: {}, error: err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the revision pin in the src/evidence.ts vocabulary. Operator env
 * pin wins (blank counts as unset), else the first non-null backend model
 * revision, else the honest null. Returns { revision, revision_source }.
 */
export function resolveLiveRevision({ env = process.env, models = [] } = {}) {
  const pinned = String(env[LIVE_CLIENT_DEFAULTS.revisionEnv] ?? "").trim();
  if (pinned !== "") return { revision: pinned, revision_source: `env:${LIVE_CLIENT_DEFAULTS.revisionEnv}` };
  for (const m of models) {
    if (m && typeof m.revision === "string" && m.revision.trim() !== "") {
      return { revision: m.revision, revision_source: "backend" };
    }
  }
  return { revision: null, revision_source: "unpinned" };
}

/**
 * Probe a live backend: GET /ready + /models in parallel against baseUrl.
 * Never throws; without the opt-in it returns the stub descriptor without
 * touching the network. With the opt-in but no reachable backend it
 * returns reachable:false so the CLI can refuse the live run (exit 2).
 */
export async function resolveLiveBackend({ argv = process.argv.slice(2), env = process.env, timeoutMs = LIVE_CLIENT_DEFAULTS.probeTimeoutMs, fetchImpl = fetch } = {}) {
  if (!isLiveEnabled(argv, env)) {
    return { mode: "stub", live: false, reachable: false, note: "stub default: live backend only after --live / LAYA_EVAL_LIVE=1" };
  }
  const baseUrl = resolveLiveBaseUrl(env);
  const glinerUrl = resolveLiveGlinerUrl(env);
  const [ready, models] = await Promise.all([
    probeJson(`${baseUrl}/ready`, { timeoutMs, fetchImpl }),
    probeJson(`${baseUrl}/models`, { timeoutMs, fetchImpl }),
  ]);
  const modelList = ready.ok || models.ok ? (Array.isArray(models.body?.models) ? models.body.models : []) : [];
  if (!ready.ok && !models.ok) {
    return {
      mode: "live",
      live: true,
      reachable: false,
      baseUrl,
      glinerUrl,
      error: ready.error ?? models.error ?? `GET /ready -> ${ready.status ?? "no response"}`,
      note: "live requested but the backend is unreachable; run the stub default (no flag) or start laya-server",
    };
  }
  const { revision, revision_source } = resolveLiveRevision({ env, models: modelList });
  const loaded = modelList.filter((m) => m?.loaded === true);
  const first = loaded[0] ?? modelList[0] ?? null;
  return {
    mode: "live",
    live: true,
    reachable: true,
    baseUrl,
    glinerUrl,
    ready: ready.body?.ready === true,
    ready_reason: typeof ready.body?.reason === "string" ? ready.body.reason : null,
    device: typeof ready.body?.device === "string" ? ready.body.device : "unknown (live backend did not report a device)",
    models: modelList,
    model: typeof first?.name === "string" ? first.name : "live-backend (name unreported)",
    model_revision: revision,
    model_revision_source: revision_source,
    tokenizer: "unknown",
    probe_status: { ready: ready.status, models: models.status },
  };
}

/**
 * Connect the real MCP-side clients (dist/) to a probed-reachable backend.
 * Separated from resolveLiveBackend so probing stays network-shape-only
 * and importable without dist/ (tests import this module stub-side only).
 */
export async function connectLiveBackend({ baseUrl, glinerUrl } = {}) {
  const { LayaClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "client.js")).href);
  const { GlinerClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "gliner.js")).href);
  const client = new LayaClient(baseUrl ?? resolveLiveBaseUrl());
  let gliner = null;
  try {
    gliner = new GlinerClient(glinerUrl ?? resolveLiveGlinerUrl());
  } catch {
    gliner = null;
  }
  return { client, gliner };
}

/**
 * Live predict factory: signature-compatible with the T3 `fakeClient`
 * (answers, capture) => client, but the oracle answers are IGNORED and
 * the real questions flow to the backend. Capture still records the
 * questions the handler built, so live runs keep the same observability.
 * Wall vs reported split is preserved downstream: the backend-reported
 * `latencyMs` lands in `latency_ms` while bench measures wall itself.
 */
export function livePredictFactory(liveClient) {
  return (_answers, capture) => ({
    predict: async (args, questions) => {
      if (capture) capture.questions = questions;
      return liveClient.predict(args, questions);
    },
  });
}

/**
 * Live deps adapter: the same { fakeClient, makePiiCtx } shape the suites
 * consume. The PII sidecar uses the live GLiNER client when one was
 * connected; when it was not, piiScan throws an explicit live-unavailable
 * error so the case records `threw` instead of silently measuring stub
 * spans as backend output.
 */
export function makeLiveDeps({ client, gliner = null } = {}) {
  if (!client || typeof client.predict !== "function") {
    throw new Error("makeLiveDeps needs a live client with predict() (connect via connectLiveBackend)");
  }
  return {
    fakeClient: livePredictFactory(client),
    makePiiCtx: (_findings) => ({
      glinerReady: () => gliner !== null,
      gliner: gliner ?? {
        piiScan: async () => {
          throw new Error("live gliner unavailable: no GLiNER sidecar connected (set GLINER_URL or run the stub default)");
        },
        extractEntities: async () => {
          throw new Error("live gliner unavailable: no GLiNER sidecar connected (set GLINER_URL or run the stub default)");
        },
      },
    }),
  };
}
