/**
 * Harness-spike-ready T4: pluggable live-backend adapter for score/bench.
 *
 * SCOPE (T4 only): resolve + probe a real backend (`laya-server` at
 * LAYA_URL plus the GLiNER sidecar at GLINER_URL) BEHIND AN EXPLICIT
 * OPT-IN, and adapt it to the `deps` shape the T3 suites already consume
 * (`fakeClient` factory + `makePiiCtx`). No weights, no model downloads,
 * S3 RERANK LANE (spike-gliner-qwen3): the Qwen3-Reranker sidecar at
 * RERANK_URL (py/qwen_rerank_server.py, default :8768) is probed and
 * connected as a THIRD backend behind the same opt-in. `RerankClient`
 * speaks POST /rerank {query, candidates[, instruction, top_k]} and offers
 * a predict(state, questions)-compatible adapter so the rerank suite's
 * real handler (dist/tools/rerank.js handleRerank) can judge through Qwen
 * instead of Laya: `liveRerankPredictFactory(rerank)` builds the
 * (answers, capture) => client factory the suites consume, and
 * `makeLiveDeps({client, gliner, rerank}).makeRerankCtx()` exposes the
 * connected client (or an explicit live-unavailable thrower when the
 * sidecar was not connected -- never a silent stub). S4 wires rerank/find
 * suites through this lane; the default fakeClient (Laya judge) is
 * untouched, so non-rerank live behavior is byte-identical to S2.
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
  /** Qwen rerank sidecar base URL env + default (py/qwen_rerank_server.py). */
  rerankUrlEnv: "RERANK_URL",
  rerankDefaultUrl: "http://127.0.0.1:8768",
  /** Operator revision pins (same names as src/evidence.ts). */
  revisionEnv: "LAYA_MODEL_REVISION",
  glinerRevisionEnv: "GLINER_MODEL_REVISION",
  /** Operator revision pin for the rerank sidecar (evidence vocabulary). */
  rerankRevisionEnv: "RERANK_MODEL_REVISION",
  /** Per-backend revision pins (evidence vocabulary; operator pin wins,
   * blank counts as unset, else the honest unpinned null). */
  d1RevisionEnv: "D1_MODEL_REVISION",
  gliclassRevisionEnv: "GLICLASS_MODEL_REVISION",
  policylmRevisionEnv: "POLICYLM_MODEL_REVISION",
  promptguardRevisionEnv: "PROMPTGUARD_MODEL_REVISION",
  gteRevisionEnv: "GTE_MODEL_REVISION",
  /** Per-probe budget for the live /ready + /models calls (ms). */
  probeTimeoutMs: 1500,
  /**
   * T6a per-primitive bench lane URL envs. Each lane reads its own env
   * first, then falls back to the shared primitive env (LAYA_URL for
   * judge lanes, RERANK_URL for ordering lanes), then the shared default.
   * Same opt-in/probe/refusal vocabulary as the rest of this module:
   * nothing here activates a backend, it only resolves where a lane
   * would dial when the T6b matrix opts in.
   */
  benchLaneUrls: {
    classify: { env: "LAYA_BENCH_CLASSIFY_URL", fallbackEnv: "LAYA_URL", fallbackDefault: "http://127.0.0.1:8765" },
    screen: { env: "LAYA_BENCH_SCREEN_URL", fallbackEnv: "LAYA_URL", fallbackDefault: "http://127.0.0.1:8765" },
    gate: { env: "LAYA_BENCH_GATE_URL", fallbackEnv: "LAYA_URL", fallbackDefault: "http://127.0.0.1:8765" },
    rerank: { env: "LAYA_BENCH_RERANK_URL", fallbackEnv: "RERANK_URL", fallbackDefault: "http://127.0.0.1:8768" },
    find: { env: "LAYA_BENCH_FIND_URL", fallbackEnv: "RERANK_URL", fallbackDefault: "http://127.0.0.1:8768" },
  },
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

/** Rerank sidecar base URL resolution (verbatim env or the :8768 default). */
export function resolveLiveRerankUrl(env = process.env) {
  const raw = env[LIVE_CLIENT_DEFAULTS.rerankUrlEnv] ?? LIVE_CLIENT_DEFAULTS.rerankDefaultUrl;
  return String(raw).replace(/\/$/, "");
}

