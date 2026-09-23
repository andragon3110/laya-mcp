#!/usr/bin/env node
/**
 * End-to-end MCP smoke test.
 *
 * Spawns dist/index.js over stdio (like a real agent host would) and:
 *   1. lists tools (expects 11, or 12 when the gliner sidecar is up;
 *      1 — only laya_capabilities — when laya-server is down per the
 *      fase-5 T5 exemption)
 *   2. calls laya_pii on Spanish text with a secret (expects block)
 *   3. calls laya_extract source=entities (expects offsets)
 *   4. calls laya_extract source=auto (expects entities path when gliner up)
 *   5. calls laya_extract source=regex (classic path, always works)
 *
 * Env:
 *   MCP_DIST     path to dist/index.js (default: <repo>/dist/index.js)
 *   LAYA_URL     laya-server base URL (default http://127.0.0.1:8765)
 *   GLINER_URL   gliner-server base URL (default http://127.0.0.1:8766)
 *   EXPECT_PII   "1" to require laya_pii advertised, "0" to require it absent
 *   MCP_SMOKE_TOOL_WAIT_S  tools/list settle budget in seconds (default 15):
 *                the first list can land before HealthWatch's first poll
 *                settles, advertising only laya_capabilities even with the
 *                backends up, so tools/list is retried until laya_extract
 *                appears or the budget ends (offline stays FAIL by design).
 *
 * Exit 0 on success, 1 with a clear message on the first failed assertion.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.MCP_DIST ?? path.join(HERE, "..", "dist", "index.js");
const EXPECT_PII = process.env.EXPECT_PII ?? "1";
// Cierre-pendientes T7: tools/list settle budget (seconds). HealthWatch
// starts DOWN ("not checked yet") and settles on its first poll, so a list
// issued right after spawn can advertise only laya_capabilities even with
// the backends up. Retry below; offline still FAILs by design on budget end.
const TOOL_WAIT_S = Number(process.env.MCP_SMOKE_TOOL_WAIT_S ?? 15);

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL -- ${msg}`);
    process.exit(1);
  }
  console.log(`OK -- ${msg}`);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [DIST],
  env: { ...process.env },
});
const client = new Client({ name: "mcp-smoke", version: "0" }, { capabilities: {} });
await client.connect(transport);

try {
  // Settle loop (race fix): retry tools/list until the backend-backed set
  // shows up (laya_extract present) or the wait budget ends. With the
  // backends up the first poll flips the list from 1 to 11/12 tools; with
  // everything down the list stays at 1 and the asserts below FAIL by design.
  let tools = [];
  {
    const deadline = Date.now() + TOOL_WAIT_S * 1000;
    for (;;) {
      ({ tools } = await client.listTools());
      if (tools.some((t) => t.name === "laya_extract")) break;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const names = tools.map((t) => t.name);
  assert(names.includes("laya_extract"), "laya_extract advertised");
  assert(names.includes("laya_screen"), "laya_screen advertised");
  const wantPii = EXPECT_PII === "1";
  assert(
    names.includes("laya_pii") === wantPii,
    `laya_pii ${wantPii ? "advertised (gliner up)" : "absent (gliner down)"} (got ${names.length} tools)`,
  );
  console.log(`   tools: ${names.length} total`);

  if (wantPii) {
    const pii = await client.callTool({
      name: "laya_pii",
      arguments: { text: "Escribí a juan.perez@acme.com. Token: ghp_AbC123xYz." },
    });
    const body = JSON.parse(pii.content[0].text);
    // P1-T6: legacy `action: "block"` is now the engine decision DENY from
    // pii@1.0.0 (same secret cut, shared table). Updated, not deleted.
    assert(body.decision?.decision === "DENY", `laya_pii denies secrets (got ${body.decision?.decision})`);
    // Custom assert() above shadows the `assert` module name, so there is
    // no assert.deepEqual here: compare with isDeepStrictEqual instead.
    assert(
      isDeepStrictEqual(body.decision?.policy, { name: "pii", version: "1.0.0" }),
      "pii decision carries policy identity",
    );
    const text = "Escribí a juan.perez@acme.com. Token: ghp_AbC123xYz.";
    assert(
      body.findings.every((f) => text.slice(f.start, f.end) === f.text),
      "every finding span round-trips against the source text",
    );
    assert(body.findings.some((f) => f.type === "email"), "email finding present");
    console.log(`   pii counts: ${JSON.stringify(body.counts)}`);

    const ent = await client.callTool({
      name: "laya_extract",
      arguments: {
        document: "María García trabaja en Acme España en Madrid.",
        source: "entities",
        fields: [
          { id: "persona", description: "Nombre de persona" },
          { id: "lugar", description: "Lugar geográfico" },
        ],
      },
    });
    const entBody = JSON.parse(ent.content[0].text);
    assert(entBody.source === "entities", `extract used entities path (got ${entBody.source})`);
    const persona = entBody.results.find((r) => r.id === "persona");
    assert(persona?.value === "María García", `persona value grounded (got ${persona?.value})`);
    assert(persona?.start === 0 && persona?.end === 12, "persona offsets 0:12");
    console.log(`   entities: ${JSON.stringify(entBody.results.map((r) => [r.id, r.value]))}`);

    const auto = await client.callTool({
      name: "laya_extract",
      arguments: {
        document: "El plan Pro cuesta $29 al mes.",
        fields: [{ id: "precio", pattern: "\\$\\d+", description: "Precio mensual" }],
      },
    });
    const autoBody = JSON.parse(auto.content[0].text);
    assert(autoBody.source === "entities", `auto prefers entities when gliner up (got ${autoBody.source})`);
  } else {
    // Degraded mode: pii must fail clearly, extract must fall back to regex.
    const pii = await client.callTool({
      name: "laya_pii",
      arguments: { text: "hola" },
    });
    assert(pii.isError === true, "laya_pii fails clearly when sidecar down");

    const auto = await client.callTool({
      name: "laya_extract",
      arguments: {
        document: "El plan Pro cuesta $29 al mes.",
        fields: [{ id: "precio", pattern: "\\$\\d+", description: "Precio mensual" }],
      },
    });
    const autoBody = JSON.parse(auto.content[0].text);
    assert(autoBody.source === "regex", `auto falls back to regex (got ${autoBody.source})`);
    assert(autoBody.fallback, "fallback note present");
    const precio = autoBody.results.find((r) => r.id === "precio");
    assert(precio?.value === "$29", `regex value resolved to substring (got ${precio?.value})`);
  }

  const rx = await client.callTool({
    name: "laya_extract",
    arguments: {
      document: "Versión 3.2.1 publicada el 2024-06-01.",
      source: "regex",
      fields: [{ id: "version", pattern: "\\d+\\.\\d+\\.\\d+", description: "Número de versión" }],
    },
  });
  const rxBody = JSON.parse(rx.content[0].text);
  assert(rxBody.source === "regex", "explicit regex path works");
  assert(rxBody.results[0]?.value === "3.2.1", `regex value correct (got ${rxBody.results[0]?.value})`);

  console.log("ALL MCP SMOKE TESTS PASSED");
} finally {
  await client.close();
}
