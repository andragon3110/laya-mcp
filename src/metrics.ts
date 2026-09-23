/**
 * Fase-6 T3: in-process metrics registry (no dependencies, no exporters).
 *
 * What is recorded (categorical/numeric aggregates ONLY -- never argument
 * content, never free text, never span payloads; see trace.ts for the
 * privacy rationale):
 *   - requests_total / requests_failed: per tool (failed covers the
 *     index.ts error branch + unknown-tool branch via recordError).
 *   - inference_latency_ms: per tool, from the envelope `latency_ms`
 *     (backend passthrough, conserved by envelope.ts -- never recomputed
 *     here). Summarized as p50/p95/p99 (nearest-rank) over a BOUNDED
 *     window: at most LATENCY_WINDOW_MAX retained samples per series
 *     (oldest dropped first -- ring semantics via shift). The cap bounds
 *     memory to ~tools x models x 256 numbers regardless of uptime.
 *   - model_load_time / failures: from the ALREADY-EXISTING live probes in
 *     capabilities.ts (probeLaya/probeGliner timing + ok flag via
 *     recordProbe). No new sondas, no watcher changes: capabilities calls
 *     the only probes this layer owns per call.
 *   - policy_decisions: per tool per decision label (ALLOW/REVIEW/DENY/
 *     ESCALATE + any future engine label, uppercased verbatim -- labels
 *     are engine truth, never invented here).
 *   - abstentions: per tool, when envelope `abstention.abstained` is true.
 *   - escalations: per tool, when the decision label is ESCALATE (also
 *     present inside policy_decisions; the top-level counter is the
 *     fase-6 acceptance shorthand).
 *   - by_model: per tool per model (evidence.model verbatim; null/empty
 *     buckets as "none" -- pii has no laya judgment, capabilities judges
 *     nothing). Latency quantiles per tool+model when reasonable, same cap.
 *
 * Hook points (central, already identified):
 *   - envelope.ts buildCallResult success path -> recordEnvelope (extracts
 *     model/decision/latency/abstention from the augmented envelope);
 *     degenerate path -> recordCall with empty observation (counts the
 *     request, no decision/latency).
 *   - index.ts CallTool error branch + unknown-tool branch -> recordError.
 *   - capabilities.ts live probes -> recordProbe.
 *
 * Exposure: getMetricsSnapshot() returns a plain JSON-able object whose
 * shape is the documented `metrics` field embedded (additively) in the
 * `laya_capabilities` report. Format (all leaves numbers/strings):
 *   {
 *     requests_total:      { [tool]: n },
 *     requests_failed:     { [tool]: n },
 *     inference_latency_ms:{ [tool]: { count, p50, p95, p99 } },
 *     policy_decisions:    { [tool]: { [DECISION]: n } },
 *     abstentions:         { [tool]: n },
 *     escalations:         { [tool]: n },
 *     by_model:            { [tool]: { [model]: { total, p50, p95, p99 } } },
 *     model_load:          { laya|gliner: { probes, failures, p50, p95, p99 } }
 *   }
 * Quantiles are numbers when samples exist, else null. `count` is the
 * RETAINED sample count (<= LATENCY_WINDOW_MAX) -- the bounded-window
 * proof. resetMetrics() exists for test isolation (and operator resets).
 */

export const ESCALATE_DECISION = "ESCALATE";

/** Null/empty evidence.model buckets under this key (pii, capabilities). */
export const UNKNOWN_MODEL = "none";

/**
 * Max retained latency samples per series (per tool, per tool+model, per
 * probe source). Oldest samples drop first. Bounds metrics memory to a
 * small constant regardless of request volume.
 */
export const LATENCY_WINDOW_MAX = 256;