/**
 * T6a: per-primitive bench lane URL resolution. Lane env wins verbatim,
 * else the shared primitive env (LAYA_URL / RERANK_URL), else the shared
 * default; slash-trimmed. Unknown lanes throw (never a silent default).
 */
export function resolveLaneBaseUrl(lane, env = process.env) {
  const spec = LIVE_CLIENT_DEFAULTS.benchLaneUrls[lane];
  if (!spec) {
    throw new Error(`unknown bench lane ${JSON.stringify(String(lane))} (known: ${Object.keys(LIVE_CLIENT_DEFAULTS.benchLaneUrls).join(", ")})`);
  }
  const raw = env[spec.env] ?? env[spec.fallbackEnv] ?? spec.fallbackDefault;
  return String(raw).replace(/\/$/, "");
}

/**
 * T6a: generic sidecar probe (GET /ready + /models in parallel against
 * baseUrl). Never throws. Returns the reachable descriptor, or the
 * exit-2-style refusal record when down: { reachable: false, exitCode: 2,
 * error, note } -- the caller refuses the lane run, never silently
 * measures a stub as backend output. Same honesty vocabulary as
 * resolveLiveRerank.
 */
export async function probeSidecar({ baseUrl, service = "sidecar", note = null, timeoutMs = LIVE_CLIENT_DEFAULTS.probeTimeoutMs, fetchImpl = fetch } = {}) {
  const [ready, models] = await Promise.all([
    probeJson(`${baseUrl}/ready`, { timeoutMs, fetchImpl }),
    probeJson(`${baseUrl}/models`, { timeoutMs, fetchImpl }),
  ]);
  const modelList = ready.ok || models.ok ? (Array.isArray(models.body?.models) ? models.body.models : []) : [];
  if (!ready.ok && !models.ok) {
    return {
      baseUrl,
      service,
      reachable: false,
      exitCode: 2,
      error: ready.error ?? models.error ?? `GET /ready -> ${ready.status ?? "no response"}`,
      note: note ?? `${service} unreachable at ${baseUrl}`,
    };
  }
  const loaded = modelList.filter((m) => m?.loaded === true);
  const first = loaded[0] ?? modelList[0] ?? null;
  return {
    baseUrl,
    service,
    reachable: true,
    ready: ready.body?.ready === true,
    ready_reason: typeof ready.body?.reason === "string" ? ready.body.reason : (typeof ready.body?.status === "string" ? ready.body.status : null),
    device: typeof ready.body?.device === "string" ? ready.body.device : `unknown (${service} backend did not report a device)`,
    models: modelList,
    model: typeof first?.name === "string" ? first.name : `${service} backend (name unreported)`,
    probe_status: { ready: ready.status, models: models.status },
  };
}

/**
 * Per-backend revision pins in the src/evidence.ts vocabulary. Operator env
 * pin wins (blank counts as unset), else the first non-null backend model
 * revision for backends that report an inventory, else the honest unpinned
 * null (a hash is never invented). Backends without a probed inventory
 * (D1/GLiCLASS/PolicyLM/PromptGuard/GTE have no harness probe yet) resolve
 * from their env pin or the honest null. Returns { <key>: { revision,
 * revision_source, env } } for manifest backend records.
 */
