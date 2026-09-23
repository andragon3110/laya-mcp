/**
 * Fase-5 T4 envelope tests: structuredContent + decision metadata + revision.
 *
 * Part A (offline, no server): the envelope helpers (dist/envelope.js) and
 * the evidence revision plumbing (dist/evidence.js) --
 *   - buildCallResult returns text + structuredContent where
 *     structuredContent deep-equals JSON.parse of the text;
 *   - every augmented envelope carries decision_id (dec_<16hex>, unique per
 *     call), timestamp (ISO), model, model_revision + revision_source,
 *     primitive (per-tool map), policy/policy_version mirroring
 *     decision.policy, schema_version "1.0.0", and the conserved latency_ms;
 *   - degenerate handler text (unparseable / non-object) returns intact
 *     with NO structuredContent and no throw;
 *   - revision: honest null + "unpinned" by default, backend value +
 *     "backend" when supplied, env pin + "env:VAR" when LAYA_/GLINER_MODEL_
 *     REVISION is set (blank counts as unset); evidence bundles agree.
 *
 * Part B (live round-trip, stub backends): all 11 tools via MCP
 * client.callTool against stub laya + stub gliner HTTP servers. Every call
 * asserts content[0].text non-empty, structuredContent deep-equals the
 * parsed text, and metadata shape per tool.
 *
 * Part C (live with env pins): server spawned with LAYA_MODEL_REVISION +
 * GLINER_MODEL_REVISION set; screen reports the laya pin, pii the gliner pin.
 *
 * Run after build from the repo root: node tests/fase5_t4_envelope.mjs
 */
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ENVELOPE_SCHEMA_VERSION,
  TOOL_PRIMITIVES,
  augmentEnvelope,
  buildCallResult,
  newDecisionId,
  resolveEnvelopeRevision,
} from "../dist/envelope.js";
import {
  GLINER_MODEL_REVISION_ENV,
  LAYA_MODEL_REVISION_ENV,
  glinerRevisionSource,
  layaRevisionSource,
  makeEvidence,
  piiEvidence,
  readRevisionEnv,
  resolveGlinerRevision,
  resolveLayaRevision,
  revisionFromRaw,
  screenEvidence,
} from "../dist/evidence.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist", "index.js");

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}

const DECISION_ID_RE = /^dec_[0-9a-f]{16}$/;
const fakeDecision = (name = "screen") => ({
  decision: "ALLOW",
  reason_codes: ["screen_pass"],
  policy: { name, version: "1.0.0" },
});
const fakeEnvelope = (name = "screen", model = "stub-laya") => ({
  assessment: "valid",
  decision: fakeDecision(name),
  latency_ms: 7,
  evidence: { signals: [], model, revision: null, detector: "router" },
  abstention: { abstained: false, reason: null },
});

function withCleanRevisionEnv(fn) {
  const savedLaya = process.env[LAYA_MODEL_REVISION_ENV];
  const savedGliner = process.env[GLINER_MODEL_REVISION_ENV];
  delete process.env[LAYA_MODEL_REVISION_ENV];
  delete process.env[GLINER_MODEL_REVISION_ENV];
  try {
    return fn();
  } finally {
    if (savedLaya !== undefined) process.env[LAYA_MODEL_REVISION_ENV] = savedLaya;
    else delete process.env[LAYA_MODEL_REVISION_ENV];
    if (savedGliner !== undefined) process.env[GLINER_MODEL_REVISION_ENV] = savedGliner;
    else delete process.env[GLINER_MODEL_REVISION_ENV];
  }
}

// ---------------------------------------------------------- Part A: unit ---
await check("decision ids are dec_<16hex> and unique per call", () => {
  const a = newDecisionId();
  const b = newDecisionId();
  assert.match(a, DECISION_ID_RE, `shape ${a}`);
  assert.match(b, DECISION_ID_RE, `shape ${b}`);
  assert.notEqual(a, b, "unique per call");
});

