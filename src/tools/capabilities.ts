/**
 * Fase-5 T5: `laya_capabilities` -- live capability discovery (tool 12).
 *
 * Reports, probed LIVE on every call (never the HealthWatch snapshot):
 *   - `models`:   verbatim `GET /models` inventory (name/repo/loaded/
 *                  revision/device/circuit; revision is the honest
 *                  null+unpinned when the backend cannot resolve a pin).
 *   - `backend`:  curated `GET /ready` state (ready/reason/device/loaded/
 *                  failed/versions/circuit).
 *   - `gliner`:   sidecar `{reachable, ready, models}` via live
 *                  /ready+/models probes (models [] when unreachable).
 *   - `primitives`: the four signal kinds (noul/choice/score/spans) with the
 *                  judgment tools using each (derived from TOOL_PRIMITIVES;
 *                  capabilities itself judges nothing, so it lists nowhere).
 *   - `tools`:    currently SERVABLE tools (10 laya tools + pii only while
 *                  gliner is live-ready + capabilities itself) with a
 *                  SUMMARIZED output contract per tool (name, description,
 *                  primitive, input/output REQUIRED key lists -- the full
 *                  schemas stay on tools/list).
 *   - `policies`: the full policy registry from listPolicies() (registry
 *                  truth, availability-independent: 14 entries).
 *   - `features`: real, code-verified capability flags -- top_k (derived
 *                  from inputSchemas), pruning (derived from outputSchemas +
 *                  the FIND/RERANK_PRUNE_METHOD constants), two_stage
 *                  (laya_decide, see decide.ts), structured (T3/T4 contract),
 *                  revision (evidence.ts/envelope.ts vocabulary). Nothing is
 *                  invented; tests re-derive every entry from its source.
 *   - `mode`:     always "observe".
 *   - `metrics`:    fase-6 T3 in-process snapshot (requests/latency
 *                  p50-p99/decisions/abstentions/escalations per tool,
 *                  per-model latency, probe load stats; aggregates only,
 *                  exact shape in metrics.ts). OPTIONAL outputSchema key.
 *   - `schema_version`: ENVELOPE_SCHEMA_VERSION ("1.0.0").
 *   - `latency_ms`: wall-clock discovery cost (probes run in parallel).
 *
 * Observe mode means: the MCP layer only OBSERVES backend state and reports
 * judgments -- it never executes actions, applies changes, runs commands,
 * or mutates anything. Every tool is read-only inference (see
 * READONLY_TOOL_ANNOTATIONS); capabilities itself performs no judgment at
 * all, only inventory + readiness reads.
 *
 * Availability contract (T5 decision, justified): laya_capabilities is
 * ALWAYS advertised -- even when laya-server is down -- via an explicit
 * exemption in index.ts tools/list. Rationale: with zero tools the host
 * cannot tell MCP-dead apart from MCP-alive/backend-down; with this tool
 * present, `tools/call` on it fails isError WITH the backend diagnosis
 * (laya error + gliner reachability + recovery hint). A backend that does
 * not respond is therefore a call-time isError, never a silent absence.
 * When laya-server IS up the call succeeds even if gliner is down (pii is
 * then simply absent from `tools`, and `gliner.reachable` is false).
 */
import type { BackendModelInfo, LayaClient, ReadyResult } from "../client.js";
import { ENVELOPE_SCHEMA_VERSION, TOOL_PRIMITIVES } from "../envelope.js";
import type { ToolContext } from "../index.js";
import { getMetricsSnapshot, recordProbe } from "../metrics.js";
import { listPolicies } from "../policy/loader.js";
import {
  type ToolDefinition,
  READONLY_TOOL_ANNOTATIONS,
  envelopeMetadataProperties,
} from "../tool.js";
import { screenTool } from "./screen.js";
import { verifyTool } from "./verify.js";
import { findTool } from "./find.js";
import { rerankTool } from "./rerank.js";
import { classifyTool } from "./classify.js";
import { decideTool } from "./decide.js";
import { compareTool } from "./compare.js";
import { extractTool } from "./extract.js";
import { reviewTool } from "./review.js";
import { gateTool } from "./gate.js";
import { piiTool } from "./pii.js";
import { FIND_PRUNE_METHOD } from "./find.js";
import { RERANK_PRUNE_METHOD } from "./rerank.js";

/** Default per-probe budget for the live /models + /ready calls (ms). */
export const CAPABILITIES_DEFAULT_TIMEOUT_MS = 2000;

