/**
 * Tool definitions: each tool declares its name, description, JSON schema
 * and a `build` function that turns tool arguments into a question payload
 * for Laya. The actual call is done by the MCP `index.ts` so it can
 * catch `LayaUnavailableError` uniformly and return `isError: true`.
 */
import type { LayaClient, PredictOpts } from "./client.js";

export type QuestionBuilder = (args: Record<string, unknown>) => Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Fase-5 T3: JSON Schema (type "object") describing the envelope the
   * handler's text-JSON parses into. Published verbatim on `tools/list`.
   * Always additive: handlers keep returning the same JSON string.
   */
  outputSchema: Record<string, unknown>;
  /**
   * Fase-5 T3: MCP tool annotations (SDK ToolSchema annotations shape:
   * title/readOnlyHint/destructiveHint/idempotentHint/openWorldHint).
   * Every laya tool only runs inference and returns a judgment -- no side
   * effects -- so the shared READONLY_TOOL_ANNOTATIONS below applies.
   */
  annotations?: Record<string, unknown>;
  buildQuestions: QuestionBuilder;
}

export type ToolResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/**
 * Build a question payload from caller arguments. Tools that need only
 * a single primitive (e.g. `laya_screen`) use `passthrough()`.
 */
export const passthrough: QuestionBuilder = (args) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
};

/**
 * Fase-5 T3: shared annotations for every laya tool. All tools are
 * read-only judges (inference + deterministic policy, never mutate).
 * `openWorldHint` is deliberately omitted (SDK default applies): tools
 * reach a local HTTP backend, and we claim nothing about world scope.
 */
export const READONLY_TOOL_ANNOTATIONS: Record<string, unknown> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/**
 * Fase-5 T3: `decision` property descriptor for outputSchemas. `allowed`
 * must mirror the tool description's contract (ALLOW/REVIEW/DENY/ESCALATE
 * subset); the engine owns the values, this only advertises them.
 */
export function decisionSchema(allowed: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    description: "Deterministic engine decision from the versioned policy.",
    properties: {
      decision: { type: "string", enum: [...allowed] },
      reason_codes: { type: "array", items: { type: "string" } },
      policy: {
        type: "object",
        properties: { name: { type: "string" }, version: { type: "string" } },
        required: ["name", "version"],
      },
    },
    required: ["decision", "reason_codes", "policy"],
  };
}

/** Fase-6 T4: `shadow` property descriptor for outputSchemas (OPTIONAL). */
export function shadowSchema(): Record<string, unknown> {
  return {
    type: "object",
    description:
      "Shadow evaluation (fase-6 T4, shadow mode only): the decision the candidate policy WOULD have " +
      "made on the same input, without altering `decision`. Absent outside shadow mode.",
    properties: {
      would_decide: decisionSchema(["ALLOW", "REVIEW", "DENY", "ESCALATE"]),
      under_policy: {
        type: "object",
        description: "Explicit candidate policy ref the shadow ran under (name@version).",
        properties: { name: { type: "string" }, version: { type: "string" } },
        required: ["name", "version"],
      },
    },
    required: ["would_decide", "under_policy"],
  };
}

/** Fase-5 T3: `evidence` property descriptor for outputSchemas. */
export function evidenceSchema(description: string): Record<string, unknown> {
  return { type: "object", description };
}

/** Fase-5 T3: `abstention` property descriptor for outputSchemas. */
export function abstentionSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Abstention report: which questions lacked usable answers.",
  };
}

