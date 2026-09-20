#!/usr/bin/env node
/**
 * laya-mcp server.
 *
 * Exposes 10 typed-decision tools (laya_screen, laya_verify, laya_find, etc.)
 * backed by a local Laya instance reachable via HTTP at LAYA_URL.
 *
 * Behaviour contract:
 *   - If the laya-server (Python) is NOT reachable, `tools/list` returns []
 *     and every `tools/call` returns `{isError: true, ...}` -- the MCP host
 *     sees zero tools and the user-facing agent never crashes.
 *   - The server is intentionally stateless: each call is independent.
 *   - A background watcher polls /health every LAYA_HEALTH_INTERVAL_MS so
 *     tool availability flips automatically when the Python process comes
 *     up or goes down.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { LayaClient } from "./client.js";
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

const TOOL_TIMEOUT_MS = Number(process.env.LAYA_TOOL_TIMEOUT_MS ?? 8000);

const ALL_TOOLS = [
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

const HANDLERS: Record<string, (client: LayaClient, args: Record<string, unknown>) => Promise<string>> = {
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
};

const client = new LayaClient();
const health = new HealthWatch(client);
health.start();

const server = new Server(
  { name: "laya-mcp", version: "0.3.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Only advertise tools when Laya is reachable. This keeps the agent from
  // attempting calls that would just fail.
  if (!health.current().ready) {
    return { tools: [] };
  }
  return {
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
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
    const content = await handler(client, args);
    return { content: [{ type: "text", text: content }] };
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
      `tool_timeout_ms=${TOOL_TIMEOUT_MS})`,
  );
}

main().catch((err) => {
  console.error("[laya-mcp] fatal:", err);
  process.exit(1);
});