export function resolveBackendRevisions({ env = process.env, models = [] } = {}) {
  const pin = (envVar) => {
    const v = String(env[envVar] ?? "").trim();
    return v !== "" ? { revision: v, revision_source: `env:${envVar}`, env: envVar } : null;
  };
  const fromModels = () => {
    for (const m of models) {
      if (m && typeof m.revision === "string" && m.revision.trim() !== "") {
        return { revision: m.revision, revision_source: "backend" };
      }
    }
    return { revision: null, revision_source: "unpinned" };
  };
  const backends = [
    ["laya", LIVE_CLIENT_DEFAULTS.revisionEnv, true],
    ["gliner", LIVE_CLIENT_DEFAULTS.glinerRevisionEnv, false],
    ["rerank", LIVE_CLIENT_DEFAULTS.rerankRevisionEnv, false],
    ["d1", LIVE_CLIENT_DEFAULTS.d1RevisionEnv, false],
    ["gliclass", LIVE_CLIENT_DEFAULTS.gliclassRevisionEnv, false],
    ["policylm", LIVE_CLIENT_DEFAULTS.policylmRevisionEnv, false],
    ["promptguard", LIVE_CLIENT_DEFAULTS.promptguardRevisionEnv, false],
    ["gte", LIVE_CLIENT_DEFAULTS.gteRevisionEnv, false],
  ];
  const out = {};
  for (const [key, envVar, hasInventory] of backends) {
    out[key] = pin(envVar) ?? (hasInventory ? { ...fromModels(), env: envVar } : { revision: null, revision_source: "unpinned", env: envVar });
  }
  return out;
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
export function resolveLiveRevision({ env = process.env, models = [], envVar = LIVE_CLIENT_DEFAULTS.revisionEnv } = {}) {
  const pinned = String(env[envVar] ?? "").trim();
  if (pinned !== "") return { revision: pinned, revision_source: `env:${envVar}` };
  for (const m of models) {
    if (m && typeof m.revision === "string" && m.revision.trim() !== "") {
      return { revision: m.revision, revision_source: "backend" };
    }
  }
  return { revision: null, revision_source: "unpinned" };
}

/**
 * Probe the rerank sidecar: GET /ready + /models in parallel against
 * rerankUrl. Never throws. Returns the honest descriptor block the CLIs
 * and S4 runs quote (reachable:false with a reason when down -- never a
 * silent stub, same honesty vocabulary as the Laya probe).
 */
export async function resolveLiveRerank({ env = process.env, timeoutMs = LIVE_CLIENT_DEFAULTS.probeTimeoutMs, fetchImpl = fetch } = {}) {
  const baseUrl = resolveLiveRerankUrl(env);
  const [ready, models] = await Promise.all([
    probeJson(`${baseUrl}/ready`, { timeoutMs, fetchImpl }),
    probeJson(`${baseUrl}/models`, { timeoutMs, fetchImpl }),
  ]);
  const modelList = ready.ok || models.ok ? (Array.isArray(models.body?.models) ? models.body.models : []) : [];
  if (!ready.ok && !models.ok) {
    return {
      baseUrl,
      reachable: false,
      error: ready.error ?? models.error ?? `GET /ready -> ${ready.status ?? "no response"}`,
      note: "rerank sidecar unreachable; start py/qwen_rerank_server.py (:8768) or set RERANK_URL",
    };
  }
  const { revision, revision_source } = resolveLiveRevision({ env, models: modelList, envVar: LIVE_CLIENT_DEFAULTS.rerankRevisionEnv });
  const loaded = modelList.filter((m) => m?.loaded === true);
  const first = loaded[0] ?? modelList[0] ?? null;
  return {
    baseUrl,
    reachable: true,
    ready: ready.body?.ready === true,
    ready_reason: typeof ready.body?.reason === "string" ? ready.body.reason : null,
    device: typeof ready.body?.device === "string" ? ready.body.device : "unknown (rerank backend did not report a device)",
    models: modelList,
    model: typeof first?.name === "string" ? first.name : "rerank-backend (name unreported)",
    model_revision: revision,
    model_revision_source: revision_source,
    probe_status: { ready: ready.status, models: models.status },
  };
}

/**
 * Probe a live backend: GET /ready + /models in parallel against baseUrl.
 * Never throws; without the opt-in it returns the stub descriptor without
 * touching the network. With the opt-in but no reachable backend it
 * returns reachable:false so the CLI can refuse the live run (exit 2).
 *
 * S3: the rerank sidecar is probed too (same opt-in, no extra flag) and
 * reported as `rerank` + `rerankUrl`. Overall `reachable` stays Laya-gated
 * (the S2 refusal contract is unchanged: CLIs refuse exactly as before
 * when Laya is down); a down rerank sidecar is reported honestly in its
 * own block so S4 runs can refuse rerank lanes without laundering stub
 * numbers as Qwen numbers.
 */
export async function resolveLiveBackend({ argv = process.argv.slice(2), env = process.env, timeoutMs = LIVE_CLIENT_DEFAULTS.probeTimeoutMs, fetchImpl = fetch } = {}) {
  if (!isLiveEnabled(argv, env)) {
    return { mode: "stub", live: false, reachable: false, note: "stub default: live backend only after --live / LAYA_EVAL_LIVE=1", revisions: resolveBackendRevisions({ env }) };
  }
  const baseUrl = resolveLiveBaseUrl(env);
  const glinerUrl = resolveLiveGlinerUrl(env);
  const rerankUrl = resolveLiveRerankUrl(env);
  const [ready, models, rerank] = await Promise.all([
    probeJson(`${baseUrl}/ready`, { timeoutMs, fetchImpl }),
    probeJson(`${baseUrl}/models`, { timeoutMs, fetchImpl }),
    resolveLiveRerank({ env, timeoutMs, fetchImpl }),
  ]);
  const modelList = ready.ok || models.ok ? (Array.isArray(models.body?.models) ? models.body.models : []) : [];
  if (!ready.ok && !models.ok) {
    return {
      mode: "live",
      live: true,
      reachable: false,
      baseUrl,
      glinerUrl,
      rerankUrl,
      rerank,
      error: ready.error ?? models.error ?? `GET /ready -> ${ready.status ?? "no response"}`,
      note: "live requested but the backend is unreachable; run the stub default (no flag) or start laya-server",
      revisions: resolveBackendRevisions({ env }),
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
    rerankUrl,
    rerank,
    ready: ready.body?.ready === true,
    ready_reason: typeof ready.body?.reason === "string" ? ready.body.reason : null,
    device: typeof ready.body?.device === "string" ? ready.body.device : "unknown (live backend did not report a device)",
    models: modelList,
    model: typeof first?.name === "string" ? first.name : "live-backend (name unreported)",
    model_revision: revision,
    model_revision_source: revision_source,
    revisions: resolveBackendRevisions({ env, models: modelList }),
    tokenizer: "unknown",
    probe_status: { ready: ready.status, models: models.status },
  };
}

/**
 * RerankClient: thin fetch wrapper over the Qwen rerank sidecar
 * (py/qwen_rerank_server.py, POST /rerank). Mirrors the GlinerClient
 * surface shape (baseUrl ctor, POST helper raising Error on non-2xx) so
 * the lane reads like the existing sidecar lane.
 */
export class RerankClient {
  constructor(baseUrl = resolveLiveRerankUrl()) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
  }

  /**
   * Score every candidate against the query. Returns the server body
   * verbatim ({ranked: [{id, rank, score}], latency_ms, ...}) plus
   * `latencyMs` (the latency_ms alias the harness uses) and a `scores`
   * id->score map for adapter convenience. Throws on transport errors,
   * timeouts, 413 over-ceiling pools and 503 backpressure -- the caller
   * records `threw`, never a stub order.
   */
  async rerank(query, candidates, { instruction, top_k, timeoutMs = 120000 } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/rerank`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          query,
          candidates,
          ...(instruction !== undefined ? { instruction } : {}),
          ...(top_k !== undefined ? { top_k } : {}),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof body?.detail === "string" ? body.detail : (body?.code ?? res.status);
        throw new Error(`rerank-server POST /rerank returned HTTP ${res.status}: ${String(detail).slice(0, 200)}`);
      }
      if (!Array.isArray(body.ranked)) {
        throw new Error("rerank-server returned invalid payload (missing ranked[])");
      }
      const scores = {};
      for (const row of body.ranked) {
        if (row && typeof row.id === "string" && typeof row.score === "number") scores[row.id] = row.score;
      }
      return { ...body, scores, latencyMs: Number(body.latency_ms ?? 0) };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("rerank-server")) throw err;
      throw new Error(err?.name === "AbortError" ? `rerank-server timed out after ${timeoutMs}ms` : `rerank-server unreachable at ${this.baseUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * predict(state, questions)-compatible adapter so the REAL rerank handler
   * judges through Qwen: state carries {query, candidates} (the shown
   * shortlist, already truncated by handleRerank) and question keys index
   * that shortlist as relevance_{i}_{id} (see buildRerankQuestionsWithInfo
   * in dist/tools/rerank.js: unpruned keys are verbatim, pruned keys index
   * the shortlist -- both line up with state.candidates order). Scores map
   * back as {noul} answers; ids the server did not score are OMITTED (the
   * handler sorts them last and escalates -- honest, never invented).
   * Only rerank-shaped calls are supported: anything else throws an
   * explicit live-rerank-unavailable error (find wiring is S4's call).
   */
  async predict(state, questions, timeoutMs) {
    const query = state?.query;
    const pool = Array.isArray(state?.candidates) ? state.candidates : null;
    if (typeof query !== "string" || pool === null) {
      throw new Error("live rerank unavailable: RerankClient.predict only serves rerank-shaped calls ({query, candidates}); use LayaClient for judge questions");
    }
    const ids = pool.filter((c) => c && typeof c.id === "string").map((c) => c.id);
    const { scores, latencyMs } = await this.rerank(query, pool, { timeoutMs });
    const answers = {};
    const wanted = questions && typeof questions === "object" ? Object.keys(questions) : ids.map((id, i) => `relevance_${i}_${id}`);
    const byIndex = new Map(ids.map((id, i) => [`relevance_${i}_${id}`, id]));
    for (const key of wanted) {
      const id = byIndex.get(key);
      if (id !== undefined && typeof scores[id] === "number") answers[key] = { noul: scores[id] };
    }
    return { answers, confidence: {}, routing: {}, model: "qwen-rerank", latencyMs, usage: {} };
  }
}

/**
 * Rerank predict factory: signature-compatible with the T3 `fakeClient`
 * (answers, capture) => client, but the oracle answers are IGNORED and the
 * real (query, candidates) flow to the Qwen sidecar via RerankClient.
 * Mirror of livePredictFactory for the rerank lane (S4 recipe: pass this
 * factory as fakeClient for the rerank/find suites under --live).
 */
export function liveRerankPredictFactory(rerankClient) {
  return (_answers, capture) => ({
    predict: async (args, questions) => {
      if (capture) capture.questions = questions;
      return rerankClient.predict(args, questions);
    },
  });
}

/**
 * Connect the real MCP-side clients (dist/) to a probed-reachable backend.
 * Separated from resolveLiveBackend so probing stays network-shape-only
 * and importable without dist/ (tests import this module stub-side only).
 *
 * S3: also connects the rerank sidecar best-effort (same pattern as
 * gliner: failure yields null, and makeRerankCtx throws an explicit
 * live-unavailable error instead of silently measuring the stub).
 */
export async function connectLiveBackend({ baseUrl, glinerUrl, rerankUrl } = {}) {
  const { LayaClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "client.js")).href);
  const { GlinerClient } = await import(pathToFileURL(path.join(repoRoot, "dist", "gliner.js")).href);
  const client = new LayaClient(baseUrl ?? resolveLiveBaseUrl());
  let gliner = null;
  try {
    gliner = new GlinerClient(glinerUrl ?? resolveLiveGlinerUrl());
  } catch {
    gliner = null;
  }
  let rerank = null;
  try {
    rerank = new RerankClient(rerankUrl ?? resolveLiveRerankUrl());
  } catch {
    rerank = null;
  }
  return { client, gliner, rerank };
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
export function makeLiveDeps({ client, gliner = null, rerank = null } = {}) {
  if (!client || typeof client.predict !== "function") {
    throw new Error("makeLiveDeps needs a live client with predict() (connect via connectLiveBackend)");
  }
  return {
    fakeClient: livePredictFactory(client),
    makeRerankCtx: () => ({
      rerankReady: () => rerank !== null,
      rerank: rerank ?? {
        rerank: async () => {
          throw new Error("live rerank unavailable: no Qwen sidecar connected (set RERANK_URL or run the stub default)");
        },
        predict: async () => {
          throw new Error("live rerank unavailable: no Qwen sidecar connected (set RERANK_URL or run the stub default)");
        },
      },
      /** S4 recipe: fakeClient for rerank/find suites under --live. */
      rerankFakeClient: liveRerankPredictFactory(rerank ?? {
        predict: async () => {
          throw new Error("live rerank unavailable: no Qwen sidecar connected (set RERANK_URL or run the stub default)");
        },
      }),
    }),
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