await check("primitive map covers all 11 tools with the contract vocabulary", () => {
  const names = [
    "laya_screen",
    "laya_verify",
    "laya_find",
    "laya_rerank",
    "laya_classify",
    "laya_decide",
    "laya_compare",
    "laya_extract",
    "laya_review",
    "laya_gate",
    "laya_pii",
  ];
  for (const n of names) {
    assert.ok(["noul", "choice", "score", "spans"].includes(TOOL_PRIMITIVES[n]), `${n} primitive`);
  }
  assert.equal(TOOL_PRIMITIVES.laya_screen, "noul");
  assert.equal(TOOL_PRIMITIVES.laya_find, "choice");
  assert.equal(TOOL_PRIMITIVES.laya_review, "score");
  assert.equal(TOOL_PRIMITIVES.laya_pii, "spans");
});

await withCleanRevisionEnv(async () => {
  await check("augmented envelope carries full metadata, conserves legacy keys", () => {
    const out = augmentEnvelope("laya_screen", fakeEnvelope());
    assert.match(out.decision_id, DECISION_ID_RE, "decision_id");
    assert.ok(!Number.isNaN(Date.parse(out.timestamp)), "timestamp ISO");
    assert.equal(out.model, "stub-laya", "model from evidence");
    assert.equal(out.model_revision, null, "honest null revision by default");
    assert.equal(out.revision_source, "unpinned");
    assert.equal(out.primitive, "noul");
    assert.equal(out.policy, "screen", "policy mirrors decision.policy.name");
    assert.equal(out.policy_version, "1.0.0", "policy_version mirrors decision.policy.version");
    assert.equal(out.schema_version, "1.0.0");
    assert.equal(ENVELOPE_SCHEMA_VERSION, "1.0.0");
    assert.equal(out.latency_ms, 7, "latency_ms conserved");
    assert.equal(out.assessment, "valid", "legacy keys preserved");
    assert.deepEqual(out.decision, fakeDecision("screen"), "decision untouched");
  });

  await check("buildCallResult: structuredContent deep-equals parsed text", () => {
    for (const tool of Object.keys(TOOL_PRIMITIVES)) {
      const text = JSON.stringify(fakeEnvelope(tool === "laya_pii" ? "pii" : "screen"));
      const res = buildCallResult(tool, text);
      assert.ok(Array.isArray(res.content) && res.content.length === 1, `${tool} one text block`);
      assert.equal(res.content[0].type, "text");
      assert.ok(typeof res.content[0].text === "string" && res.content[0].text.length > 0, `${tool} text non-empty`);
      assert.deepStrictEqual(res.structuredContent, JSON.parse(res.content[0].text), `${tool} structured == parsed text`);
      assert.equal(res.structuredContent.primitive, TOOL_PRIMITIVES[tool], `${tool} primitive stamped`);
    }
  });

  await check("degenerate handler text: intact, no structuredContent, no throw", () => {
    const garbage = buildCallResult("laya_screen", "not json at all {{{");
    assert.equal(garbage.content[0].text, "not json at all {{{", "text intact");
    assert.ok(!("structuredContent" in garbage), "structuredContent omitted");
    const array = buildCallResult("laya_screen", "[1,2]");
    assert.equal(array.content[0].text, "[1,2]", "text intact");
    assert.ok(!("structuredContent" in array), "non-object omits structuredContent");
  });

  await check("revision fallback: null+unpinned default, backend passthrough, no invention", () => {
    assert.equal(revisionFromRaw({ routing: {} }), null, "backend null stays null");
    assert.equal(revisionFromRaw({ routing: { revision: "abc123" } }), "abc123", "backend value verbatim");
    assert.equal(resolveLayaRevision({ model: "m", routing: {} }), null);
    assert.equal(layaRevisionSource({ model: "m", routing: {} }), "unpinned");
    assert.equal(resolveLayaRevision({ model: "m", routing: { revision: "r1" } }), "r1");
    assert.equal(layaRevisionSource({ model: "m", routing: { revision: "r1" } }), "backend");
    assert.deepEqual(resolveEnvelopeRevision("laya_screen", null), {
      model_revision: null,
      revision_source: "unpinned",
    });
    assert.deepEqual(resolveEnvelopeRevision("laya_screen", "r1"), {
      model_revision: "r1",
      revision_source: "backend",
    });
    assert.equal(resolveGlinerRevision(), null);
    assert.equal(glinerRevisionSource(), "unpinned");
  });

  await check("evidence bundles carry revision_source (unpinned by default)", () => {
    const { evidence } = screenEvidence(
      { model: "stub-laya", routing: {} },
      { injection: 0.1, substance: 0.9, relevance: 0.5, missing: [] },
    );
    assert.equal(evidence.revision, null);
    assert.equal(evidence.revision_source, "unpinned");
    assert.equal(evidence.signals[0].revision, null, "signal revision honest null too");
    const made = makeEvidence({ model: "m", routing: { revision: "r9" } }, [], "router");
    assert.equal(made.revision, "r9");
    assert.equal(made.revision_source, "backend");
    const pii = piiEvidence({ findings: [], weakTypes: [] });
    assert.equal(pii.evidence.revision, null);
    assert.equal(pii.evidence.revision_source, "unpinned");
  });
});

