import type { LayaClient } from "../client.js";
import type { ToolContext } from "../index.js";
import type { ToolDefinition } from "../tool.js";

export const piiTool: ToolDefinition = {
  name: "laya_pii",
  description:
    "Scan text for PII and secrets (emails, phone numbers, API keys, tokens, passwords, person names) " +
    "using the GLiNER sidecar. Returns flat findings with character offsets. Use BEFORE sensitive text " +
    "enters the agent context or leaves the machine. Requires the gliner-server sidecar " +
    "(install.sh --with-gliner); fails clearly when it is down.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to scan." },
      extra_types: {
        type: "array",
        items: { type: "string" },
        description: "Extra zero-shot entity types to look for alongside the PII set.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  buildQuestions: () => ({}), // No Laya call: GLiNER spans are the whole answer.
};

const SECRET_TYPES = new Set(["api_key", "token_secreto", "password"]);

export async function handlePii(
  _client: LayaClient,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  if (!ctx || !ctx.glinerReady()) {
    throw new Error(
      "laya_pii needs the gliner-server sidecar, which is not reachable. " +
        "Start it with $HOME/laya-mcp/start_gliner.sh (installed via install.sh --with-gliner). " +
        "The agent continues without PII scanning.",
    );
  }
  const text = String(args.text ?? "");
  const extra = Array.isArray(args.extra_types) ? (args.extra_types as string[]) : [];
  const { findings, counts, latencyMs } = await ctx.gliner.piiScan(text, extra);
  const secrets = findings.filter((f) => SECRET_TYPES.has(f.type));
  const action =
    secrets.length > 0 ? "block" : findings.length > 0 ? "review" : "pass";
  return JSON.stringify(
    {
      action,
      findings,
      counts,
      secrets_found: secrets.length,
      latency_ms: latencyMs,
      recommendation:
        action === "block"
          ? "Secrets detected. Redact before the text enters any model context or leaves the machine."
          : action === "review"
            ? "PII detected. Review whether each finding may enter context."
            : "No PII or secrets detected.",
    },
    null,
    2,
  );
}
