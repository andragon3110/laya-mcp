#!/usr/bin/env node
/**
 * End-to-end MCP smoke test.
 *
 * Spawns dist/index.js over stdio (like a real agent host would) and:
 *   1. lists tools (expects 10, or 11 when the gliner sidecar is up)
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
 *
 * Exit 0 on success, 1 with a clear message on the first failed assertion.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = process.env.MCP_DIST ?? path.join(HERE, "..", "dist", "index.js");
const EXPECT_PII = process.env.EXPECT_PII ?? "1";

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
  const { tools } = await client.listTools();
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
    assert(body.action === "block", `laya_pii blocks on secret (got ${body.action})`);
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