/** Hard bounds for the optional `timeout_ms` argument. */
export const CAPABILITIES_TIMEOUT_MIN_MS = 100;
export const CAPABILITIES_TIMEOUT_MAX_MS = 30000;

/** The 11 judgment tools (registry truth, independent of backend state). */
const JUDGMENT_TOOLS: readonly ToolDefinition[] = [
  screenTool,
  verifyTool,
  findTool,
  rerankTool,
  classifyTool,
  decideTool,
  compareTool,
  extractTool,
  reviewTool,
  gateTool,
  piiTool,
];

function hasSchemaProp(schema: unknown, prop: string): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const props = (schema as Record<string, unknown>).properties;
  return typeof props === "object" && props !== null && prop in props;
}

/** Tools whose inputSchema declares a `top_k` shortlist param (re-derived live). */
export function topKTools(): string[] {
  return JUDGMENT_TOOLS.filter((t) => hasSchemaProp(t.inputSchema, "top_k")).map((t) => t.name);
}

/** Tools whose outputSchema reports a `pruning:{kept,dropped,method}` object. */
export function pruningTools(): string[] {
  return JUDGMENT_TOOLS.filter((t) => hasSchemaProp(t.outputSchema, "pruning")).map((t) => t.name);
}

/**
 * Fase-5 T5: real feature flags. top_k/pruning are re-derived from the tool
 * schemas on every call (they cannot drift); two_stage/structured/revision
 * are code facts with the source cited, guarded by contract tests that
 * re-check each claim (decide description mentions two stages; every tool
 * declares outputSchema; revision sources match resolveEnvelopeRevision).
 */
export function buildFeatures(): Record<string, unknown> {
  return {
    top_k: {
      supported: true,
      tools: topKTools(),
      note: "Per-call shortlist cap: only the top top_k candidates reach the judge (defaults preserve legacy behaviour).",
    },
    pruning: {
      supported: true,
      tools: pruningTools(),
      methods: { laya_find: FIND_PRUNE_METHOD, laya_rerank: RERANK_PRUNE_METHOD },
      note: "Cheap token-overlap pre-filter before the judge; reported as pruned + pruning:{kept, dropped, method}, never silent.",
    },
    two_stage: {
      supported: true,
      tools: ["laya_decide"],
      note: "Stage 1 selects the winner; stage 2 evaluates each requirement against that winner (single call when no requirements).",
    },
    structured: {
      structured_content: true,
      output_schema: true,
      text_compat: true,
      note: "Every success returns the same object as non-empty text JSON and as structuredContent; every tool declares outputSchema.",
    },
    revision: {
      model_revision: true,
      sources: ["env:LAYA_MODEL_REVISION", "env:GLINER_MODEL_REVISION", "backend", "unpinned"],
      note: "Operator pin wins, else the backend value, else the honest null; a hash is never invented.",
    },
  };
}

/** One-line tool summary: full schemas stay on tools/list, this is the digest. */
function summarizeTool(t: ToolDefinition): Record<string, unknown> {
  return {
    name: t.name,
    description: t.description,
    primitive: TOOL_PRIMITIVES[t.name] ?? null,
    input_required: [...((t.inputSchema.required as string[] | undefined) ?? [])],
    output_required: [...((t.outputSchema.required as string[] | undefined) ?? [])],
  };
}

/**
 * Currently servable tools: the 10 laya tools (the caller already proved
 * laya-server is up) + pii only while gliner is live-ready + this tool.
 * Mirrors the tools/list advertisement for the same backend state.
 */
export function servableTools(glinerReady: boolean): ToolDefinition[] {
  const layaTools = JUDGMENT_TOOLS.filter((t) => t.name !== "laya_pii");
  return [...layaTools, ...(glinerReady ? [piiTool] : []), capabilitiesTool];
}

function validateTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null) return CAPABILITIES_DEFAULT_TIMEOUT_MS;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < CAPABILITIES_TIMEOUT_MIN_MS ||
    raw > CAPABILITIES_TIMEOUT_MAX_MS
  ) {
    throw new Error(
      `invalid_argument: timeout_ms must be an integer in [${CAPABILITIES_TIMEOUT_MIN_MS}, ${CAPABILITIES_TIMEOUT_MAX_MS}] (got ${JSON.stringify(raw) ?? "undefined"})`,
    );
  }
  return raw;
}

interface LayaProbe {
  ok: boolean;
  models: BackendModelInfo[];
  ready: ReadyResult | null;
  error: string | null;
}