/**
 * Fase-5 T5: envelope-metadata property descriptors for outputSchemas.
 *
 * T4 stamps these keys on every `tools/call` success envelope (see
 * envelope.ts: augmentEnvelope) but deliberately left the 11 outputSchemas
 * untouched. T5 closes that gap: every judgment outputSchema spreads this
 * fragment (plus laya_capabilities' own outputSchema) so the contract is
 * self-describing. All keys are OPTIONAL -- never added to `required`:
 * live envelopes always carry them, but stored pre-T5 outputs must keep
 * validating. That is the minor-version compat promise (see
 * SCHEMA_VERSION_POLICY in envelope.ts).
 *
 * Fase-6 T4 adds `effective_mode` (observe/shadow/enforce, stamped on
 * every live envelope; stored pre-T4 outputs still validate) alongside the
 * two trace keys -- twelve optional keys total, same compat promise.
 *
 * `primitive` admits null for the observe tool (laya_capabilities judges
 * nothing, so augmentEnvelope stamps primitive:null); `model` / `policy` /
 * `policy_version` admit null for envelopes without a judgment (pii has no
 * laya judgment; capabilities has no decision at all). Only type +
 * description + enum keywords are used: the SDK client compiles schemas
 * with Ajv and those are the keywords this repo's schemas already rely on
 * (no `format` / `const`, whose validator support was never verified here).
 */
export function envelopeMetadataProperties(): Record<string, unknown> {
  return {
    decision_id: { type: "string", description: "Unique id per call (dec_<16 lowercase hex)." },
    trace_id: {
      type: "string",
      description: "Inbound trace correlation id from request _meta (validated, generated when absent); opaque id only, never content (fase-6 T3).",
    },
    span_id: {
      type: "string",
      description: "Inbound span id from request _meta (validated, generated when absent); opaque id only, never content (fase-6 T3).",
    },
    timestamp: { type: "string", description: "ISO-8601 creation time of the envelope." },
    model: {
      type: ["string", "null"],
      description: "Judging backend label from evidence.model; null when the evidence bundle is not Laya-sourced (pii evidence stays GLiNER-sourced -- per-span judge signals live in findings[].laya_signal -- and capabilities judges nothing).",
    },
    model_revision: {
      type: ["string", "null"],
      description: "Operator pin or backend revision; honest null when unresolvable (never invented).",
    },
    revision_source: {
      type: "string",
      description:
        "Where model_revision came from: env:LAYA_MODEL_REVISION | env:GLINER_MODEL_REVISION | backend | unpinned.",
    },
    primitive: {
      type: ["string", "null"],
      enum: ["noul", "choice", "score", "spans", null],
      description: "Dominant signal kind; null for the observe tool (judges nothing).",
    },
    policy: {
      type: ["string", "null"],
      description: "Top-level mirror of decision.policy.name; null without a decision.",
    },
    policy_version: {
      type: ["string", "null"],
      description: "Top-level mirror of decision.policy.version; null without a decision.",
    },
    effective_mode: {
      type: "string",
      enum: ["observe", "shadow", "enforce"],
      description:
        "Effective policy-decision mode for this call (fase-6 T4): observe = advisory, shadow = base " +
        "decision plus a shadow report, enforce = Gentle must honor the decision. Resolved per call " +
        "from LAYA_MODE / LAYA_MODE_<TOOL> (default observe).",
    },
    schema_version: {
      type: "string",
      description: 'Envelope contract version, currently "1.0.0" (ENVELOPE_SCHEMA_VERSION).',
    },
  };
}

/**
 * Run a Laya call and shape the MCP text response. The `present` callback
 * decides what the agent actually sees.
 *
 * T5: LAYA_TOOL_TIMEOUT_MS (default 8000) is enforced here as the timeout
 * for every tool call -- previously it was only logged at startup in
 * index.ts. An explicit per-call opts.timeoutMs still wins; direct
 * LayaClient.predict callers keep the transport default (LAYA_TIMEOUT_MS).
 */
export const TOOL_TIMEOUT_MS = Number(process.env.LAYA_TOOL_TIMEOUT_MS ?? 8000);

export async function runTool(
  client: LayaClient,
  args: Record<string, unknown>,
  questions: Record<string, unknown>,
  present: (raw: Awaited<ReturnType<LayaClient["predict"]>>) => string,
  opts?: PredictOpts,
): Promise<ToolResult> {
  try {
    const result = await client.predict(args, questions, opts?.timeoutMs ?? TOOL_TIMEOUT_MS, opts);
    return { ok: true, content: present(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
