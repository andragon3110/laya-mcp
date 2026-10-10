/**
 * Escalation sink tests: `laya_escalations` log/list/ack cycle.
 *
 * Part A (offline, dist build): tool definition (outputSchema required ⊆
 * properties, NON-read-only annotations announced), store cycle in an
 * isolated temp file (log → esc-0001/esc-0002, list open/acked counts,
 * ack moves one, unknown id/action/field reject with invalid_argument),
 * handler returns parseable JSON.
 *
 * Part B (live MCP, backends DOWN): the server still advertises
 * laya_escalations (no backend needed — same exemption rationale as
 * capabilities) and a full log→list→ack round-trip works with structured
 * output; structuredContent deep-equals the parsed text.
 *
 * Run after build from the repo root: node tests/escalations.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  escalationsTool,
  handleEscalations,
  resolveStoreFile,
} from "../dist/tools/escalations.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "esc-")), "escalations.jsonl");
}

// --- Part A: definition -------------------------------------------------
await check("definition: name, schemas, non-readonly annotations", () => {
  assert.equal(escalationsTool.name, "laya_escalations");
  const out = escalationsTool.outputSchema;
  assert.equal(out?.type, "object");
  assert.ok(Array.isArray(out?.required) && out.required.length > 0, "non-empty required");
  for (const k of out.required) assert.ok(out.properties?.[k] !== undefined, `required '${k}' declared`);
  assert.equal(escalationsTool.annotations?.readOnlyHint, false, "not read-only (announced)");
  assert.equal(escalationsTool.annotations?.destructiveHint, false, "append/ack only, never destructive");
  assert.ok(escalationsTool.inputSchema.properties?.action?.enum?.includes("log"), "action enum has log");
  assert.ok(escalationsTool.inputSchema.properties?.action?.enum?.includes("ack"), "action enum has ack");
});

await check("resolveStoreFile honors env, defaults under repo var/", () => {
  const tmp = tmpFile();
  const prev = process.env.LAYA_ESCALATIONS_FILE;
  process.env.LAYA_ESCALATIONS_FILE = tmp;
  try {
    assert.equal(resolveStoreFile(), tmp);
  } finally {
    if (prev === undefined) delete process.env.LAYA_ESCALATIONS_FILE;
    else process.env.LAYA_ESCALATIONS_FILE = prev;
  }
  assert.ok(resolveStoreFile().endsWith(path.join("var", "escalations.jsonl")), "default under var/");
});

// --- Part A: store cycle --------------------------------------------------
await check("log → list → ack cycle with isolated file", async () => {
  const file = tmpFile();
  const prev = process.env.LAYA_ESCALATIONS_FILE;
  process.env.LAYA_ESCALATIONS_FILE = file;
  try {
    const r1 = JSON.parse(await handleEscalations(null, {
      action: "log", primitive: "noul", tool: "laya_gate",
      decision: "ESCALATE", reason: "evidence silence", case_id: "r1-gate-en-abstention-01",
    }, null));
    assert.equal(r1.escalation_id, "esc-0001");
    const r2 = JSON.parse(await handleEscalations(null, {
      action: "log", primitive: "noul", tool: "laya_screen",
      decision: "REVIEW", reason: "filler without substance",
    }, null));
    assert.equal(r2.escalation_id, "esc-0002");
    const listed = JSON.parse(await handleEscalations(null, { action: "list" }, null));
    assert.equal(listed.open, 2);
    assert.equal(listed.acked, 0);
    assert.equal(listed.escalations.length, 2);
    const acked = JSON.parse(await handleEscalations(null, {
      action: "ack", escalation_id: "esc-0001", verdict: "ABSTAIN", reviewer: "t",
    }, null));
    assert.equal(acked.escalation.status, "acked");
    assert.equal(acked.escalation.verdict, "ABSTAIN");
    const listed2 = JSON.parse(await handleEscalations(null, { action: "list", status: "open" }, null));
    assert.equal(listed2.open, 1);
    assert.equal(listed2.escalations[0].id, "esc-0002");
  } finally {
    if (prev === undefined) delete process.env.LAYA_ESCALATIONS_FILE;
    else process.env.LAYA_ESCALATIONS_FILE = prev;
  }
});

await check("rejections: unknown action/id, missing fields", async () => {
  const file = tmpFile();
  const prev = process.env.LAYA_ESCALATIONS_FILE;
  process.env.LAYA_ESCALATIONS_FILE = file;
  try {
    await assert.rejects(
      handleEscalations(null, { action: "nuke" }, null), /invalid_argument/,
      "unknown action rejects",
    );
    await assert.rejects(
      handleEscalations(null, { action: "log", tool: "laya_gate" }, null), /invalid_argument/,
      "log missing fields rejects",
    );
    await assert.rejects(
      handleEscalations(null, { action: "ack", escalation_id: "esc-9999", verdict: "x" }, null),
      /invalid_argument/, "ack unknown id rejects",
    );
    const empty = JSON.parse(await handleEscalations(null, { action: "list" }, null));
    assert.deepEqual(empty.escalations, [], "missing file lists empty");
  } finally {
    if (prev === undefined) delete process.env.LAYA_ESCALATIONS_FILE;
    else process.env.LAYA_ESCALATIONS_FILE = prev;
  }
});

// --- Part B: live MCP round-trip, backends DOWN -----------------------------
await check("live: advertised with backends down + full round-trip", async () => {
  const file = tmpFile();
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(HERE, "..", "dist", "index.js")],
    env: {
      ...process.env,
      LAYA_URL: "http://127.0.0.1:9",
      GLINER_URL: "http://127.0.0.1:9",
      LAYA_HEALTH_INTERVAL_MS: "200",
      LAYA_ESCALATIONS_FILE: file,
    },
  });
  const client = new Client({ name: "t-escalations", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes("laya_escalations"), "escalations advertised with backends down");
    const logged = await client.callTool({ name: "laya_escalations", arguments: {
      action: "log", primitive: "noul", tool: "laya_gate",
      decision: "ESCALATE", reason: "live probe entry",
    } });
    assert.equal(logged.isError, undefined, "log succeeds");
    const text = logged.content[0].text;
    assert.deepStrictEqual(logged.structuredContent, JSON.parse(text), "structured == parsed text");
    assert.equal(JSON.parse(text).escalation_id, "esc-0001");
    const listed = await client.callTool({ name: "laya_escalations", arguments: { action: "list" } });
    assert.equal(JSON.parse(listed.content[0].text).open, 1);
    const acked = await client.callTool({ name: "laya_escalations", arguments: {
      action: "ack", escalation_id: "esc-0001", verdict: "ABSTAIN",
    } });
    assert.equal(JSON.parse(acked.content[0].text).escalation.status, "acked");
    const bad = await client.callTool({ name: "laya_escalations", arguments: { action: "nope" } });
    assert.ok(bad.isError, "unknown action isError over the wire");
  } finally {
    await client.close().catch(() => {});
  }
});

console.log(`escalations: ${passed} checks passed`);