await check("env pins win with env:VAR source; blank counts as unset", () => {
  process.env[LAYA_MODEL_REVISION_ENV] = "  pinned-laya-rev  ";
  process.env[GLINER_MODEL_REVISION_ENV] = "";
  try {
    assert.equal(readRevisionEnv(LAYA_MODEL_REVISION_ENV), "pinned-laya-rev", "trimmed verbatim");
    assert.equal(readRevisionEnv(GLINER_MODEL_REVISION_ENV), null, "blank is unset");
    assert.equal(resolveLayaRevision({ model: "m", routing: { revision: "backend-rev" } }), "pinned-laya-rev", "env beats backend");
    assert.equal(layaRevisionSource({ model: "m", routing: { revision: "backend-rev" } }), `env:${LAYA_MODEL_REVISION_ENV}`);
    assert.deepEqual(resolveEnvelopeRevision("laya_screen", "backend-rev"), {
      model_revision: "pinned-laya-rev",
      revision_source: `env:${LAYA_MODEL_REVISION_ENV}`,
    });
    // Gliner blank -> pii still honest null (laya pin must NOT leak into pii).
    assert.deepEqual(resolveEnvelopeRevision("laya_pii", null), {
      model_revision: null,
      revision_source: "unpinned",
    });
    const { evidence } = screenEvidence(
      { model: "m", routing: { revision: "backend-rev" } },
      { injection: 0.1, substance: 0.9, relevance: 0.5, missing: [] },
    );
    assert.equal(evidence.revision, "pinned-laya-rev");
    assert.equal(evidence.revision_source, `env:${LAYA_MODEL_REVISION_ENV}`);
  } finally {
    delete process.env[LAYA_MODEL_REVISION_ENV];
    delete process.env[GLINER_MODEL_REVISION_ENV];
  }
});

await check("gliner pin applies to pii/span paths only", () => {
  process.env[GLINER_MODEL_REVISION_ENV] = "gliner-rev-1";
  try {
    assert.equal(resolveGlinerRevision(), "gliner-rev-1");
    assert.equal(glinerRevisionSource(), `env:${GLINER_MODEL_REVISION_ENV}`);
    const pii = piiEvidence({ findings: [], weakTypes: [] });
    assert.equal(pii.evidence.revision, "gliner-rev-1");
    assert.deepEqual(resolveEnvelopeRevision("laya_pii", null), {
      model_revision: "gliner-rev-1",
      revision_source: `env:${GLINER_MODEL_REVISION_ENV}`,
    });
    // Laya tools ignore the gliner pin.
    assert.deepEqual(resolveEnvelopeRevision("laya_screen", null), {
      model_revision: null,
      revision_source: "unpinned",
    });
  } finally {
    delete process.env[GLINER_MODEL_REVISION_ENV];
  }
});

console.log(`\nT4 offline envelope: ${passed} checks passed (no server involved).`);