export interface LatencySummary {
  /** Retained sample count (<= LATENCY_WINDOW_MAX). */
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ModelSummary {
  total: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface ProbeSummary {
  probes: number;
  failures: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

/** Documented snapshot shape (see header; embedded as `metrics`). */
export interface MetricsSnapshot {
  requests_total: Record<string, number>;
  requests_failed: Record<string, number>;
  inference_latency_ms: Record<string, LatencySummary>;
  policy_decisions: Record<string, Record<string, number>>;
  abstentions: Record<string, number>;
  escalations: Record<string, number>;
  by_model: Record<string, Record<string, ModelSummary>>;
  model_load: Record<string, ProbeSummary>;
}

/** One served observation (degenerate path: all optional fields absent). */
export interface CallObservation {
  tool: string;
  model?: string | null;
  decision?: string | null;
  latencyMs?: number | null;
  abstained?: boolean | null;
}

interface ModelBucket {
  total: number;
  lat: number[];
}

interface ToolBucket {
  total: number;
  failed: number;
  decisions: Record<string, number>;
  abstentions: number;
  escalations: number;
  lat: number[];
  byModel: Record<string, ModelBucket>;
}

interface ProbeBucket {
  probes: number;
  failures: number;
  lat: number[];
}

const tools = new Map<string, ToolBucket>();
const probes: Record<string, ProbeBucket> = {
  laya: { probes: 0, failures: 0, lat: [] },
  gliner: { probes: 0, failures: 0, lat: [] },
};

function toolBucket(name: string): ToolBucket {
  let b = tools.get(name);
  if (!b) {
    b = { total: 0, failed: 0, decisions: {}, abstentions: 0, escalations: 0, lat: [], byModel: {} };
    tools.set(name, b);
  }
  return b;
}

function pushBounded(series: number[], v: number): void {
  series.push(v);
  while (series.length > LATENCY_WINDOW_MAX) series.shift();
}

/** Nearest-rank quantile over a sorted-ascending copy. Null when empty. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx];
}

function summarize(series: number[]): LatencySummary {
  const sorted = [...series].sort((a, b) => a - b);
  return {
    count: series.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
}

/** Clear every counter/series (test isolation, operator reset). */
export function resetMetrics(): void {
  tools.clear();
  for (const k of Object.keys(probes)) probes[k] = { probes: 0, failures: 0, lat: [] };
}

/**
 * Record one served call. Decision labels are uppercased verbatim engine
 * truth; latency must be a finite non-negative number to enter the window.
 */
export function recordCall(obs: CallObservation): void {
  const b = toolBucket(obs.tool);
  b.total += 1;
  if (typeof obs.decision === "string" && obs.decision !== "") {
    const label = obs.decision.toUpperCase();
    b.decisions[label] = (b.decisions[label] ?? 0) + 1;
    if (label === ESCALATE_DECISION) b.escalations += 1;
  }
  if (obs.abstained === true) b.abstentions += 1;
  const latencyOk = typeof obs.latencyMs === "number" && Number.isFinite(obs.latencyMs) && obs.latencyMs >= 0;
  const modelKey =
    typeof obs.model === "string" && obs.model !== "" ? obs.model : UNKNOWN_MODEL;
  const mb = b.byModel[modelKey] ?? { total: 0, lat: [] };
  mb.total += 1;
  b.byModel[modelKey] = mb;
  if (latencyOk) {
    const v = obs.latencyMs as number;
    pushBounded(b.lat, v);
    pushBounded(mb.lat, v);
  }
}

/** Record a failed request (index.ts error branch, unknown tool). */
export function recordError(tool: string): void {
  const b = toolBucket(tool);
  b.total += 1;
  b.failed += 1;
}

/**
 * Extract a CallObservation from an augmented envelope (the buildCallResult
 * hook): model/decision from evidence/decision, latency_ms conserved,
 * abstention.abstained flag. Never throws on odd shapes (yields an empty
 * observation that still counts the request).
 */
export function recordEnvelope(toolName: string, augmented: unknown): void {
  try {
    const env =
      typeof augmented === "object" && augmented !== null
        ? (augmented as Record<string, unknown>)
        : null;
    const evidence =
      env !== null && typeof env.evidence === "object" && env.evidence !== null
        ? (env.evidence as Record<string, unknown>)
        : null;
    const decision =
      env !== null && typeof env.decision === "object" && env.decision !== null
        ? (env.decision as Record<string, unknown>)
        : null;
    const abstention =
      env !== null && typeof env.abstention === "object" && env.abstention !== null
        ? (env.abstention as Record<string, unknown>)
        : null;
    const latency = env?.latency_ms;
    recordCall({
      tool: toolName,
      model: typeof evidence?.model === "string" ? evidence.model : null,
      decision: typeof decision?.decision === "string" ? decision.decision : null,
      latencyMs: typeof latency === "number" ? latency : null,
      abstained: abstention?.abstained === true,
    });
  } catch {
    recordCall({ tool: toolName });
  }
}

/**
 * Record one already-existing live probe outcome (capabilities.ts only --
 * no new sondas): ok=false counts a load failure. Latency enters the same
 * bounded window. Unknown sources are ignored (never throw on telemetry).
 */
export function recordProbe(source: string, ok: boolean, latencyMs: number): void {
  const b = probes[source];
  if (!b) return;
  b.probes += 1;
  if (!ok) b.failures += 1;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) pushBounded(b.lat, latencyMs);
}

/** Plain JSON-able snapshot (the documented `metrics` exposure format). */
export function getMetricsSnapshot(): MetricsSnapshot {
  const requests_total: Record<string, number> = {};
  const requests_failed: Record<string, number> = {};
  const inference_latency_ms: Record<string, LatencySummary> = {};
  const policy_decisions: Record<string, Record<string, number>> = {};
  const abstentions: Record<string, number> = {};
  const escalations: Record<string, number> = {};
  const by_model: Record<string, Record<string, ModelSummary>> = {};
  for (const [name, b] of tools) {
    requests_total[name] = b.total;
    requests_failed[name] = b.failed;
    inference_latency_ms[name] = summarize(b.lat);
    policy_decisions[name] = { ...b.decisions };
    abstentions[name] = b.abstentions;
    escalations[name] = b.escalations;
    const models: Record<string, ModelSummary> = {};
    for (const [model, mb] of Object.entries(b.byModel)) {
      const sorted = [...mb.lat].sort((a, b2) => a - b2);
      models[model] = {
        total: mb.total,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
      };
    }
    by_model[name] = models;
  }
  const model_load: Record<string, ProbeSummary> = {};
  for (const [source, b] of Object.entries(probes)) {
    const sorted = [...b.lat].sort((a, b2) => a - b2);
    model_load[source] = {
      probes: b.probes,
      failures: b.failures,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
    };
  }
  return {
    requests_total,
    requests_failed,
    inference_latency_ms,
    policy_decisions,
    abstentions,
    escalations,
    by_model,
    model_load,
  };
}
