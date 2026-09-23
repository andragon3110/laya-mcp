#!/usr/bin/env node
/**
 * laya-mcp server.
 *
 * Exposes 10 typed-decision tools (laya_screen, laya_verify, laya_find, etc.)
 * backed by a local Laya instance reachable via HTTP at LAYA_URL, plus one
 * optional tool (laya_pii) backed by the GLiNER sidecar at GLINER_URL
 * (11 tools total with the sidecar up, 10 without it).
 *
 * Behaviour contract:
 *   - If the laya-server (Python) is NOT reachable, `tools/list` returns []
 *     and every `tools/call` returns `{isError: true, ...}` -- the MCP host
 *     sees zero tools and the user-facing agent never crashes.
 *   - `laya_pii` is advertised only while the gliner-server sidecar is
 *     reachable. `laya_extract` uses GLiNER spans when available and falls
 *     back to regex otherwise (unless source=entities is forced).
 *   - The server is intentionally stateless: each call is independent.
 *   - Background watchers poll /live (liveness) + /ready (readiness) so
 *     tool availability flips automatically when either Python process
 *     comes up or goes down. CallTool never consults the watchers
 *     (see src/health.ts) and fails fast on its own via client timeouts.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { LayaClient } from "./client.js";
import { buildCallResult } from "./envelope.js";
import { GlinerClient } from "./gliner.js";
import { HealthWatch } from "./health.js";
import { screenTool, handleScreen } from "./tools/screen.js";
import { verifyTool, handleVerify } from "./tools/verify.js";
import { findTool, handleFind } from "./tools/find.js";
import { rerankTool, handleRerank } from "./tools/rerank.js";
import { classifyTool, handleClassify } from "./tools/classify.js";
import { decideTool, handleDecide } from "./tools/decide.js";
import { compareTool, handleCompare } from "./tools/compare.js";
import { extractTool, handleExtract } from "./tools/extract.js";
import { reviewTool, handleReview } from "./tools/review.js";
import { gateTool, handleGate } from "./tools/gate.js";
import { piiTool, handlePii } from "./tools/pii.js";

// T5: enforced per tool call in runTool (src/tool.ts); logged here at startup.
// Per-tool budgets (if ever needed) belong to T6.
const TOOL_TIMEOUT_MS = Number(process.env.LAYA_TOOL_TIMEOUT_MS ?? 8000);

/** Shared per-request context handed to every tool handler. */
export interface ToolContext {
  gliner: GlinerClient;
  glinerReady: () => boolean;
}

const BASE_TOOLS = [
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
] as const;

const HANDLERS: Record<
  string,
  (client: LayaClient, args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
> = {
  laya_screen: handleScreen,
  laya_verify: handleVerify,
  laya_find: handleFind,
  laya_rerank: handleRerank,
  laya_classify: handleClassify,
  laya_decide: handleDecide,
  laya_compare: handleCompare,
  laya_extract: handleExtract,
  laya_review: handleReview,
  laya_gate: handleGate,
  laya_pii: handlePii,
};

const client = new LayaClient();
const health = new HealthWatch(client);
health.start();

const gliner = new GlinerClient();
const glinerHealth = new HealthWatch(
  gliner,
  Number(process.env.GLINER_HEALTH_INTERVAL_MS ?? process.env.LAYA_HEALTH_INTERVAL_MS ?? 10000),
  "gliner-server",
);
glinerHealth.start();

const ctx: ToolContext = {
  gliner,
  glinerReady: () => glinerHealth.current().ready === true,
};

const server = new Server(
  { name: "laya-mcp", version: "0.4.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Only advertise tools when Laya is reachable. This keeps the agent from
  // attempting calls that would just fail.
  if (!health.current().ready) {
    return { tools: [] };
  }
  const tools = [...BASE_TOOLS];
  if (ctx.glinerReady()) {
    tools.push(piiTool);
  }
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      // Fase-5 T3: publish the typed output contract + annotations. The
      // SDK server does NOT validate arguments against inputSchema or
      // results against outputSchema (verified in
      // node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js:
      // only the tools/call request/result envelope is validated); real
      // input rejection lives in each tool's buildQuestions
      // (input_too_large), and outputSchema is an announcement for clients.
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name;
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  }
  const args = (request.params.arguments ?? {}) as Record<string, unknown>;

  try {
    const content = await handler(client, args, ctx);
    // Fase-5 T4: the text block stays (re-serialized WITH the additive
    // decision metadata, still non-empty indented JSON for 2024-10-07
    // clients) and structuredContent carries the SAME object
    // (deep-equals JSON.parse of the text). Degenerate handler text still
    // returns intact with no structuredContent (see envelope.ts).
    return buildCallResult(name, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              tool: name,
              error: message,
              hint: "laya-server is unreachable. Run `curl $LAYA_URL/health`. " +
                "If it's down, restart it; if the MCP host still shows zero tools, " +
                "this is fine -- the agent continues without laya-mcp.",
            },
            null,
            2,
          ),
        },
      ],
    };
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[laya-mcp] ready (model=${process.env.LAYA_MODEL ?? "convaiinnovations/laya"}, ` +
      `url=${process.env.LAYA_URL ?? "http://127.0.0.1:8765"}, ` +
      `gliner_url=${process.env.GLINER_URL ?? "http://127.0.0.1:8766"}, ` +
      `tool_timeout_ms=${TOOL_TIMEOUT_MS})`,
  );
}

main().catch((err) => {
  console.error("[laya-mcp] fatal:", err);
  process.exit(1);
});