// --------------------------------------- Part B+C: live round-trip helpers ---
function stubBackends() {
  const genericAnswer = () => ({ noul: 0.85, choice: "none", probabilities: {}, score: 2 });
  // Compare judges relations, not candidates: its `overall` / `aspect_*`
  // questions need a schema-valid relation choice, otherwise the SDK
  // client itself rejects the structuredContent against the tool's
  // outputSchema (client/index.js validates structured results client-side).
  const compareAnswer = () => ({ noul: 0.85, choice: "same_fact", probabilities: { same_fact: 0.7 }, score: 2 });
  const answerFor = (qid) => (qid === "overall" || /^aspect_\d+_/.test(qid) ? compareAnswer() : genericAnswer());
  const laya = http.createServer((req, res) => {
    if (req.url === "/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ alive: true }));
    } else if (req.url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, loaded: [], failed: [] }));
    } else if (req.url === "/predict" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let questions = {};
        try {
          questions = JSON.parse(raw).questions ?? {};
        } catch {
          questions = {};
        }
        const answers = Object.fromEntries(Object.keys(questions).map((qid) => [qid, answerFor(qid)]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            answers,
            confidence: {},
            routing: {},
            model: "stub-laya",
            latency_ms: 1,
            usage: {},
          }),
        );
      });
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub" }));
    }
  });
  const gliner = http.createServer((req, res) => {
    if (req.url === "/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ alive: true }));
    } else if (req.url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, loaded: [], failed: [] }));
    } else if (req.url === "/pii_scan" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ findings: [], counts: {}, latency_ms: 1 }));
    } else if (req.url === "/extract_entities" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ entities: {}, latency_ms: 1 }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub" }));
    }
  });
  return { laya, gliner };
}

const CALLS = [
  { name: "laya_screen", args: { text: "hello world", purpose: "test" }, primitive: "noul", policy: "screen" },
  { name: "laya_verify", args: { claims: ["sky is blue"], evidence: "the sky is blue today" }, primitive: "noul", policy: "verify" },
  { name: "laya_find", args: { query: "q", candidates: [{ id: "a", text: "alpha beta" }] }, primitive: "choice", policy: "find" },
  { name: "laya_rerank", args: { query: "q", candidates: [{ id: "a", text: "alpha beta" }] }, primitive: "noul", policy: "rerank" },
  {
    name: "laya_classify",
    args: { purpose: "p", items: [{ id: "i", text: "some text" }], classes: [{ id: "c", description: "category" }] },
    primitive: "choice",
    policy: "classify",
  },
  {
    name: "laya_decide",
    args: { decision: "pick", candidates: [{ id: "a", description: "first" }, { id: "b", description: "second" }] },
    primitive: "choice",
    policy: "decide",
  },
  { name: "laya_compare", args: { passage_a: "cats sit", passage_b: "dogs run" }, primitive: "choice", policy: "compare" },
  {
    name: "laya_extract",
    args: { document: "total $29 due", fields: [{ id: "amount", description: "total amount", pattern: "\\$\\d+" }] },
    primitive: "choice",
    policy: "extract",
  },
  { name: "laya_review", args: { request: "fix", diff: "+line" }, primitive: "score", policy: "review" },
  { name: "laya_gate", args: { request: "fix", diff: "+line", claims: ["tests pass"] }, primitive: "score", policy: "gate" },
  { name: "laya_pii", args: { text: "hello world" }, primitive: "spans", policy: "pii" },
];

function checkLiveEnvelope(call, res, { modelRevision = null, revisionSource = "unpinned" } = {}) {
  assert.ok(!res.isError, `${call.name} is not an error: ${JSON.stringify(res).slice(0, 300)}`);
  assert.ok(Array.isArray(res.content) && res.content.length > 0, `${call.name} content non-empty (2024-10-07 compat)`);
  assert.equal(res.content[0].type, "text");
  const text = res.content[0].text;
  assert.ok(typeof text === "string" && text.length > 0, `${call.name} text block intact`);
  const parsed = JSON.parse(text);
  assert.deepStrictEqual(res.structuredContent, parsed, `${call.name} structuredContent == parsed text`);
  assert.match(parsed.decision_id, DECISION_ID_RE, `${call.name} decision_id`);
  assert.ok(!Number.isNaN(Date.parse(parsed.timestamp)), `${call.name} timestamp ISO`);
  assert.equal(parsed.primitive, call.primitive, `${call.name} primitive`);
  assert.equal(parsed.policy, call.policy, `${call.name} policy mirror`);
  assert.equal(parsed.policy_version, "1.0.0", `${call.name} policy_version mirror`);
  assert.deepEqual(parsed.decision.policy, { name: call.policy, version: "1.0.0" }, `${call.name} decision.policy intact`);
  assert.equal(parsed.schema_version, "1.0.0", `${call.name} schema_version`);
  assert.equal(typeof parsed.latency_ms, "number", `${call.name} latency_ms conserved`);
  assert.equal(parsed.model_revision, modelRevision, `${call.name} model_revision`);
  assert.equal(parsed.revision_source, revisionSource, `${call.name} revision_source`);
  assert.equal(parsed.evidence.revision_source, revisionSource, `${call.name} evidence.revision_source agrees`);
  return parsed;
}