/** Live /models + /ready (parallel, each with the call timeout). */
async function probeLaya(client: LayaClient, timeoutMs: number): Promise<LayaProbe> {
  try {
    const [models, ready] = await Promise.all([client.models(timeoutMs), client.ready(timeoutMs)]);
    return { ok: true, models, ready, error: null };
  } catch (err) {
    return { ok: false, models: [], ready: null, error: err instanceof Error ? err.message : String(err) };
  }
}

interface GlinerProbe {
  reachable: boolean;
  ready: boolean;
  models: BackendModelInfo[];
}

/** Live gliner /ready + /models; unreachable degrades to reachable:false. */
async function probeGliner(ctx: ToolContext, timeoutMs: number): Promise<GlinerProbe> {
  try {
    const ready = await ctx.gliner.ready(timeoutMs);
    let models: BackendModelInfo[] = [];
    try {
      models = await ctx.gliner.models(timeoutMs);
    } catch {
      models = [];
    }
    return { reachable: true, ready: ready.ready, models };
  } catch {
    return { reachable: false, ready: false, models: [] };
  }
}

export const capabilitiesTool: ToolDefinition = {
  name: "laya_capabilities",
  description:
    "Discover what this laya-mcp server can do right now, probed live. Reports the backend model inventory " +
    "(GET /models), readiness (GET /ready), GLiNER sidecar state, judgment primitives, currently servable tools " +
    "with summarized output contracts, the full policy registry, and real feature flags (top_k, pruning, " +
    "two-stage, structured, revision). Observe mode: the MCP layer only observes backend state and reports " +
    "judgments; it never executes actions, applies changes, or mutates anything. Probed live on every call " +
    "with a timeout (default 2000ms via timeout_ms); the background watcher snapshot is never used. Always " +
    "advertised, even when laya-server is down -- a call then fails with isError carrying the backend diagnosis.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_ms: {
        type: "integer",
        minimum: CAPABILITIES_TIMEOUT_MIN_MS,
        maximum: CAPABILITIES_TIMEOUT_MAX_MS,
        description:
          "Per-probe timeout in ms for the live /models + /ready calls (default 2000). Probes run in parallel, so wall-clock cost is ~1x this budget.",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      models: {
        type: "array",
        description: "Live GET /models inventory, verbatim backend entries (revision honest-null when unpinned).",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            repo: { type: "string" },
            loaded: { type: "boolean" },
            revision: { type: ["string", "null"] },
            revision_source: { type: "string" },
            device: { type: "string" },
            circuit: { type: "string" },
          },
          required: ["name"],
        },
      },
      backend: {
        type: "object",
        description: "Live GET /ready state.",
        properties: {
          ready: { type: "boolean" },
          reason: { type: ["string", "null"] },
          device: { type: "string" },
          loaded: { type: "array", items: { type: "string" } },
          failed: { type: "array", items: { type: "object" } },
          versions: { type: "object" },
          circuit: { type: "string" },
        },
        required: ["ready"],
      },
      gliner: {
        type: "object",
        description: "GLiNER sidecar state from live probes (reachable:false when down).",
        properties: {
          reachable: { type: "boolean" },
          ready: { type: "boolean" },
          models: { type: "array", items: { type: "object" } },
        },
        required: ["reachable", "ready", "models"],
      },
      primitives: {
        type: "array",
        description: "Judgment signal kinds with the tools using each (capabilities judges nothing, lists nowhere).",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            tools: { type: "array", items: { type: "string" } },
          },
          required: ["name", "tools"],
        },
      },
      tools: {
        type: "array",
        description: "Currently servable tools with summarized output contracts (full schemas stay on tools/list).",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            primitive: { type: ["string", "null"] },
            input_required: { type: "array", items: { type: "string" } },
            output_required: { type: "array", items: { type: "string" } },
          },
          required: ["name", "description", "primitive", "input_required", "output_required"],
        },
      },
      policies: {
        type: "array",
        description: "Full policy registry {name, version} (availability-independent).",
        items: {
          type: "object",
          properties: { name: { type: "string" }, version: { type: "string" } },
          required: ["name", "version"],
        },
      },
      features: {
        type: "object",
        description: "Real, code-verified capability flags (top_k, pruning, two_stage, structured, revision).",
        properties: {
          top_k: { type: "object" },
          pruning: { type: "object" },
          two_stage: { type: "object" },
          structured: { type: "object" },
          revision: { type: "object" },
        },
        required: ["top_k", "pruning", "two_stage", "structured", "revision"],
      },
      mode: {
        type: "string",
        enum: ["observe"],
        description:
          "Observe mode: the MCP layer only observes backend state and reports judgments; it never executes actions, applies changes, or mutates anything.",
      },
      metrics: {
        type: "object",
        description:
          "In-process metrics snapshot (fase-6 T3, OPTIONAL -- never required so stored pre-T3 outputs keep " +
          "validating): requests_total/failed, inference_latency_ms p50/p95/p99 over a bounded window, " +
          "policy_decisions per tool/decision, abstentions, escalations, per-model latency, and probe " +
          "model_load stats. Numeric/categorical aggregates only -- no argument content, no free text. " +
          "Exact shape is documented in metrics.ts (getMetricsSnapshot).",
      },
      schema_version: {
        type: "string",
        description: "Envelope contract version (ENVELOPE_SCHEMA_VERSION).",
      },
      latency_ms: {
        type: "number",
        description: "Wall-clock discovery latency in ms (probes run in parallel).",
      },
      ...envelopeMetadataProperties(),
    },
    required: [
      "models",
      "backend",
      "gliner",
      "primitives",
      "tools",
      "policies",
      "features",
      "mode",
      "schema_version",
      "latency_ms",
    ],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  // Capabilities never calls /predict (discovery only); the questions
  // builder is a no-op satisfying ToolDefinition.
  buildQuestions: () => ({}),
};

