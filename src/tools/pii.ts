import type { LayaClient } from "../client.js";
import type { ToolContext } from "../index.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import type { ToolDefinition } from "../tool.js";

export const piiTool: ToolDefinition = {
  name: "laya_pii",
  description:
    "Scan text for PII and secrets (emails, phone numbers, API keys, tokens, passwords, person names) " +
    "using the GLiNER sidecar. Returns flat findings with character offsets. Use BEFORE sensitive text " +
    "enters the agent context or leaves the machine. Requires the gliner-server sidecar " +
    "(install.sh --with-gliner); fails clearly when it is down. " +
    "Text at most 50,000 chars, at most 32 extra types per call (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: LIMITS.maxGlinerTextChars, description: "Text to scan (max 50,000 chars)." },
      extra_types: {
        type: "array",
        maxItems: LIMITS.maxExtraTypes,
        items: { type: "string" },
        description: "Extra zero-shot entity types to look for alongside the PII set (max 32).",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    // No Laya call: GLiNER spans are the whole answer. Still validate early
    // with the same vocabulary so oversized scans fail before any HTTP call
    // (the sidecar answers the identical 413 shape as the authority).
    assertLength(
      String(args.text ?? ""),
      LIMITS.maxGlinerTextChars,
      "text",
      `text exceeds ${LIMITS.maxGlinerTextChars} chars; scan per chunk instead`,
    );
    assertCount(
      Array.isArray(args.extra_types) ? args.extra_types.length : 0,
      LIMITS.maxExtraTypes,
      "extra_types",
      `at most ${LIMITS.maxExtraTypes} extra types per call`,
    );
    return {};
  },
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
  // Early size check with the shared vocabulary (the sidecar 413s as the
  // authority; this just fails before the HTTP round trip).
  piiTool.buildQuestions(args);
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
