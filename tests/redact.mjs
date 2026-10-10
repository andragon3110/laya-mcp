/**
 * Redact transform tests: `laya_redact` strategies, overlap rule, unicode.
 *
 * Part A (offline, dist build): definition (read-only annotations KEPT --
 * a pure transform modifies nothing), label/placeholder strategies, overlap
 * rule (earliest wins, longest wins ties), emoji code-point offsets,
 * rejections (empty findings, reversed/out-of-range/non-integer spans,
 * unknown strategy), handler JSON parseable.
 *
 * Part B (live MCP, backends DOWN): advertised with everything down and a
 * redact round-trip works with structured output; structuredContent
 * deep-equals the parsed text.
 *
 * Run after build from the repo root: node tests/redact.mjs
 */
import assert from "node:assert";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  redactTool,
  handleRedact,
  redactText,
} from "../dist/tools/redact.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

await check("definition: name, schemas, read-only annotations kept", () => {
  assert.equal(redactTool.name, "laya_redact");
  const out = redactTool.outputSchema;
  assert.equal(out?.type, "object");
  assert.ok(Array.isArray(out?.required) && out.required.length > 0, "non-empty required");
  for (const k of out.required) assert.ok(out.properties?.[k] !== undefined, `required '${k}' declared`);
  assert.equal(redactTool.annotations?.readOnlyHint, true, "pure transform modifies nothing");
  assert.equal(redactTool.annotations?.destructiveHint, false, "never destructive");
  assert.equal(redactTool.annotations?.idempotentHint, true, "deterministic");
});

await check("label strategy redacts each span with its type", async () => {
  const out = JSON.parse(await handleRedact(null, {
    text: "call ann@example.com or 555-1234",
    findings: [
      { start: 5, end: 20, entity_type: "email" },
      { start: 24, end: 32, entity_type: "phone" },
    ],
  }, null));
  assert.equal(out.redacted, "call [REDACTED:email] or [REDACTED:phone]");
  assert.equal(out.spans_redacted, 2);
});

await check("placeholder strategy uses one marker", async () => {
  const out = JSON.parse(await handleRedact(null, {
    text: "call ann@example.com now",
    strategy: "placeholder",
    findings: [{ start: 5, end: 20, entity_type: "email" }],
  }, null));
  assert.equal(out.redacted, "call [REDACTED] now");
});

await check("overlap rule: earliest wins, longest wins ties", () => {
  assert.equal(
    redactText("abcdefghij", [
      { start: 2, end: 8, entity_type: "a" },
      { start: 4, end: 6, entity_type: "b" },
    ], "label"),
    "ab[REDACTED:a]ij",
  );
  assert.equal(
    redactText("abcdefghij", [
      { start: 2, end: 5, entity_type: "short" },
      { start: 2, end: 8, entity_type: "long" },
    ], "label"),
    "ab[REDACTED:long]ij",
  );
});

await check("offsets are unicode code points (emoji-safe)", async () => {
  // "a😀b": code points a=0 😀=1 b=2; UTF-16 would mis-slice without conversion.
  const out = JSON.parse(await handleRedact(null, {
    text: "a😀b",
    findings: [{ start: 1, end: 2, entity_type: "emoji" }],
  }, null));
  assert.equal(out.redacted, "a[REDACTED:emoji]b");
});

await check("rejections: empty findings, bad spans, unknown strategy", async () => {
  await assert.rejects(handleRedact(null, { text: "abc", findings: [] }, null), /invalid_argument/);
  await assert.rejects(
    handleRedact(null, { text: "abc", findings: [{ start: 2, end: 2 }] }, null), /invalid_argument/,
    "empty span rejects",
  );
  await assert.rejects(
    handleRedact(null, { text: "abc", findings: [{ start: 3, end: 1 }] }, null), /invalid_argument/,
    "reversed span rejects",
  );
  await assert.rejects(
    handleRedact(null, { text: "abc", findings: [{ start: 0, end: 9 }] }, null), /invalid_argument/,
    "out-of-range rejects",
  );
  await assert.rejects(
    handleRedact(null, { text: "abc", findings: [{ start: 0.5, end: 2 }] }, null), /invalid_argument/,
    "non-integer rejects",
  );
  await assert.rejects(
    handleRedact(null, { text: "abc", findings: [{ start: 0, end: 1 }], strategy: "rot13" }, null),
    /invalid_argument/, "unknown strategy rejects",
  );
});

await check("live: advertised with backends down + round-trip", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(HERE, "..", "dist", "index.js")],
    env: {
      ...process.env,
      LAYA_URL: "http://127.0.0.1:9",
      GLINER_URL: "http://127.0.0.1:9",
      LAYA_HEALTH_INTERVAL_MS: "200",
    },
  });
  const client = new Client({ name: "t-redact", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("laya_redact"), "redact advertised with backends down");
    const res = await client.callTool({ name: "laya_redact", arguments: {
      text: "token sk-abc123 here",
      findings: [{ start: 6, end: 15, entity_type: "secret" }],
    } });
    assert.equal(res.isError, undefined, "redact succeeds");
    const text = res.content[0].text;
    assert.deepStrictEqual(res.structuredContent, JSON.parse(text), "structured == parsed text");
    assert.equal(JSON.parse(text).redacted, "token [REDACTED:secret] here");
    const bad = await client.callTool({ name: "laya_redact", arguments: { text: "x", findings: [] } });
    assert.ok(bad.isError, "empty findings isError over the wire");
  } finally {
    await client.close().catch(() => {});
  }
});

console.log(`redact: ${passed} checks passed`);
