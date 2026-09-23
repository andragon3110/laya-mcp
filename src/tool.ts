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