async function withServer(extraEnv, fn) {
  const { laya, gliner } = stubBackends();
  await new Promise((r) => laya.listen(0, "127.0.0.1", r));
  await new Promise((r) => gliner.listen(0, "127.0.0.1", r));
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST],
    env: {
      ...process.env,
      ...extraEnv,
      LAYA_URL: `http://127.0.0.1:${laya.address().port}`,
      GLINER_URL: `http://127.0.0.1:${gliner.address().port}`,
      LAYA_HEALTH_INTERVAL_MS: "200",
    },
  });
  const client = new Client({ name: "t4-envelope", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      const listed = await client.listTools();
      if (listed.tools.length === 12) break;
      assert.ok(Date.now() < deadline, `12 tools advertised (got ${listed.tools.length})`);
      await new Promise((r) => setTimeout(r, 300));
    }
    await fn(client);
  } finally {
    await client.close();
    laya.close();
    gliner.close();
  }
}

// Part B: clean env -> honest nulls, stub-laya model (pii model null).
await withServer({ LAYA_MODEL_REVISION: "", GLINER_MODEL_REVISION: "" }, async (client) => {
  const seenIds = new Set();
  for (const call of CALLS) {
    await check(`live ${call.name}: structured == text + metadata`, async () => {
      const res = await client.callTool({ name: call.name, arguments: call.args });
      const parsed = checkLiveEnvelope(call, res);
      if (call.name === "laya_pii") {
        assert.equal(parsed.model, null, "pii has no laya judgment: honest null model");
      } else {
        assert.equal(parsed.model, "stub-laya", `${call.name} model from backend`);
      }
      assert.ok(!seenIds.has(parsed.decision_id), "decision_id unique across calls");
      seenIds.add(parsed.decision_id);
    });
  }
  await check("live unknown tool stays isError without structuredContent", async () => {
    const res = await client.callTool({ name: "laya_nope", arguments: {} });
    assert.ok(res.isError, "unknown tool errors");
    assert.ok(!("structuredContent" in res) || res.structuredContent === undefined, "no structuredContent on errors");
  });
});

// Part C: env pins propagate live (laya pin -> screen, gliner pin -> pii).
await withServer({ LAYA_MODEL_REVISION: "live-laya-pin", GLINER_MODEL_REVISION: "live-gliner-pin" }, async (client) => {
  await check("live screen reports LAYA_MODEL_REVISION pin", async () => {
    const res = await client.callTool({ name: "laya_screen", arguments: { text: "hi", purpose: "t" } });
    const parsed = checkLiveEnvelope(CALLS[0], res, {
      modelRevision: "live-laya-pin",
      revisionSource: `env:${LAYA_MODEL_REVISION_ENV}`,
    });
    assert.equal(parsed.evidence.revision, "live-laya-pin");
  });
  await check("live pii reports GLINER_MODEL_REVISION pin (no laya leakage)", async () => {
    const res = await client.callTool({ name: "laya_pii", arguments: { text: "hi" } });
    const parsed = checkLiveEnvelope(CALLS[10], res, {
      modelRevision: "live-gliner-pin",
      revisionSource: `env:${GLINER_MODEL_REVISION_ENV}`,
    });
    assert.equal(parsed.evidence.revision, "live-gliner-pin");
    assert.equal(parsed.model, null, "pii model stays honest null even when pinned");
  });
});

console.log(`\nT4 ENVELOPE: ${passed} checks passed.`);