/**
 * Live capability discovery. Throws ( -> isError, no structuredContent)
 * when laya-server does not respond; the message carries the backend
 * diagnosis plus gliner reachability so the failure itself is informative.
 */
export async function handleCapabilities(
  client: LayaClient,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const timeoutMs = validateTimeoutMs(args.timeout_ms);
  const started = Date.now();
  // Fase-6 T3: the live probes below are the model_load signal -- each is
  // timed individually (parallel wall-clock per probe) and recorded via
  // recordProbe. No new sondas: these are the pre-existing discovery
  // probes, only observed, never added to.
  const timed = async <T>(p: Promise<T>): Promise<[T, number]> => {
    const s = Date.now();
    const v = await p;
    return [v, Date.now() - s];
  };
  const [[laya, layaMs], [gliner, glinerMs]] = await Promise.all([
    timed(probeLaya(client, timeoutMs)),
    timed(probeGliner(ctx, timeoutMs)),
  ]);
  recordProbe("laya", laya.ok && laya.ready !== null, layaMs);
  recordProbe("gliner", gliner.reachable, glinerMs);
  if (!laya.ok || laya.ready === null) {
    throw new Error(
      `laya_capabilities: laya-server unavailable (${laya.error ?? "unknown error"}); ` +
        `gliner reachable=${gliner.reachable}. ` +
        "Start laya-server (curl $LAYA_URL/health); this tool stays advertised while down " +
        "so hosts can tell MCP-alive/backend-down apart from MCP-dead.",
    );
  }
  const ready = laya.ready;
  const backend: Record<string, unknown> = {
    ready: ready.ready,
    reason: ready.reason ?? null,
    loaded: ready.loaded ?? [],
    failed: ready.failed ?? [],
  };
  if (ready.device !== undefined) backend.device = ready.device;
  if (ready.versions !== undefined) backend.versions = ready.versions;
  if (ready.circuit !== undefined) backend.circuit = ready.circuit;
  const primitives = ["noul", "choice", "score", "spans"].map((name) => ({
    name,
    tools: JUDGMENT_TOOLS.filter((t) => TOOL_PRIMITIVES[t.name] === name).map((t) => t.name),
  }));
  const report = {
    models: laya.models,
    backend,
    gliner: { reachable: gliner.reachable, ready: gliner.ready, models: gliner.models },
    primitives,
    tools: servableTools(gliner.ready).map(summarizeTool),
    policies: listPolicies(),
    features: buildFeatures(),
    mode: "observe" as const,
    // Fase-6 T3: metrics snapshot embedded additively (no new tool -- this
    // already-exempt discovery surface is the exposure point; one line of
    // justification as required: a new tool would add list surface for a
    // read that discovery already serves).
    metrics: getMetricsSnapshot(),
    schema_version: ENVELOPE_SCHEMA_VERSION,
    latency_ms: Date.now() - started,
  };
  return JSON.stringify(report, null, 2);
}
