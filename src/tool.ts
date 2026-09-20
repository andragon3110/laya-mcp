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
 * Run a Laya call and shape the MCP text response. The `present` callback
 * decides what the agent actually sees.
 */
export async function runTool(
  client: LayaClient,
  args: Record<string, unknown>,
  questions: Record<string, unknown>,
  present: (raw: Awaited<ReturnType<LayaClient["predict"]>>) => string,
  opts?: PredictOpts,
): Promise<ToolResult> {
  try {
    const result = await client.predict(args, questions, undefined, opts);
    return { ok: true, content: present(result) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
