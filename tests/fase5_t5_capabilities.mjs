/**
 * Fase-5 T5 capabilities + schema_version tests.
 *
 * Part A (offline, no server): the capabilities definition (name, observe
 * description, explicit inputSchema, outputSchema with required ⊆
 * properties, read-only annotations), the envelopeMetadataProperties
 * fragment (covers every augmentEnvelope key; primitive admits null for
 * the observe tool), feature derivation guards (top_k/pruning re-derived
 * from schemas, two_stage/structured/revision code facts re-checked),
 * servableTools with/without gliner, and the SCHEMA_VERSION_POLICY
 * classifier (every breaking flag -> major, additive-only -> minor).
 *
 * Part B (live, stub backends): laya_capabilities via MCP client.callTool
 * reports the stub /models+/ready inventory verbatim (honest null
 * revisions), real gliner state, primitives/tools/policies/features, mode
 * "observe" and schema_version "1.0.0"; structuredContent deep-equals the
 * parsed text -- succeeding through client.callTool PROVES it validates
 * against the tool's outputSchema (the SDK client itself rejects mismatches
 * with -32602). timeout_ms arg honored; out-of-range rejected isError.
 * Glider-down variant: call still succeeds, pii absent, reachable:false.
 *
 * Part C (laya down): tools/list advertises ONLY laya_capabilities (T5
 * exemption) and its call fails isError with the backend diagnosis and no
 * structuredContent.
 *
 * Run after build from the repo root: node tests/fase5_t5_capabilities.mjs
 */
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  capabilitiesTool,
  buildFeatures,
  topKTools,
  pruningTools,
  servableTools,
  CAPABILITIES_DEFAULT_TIMEOUT_MS,
} from "../dist/tools/capabilities.js";
import { FIND_PRUNE_METHOD } from "../dist/tools/find.js";
import { RERANK_PRUNE_METHOD } from "../dist/tools/rerank.js";
import { decideTool } from "../dist/tools/decide.js";
import { screenTool } from "../dist/tools/screen.js";
import { verifyTool } from "../dist/tools/verify.js";
import { findTool } from "../dist/tools/find.js";
import { rerankTool } from "../dist/tools/rerank.js";
import { classifyTool } from "../dist/tools/classify.js";
import { compareTool } from "../dist/tools/compare.js";
import { extractTool } from "../dist/tools/extract.js";
import { reviewTool } from "../dist/tools/review.js";
import { gateTool } from "../dist/tools/gate.js";
import { piiTool } from "../dist/tools/pii.js";
import { envelopeMetadataProperties } from "../dist/tool.js";
import {
  ENVELOPE_SCHEMA_VERSION,
  TOOL_PRIMITIVES,
  augmentEnvelope,
  buildCallResult,
  classifyContractChange,
} from "../dist/envelope.js";
import { resolveEnvelopeRevision } from "../dist/envelope.js";
import { listPolicies } from "../dist/policy/loader.js";

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

// --- Minimal JSON-Schema-subset validator (type/integer/enum/required/
// --- properties/items/minimum/maximum/additionalProperties). Mirrors the
// --- T3 validator plus the keywords the capabilities schemas use.
function checkType(t, v) {
  const ts = Array.isArray(t) ? t : [t];
  return ts.some((one) => {
    if (one === "null") return v === null;
    if (one === "integer") return typeof v === "number" && Number.isInteger(v);
    if (one === "number") return typeof v === "number";
    if (one === "string") return typeof v === "string";
    if (one === "boolean") return typeof v === "boolean";
    if (one === "array") return Array.isArray(v);
    if (one === "object") return typeof v === "object" && v !== null && !Array.isArray(v);
    return false;
  });
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function validate(schema, value, trail = "$") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;
  if (schema.type !== undefined && !checkType(schema.type, value)) {
    errors.push(`${trail}: expected ${JSON.stringify(schema.type)}, got ${typeName(value)}`);
    return errors;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${trail}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${trail}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${trail}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${trail}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${trail}: missing required '${k}'`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) errors.push(...validate(sub, value[k], `${trail}.${k}`));
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(value)) {
        if (!(k in (schema.properties ?? {}))) errors.push(`${trail}: unexpected property '${k}'`);
      }
    }
  }
  return errors;
}

function assertValid(schema, value, msg) {
  const errs = validate(schema, value);
  assert.deepEqual(errs, [], `${msg}: ${errs.join("; ")}`);
}

function assertInvalid(schema, value, msg) {
  const errs = validate(schema, value);
  assert.ok(errs.length > 0, `${msg}: expected rejection, got none`);
}

// ---------------------------------------------------------- Part A: unit ---
await check("capabilities definition: name, observe docs, explicit input", () => {
  assert.equal(capabilitiesTool.name, "laya_capabilities");
  assert.match(capabilitiesTool.description, /observe/i, "mode documented");
  assert.match(capabilitiesTool.description, /never executes|never.*mutat/i, "observe meaning documented");
  assert.match(capabilitiesTool.description, /isError/, "down-backend behaviour documented");
  assert.equal(capabilitiesTool.inputSchema?.type, "object");
  assert.equal(capabilitiesTool.inputSchema?.additionalProperties, false);
  assert.equal(capabilitiesTool.inputSchema?.properties?.timeout_ms?.type, "integer");
  assert.equal(capabilitiesTool.inputSchema?.properties?.timeout_ms?.minimum, 100);
  assert.equal(capabilitiesTool.inputSchema?.properties?.timeout_ms?.maximum, 30000);
  assert.equal(CAPABILITIES_DEFAULT_TIMEOUT_MS, 2000);
  assertValid(capabilitiesTool.inputSchema, {}, "empty args valid (timeout optional)");
  assertValid(capabilitiesTool.inputSchema, { timeout_ms: 500 }, "in-range timeout valid");
  assertInvalid(capabilitiesTool.inputSchema, { timeout_ms: 5 }, "below-minimum timeout rejected");
  assertInvalid(capabilitiesTool.inputSchema, { timeout_ms: "fast" }, "non-integer timeout rejected");
  assertInvalid(capabilitiesTool.inputSchema, { bogus: 1 }, "unknown arg rejected");
});

await check("capabilities outputSchema: required ⊆ properties, readonly, envelope optional", () => {
  const out = capabilitiesTool.outputSchema;
  assert.equal(out?.type, "object");
  for (const k of out.required) assert.ok(out.properties?.[k] !== undefined, `required '${k}' declared`);
  for (const k of ["models", "backend", "gliner", "primitives", "tools", "policies", "features", "mode", "schema_version", "latency_ms"]) {
    assert.ok(out.required.includes(k), `handler key '${k}' required`);
  }
  // Envelope keys are documented but (except the handler-emitted
  // schema_version) NOT required: stored pre-T5 outputs must keep
  // validating (minor-version promise).
  for (const k of Object.keys(envelopeMetadataProperties())) {
    assert.ok(out.properties?.[k] !== undefined, `envelope key '${k}' described`);
    if (k !== "schema_version") assert.ok(!out.required.includes(k), `envelope key '${k}' not required`);
  }
  assert.equal(out.properties?.mode?.enum?.length, 1, "mode enum is exactly [observe]");
  assert.equal(capabilitiesTool.annotations?.readOnlyHint, true);
  assert.equal(capabilitiesTool.annotations?.destructiveHint, false);
  assert.equal(capabilitiesTool.annotations?.idempotentHint, true);
});

await check("fragment covers augmentEnvelope; observe tool gets honest nulls", () => {
  const frag = envelopeMetadataProperties();
  // Fase-6 T4 intentional evolution (minor-additive): eleven T3 keys plus
  // effective_mode. Still all OPTIONAL (required lists untouched), so
  // stored pre-T4 outputs keep validating -- only this count moves.
  assert.equal(Object.keys(frag).length, 12, "twelve envelope keys (eleven T3 + effective_mode T4)");
  const probe = { decision: { decision: "ALLOW", reason_codes: ["r"], policy: { name: "screen", version: "1.0.0" } }, latency_ms: 1, evidence: { model: "m", revision: null } };
  const savedLaya = process.env.LAYA_MODEL_REVISION;
  const savedGliner = process.env.GLINER_MODEL_REVISION;
  delete process.env.LAYA_MODEL_REVISION;
  delete process.env.GLINER_MODEL_REVISION;
  try {
    // T3 trace context passed (index.ts always passes one live); without
    // it the envelope carries no trace keys (back-compat, see T3 tests).
    const augmented = augmentEnvelope("laya_screen", probe, { trace_id: "a".repeat(32), span_id: "b".repeat(16) });
    for (const k of Object.keys(frag)) assert.ok(k in augmented, `augmented carries '${k}'`);
    assert.equal(augmented.schema_version, "1.0.0");
    assert.equal(ENVELOPE_SCHEMA_VERSION, "1.0.0");
    // The observe tool judges nothing: primitive/policy/model honest nulls.
    const res = buildCallResult("laya_capabilities", JSON.stringify({ latency_ms: 2 }));
    assert.deepStrictEqual(res.structuredContent, JSON.parse(res.content[0].text), "same object in text+structured");
    const meta = res.structuredContent;
    assert.equal(meta.primitive, null, "capabilities primitive null (judges nothing)");
    assert.equal(meta.policy, null, "capabilities policy null (no decision)");
    assert.equal(meta.policy_version, null);
    assert.equal(meta.model, null, "capabilities model null (no judgment)");
    assert.equal(meta.model_revision, null);
    assert.equal(meta.revision_source, "unpinned");
    assertValid(
      { type: "object", properties: frag },
      {
        decision_id: meta.decision_id, timestamp: meta.timestamp, model: meta.model,
        model_revision: meta.model_revision, revision_source: meta.revision_source,
        primitive: meta.primitive, policy: meta.policy,
        policy_version: meta.policy_version, schema_version: meta.schema_version,
      },
      "observe-tool envelope validates against the fragment (nulls admitted)",
    );
    assertInvalid({ type: "object", properties: frag }, { primitive: "bogus" }, "bad primitive rejected");
  } finally {
    if (savedLaya !== undefined) process.env.LAYA_MODEL_REVISION = savedLaya;
    if (savedGliner !== undefined) process.env.GLINER_MODEL_REVISION = savedGliner;
  }
});

await check("judgment outputSchemas carry the envelope fragment as optional", () => {
  const judgment = [screenTool, verifyTool, findTool, rerankTool, classifyTool, decideTool, compareTool, extractTool, reviewTool, gateTool, piiTool];
  for (const t of judgment) {
    for (const k of Object.keys(envelopeMetadataProperties())) {
      assert.ok(t.outputSchema.properties?.[k] !== undefined, `${t.name} describes envelope key '${k}' (T4 gap closed)`);
      assert.ok(!t.outputSchema.required.includes(k), `${t.name} keeps '${k}' optional (pre-T5 outputs still validate)`);
    }
  }
});
await check("features derived from code, not invented", () => {
  assert.deepEqual(topKTools(), ["laya_find", "laya_rerank", "laya_extract"], "top_k from inputSchemas");
  assert.deepEqual(pruningTools(), ["laya_find", "laya_rerank"], "pruning from outputSchemas");
  const f = buildFeatures();
  assert.deepEqual(f.two_stage.tools, ["laya_decide"]);
  assert.match(decideTool.description, /[Ss]tage 1.*[Ss]tage 2|second call/, "decide two-stage documented at the source");
  assert.deepEqual(f.pruning.methods, { laya_find: FIND_PRUNE_METHOD, laya_rerank: RERANK_PRUNE_METHOD });
  assert.equal(FIND_PRUNE_METHOD, "token-overlap+exact-dedup");
  assert.equal(RERANK_PRUNE_METHOD, "token-overlap");
  assert.deepEqual(
    f.structured,
    {
      structured_content: true, output_schema: true, text_compat: true,
      note: f.structured.note,
    },
    "structured flags true",
  );
  for (const t of [screenTool, verifyTool, findTool, rerankTool, classifyTool, decideTool, compareTool, extractTool, reviewTool, gateTool, piiTool, capabilitiesTool]) {
    assert.equal(t.outputSchema?.type, "object", `${t.name} declares outputSchema (structured claim real)`);
  }
  assert.deepEqual(f.revision.sources, ["env:LAYA_MODEL_REVISION", "env:GLINER_MODEL_REVISION", "backend", "unpinned"]);
  assert.equal(resolveEnvelopeRevision("laya_screen", null).revision_source, "unpinned");
  assert.equal(resolveEnvelopeRevision("laya_screen", "r1").revision_source, "backend");
});

await check("servableTools mirrors the list advertisement (pii iff gliner)", () => {
  const names = (ts) => ts.map((t) => t.name);
  assert.deepEqual(names(servableTools(false)), [
    "laya_screen", "laya_verify", "laya_find", "laya_rerank", "laya_classify",
    "laya_decide", "laya_compare", "laya_extract", "laya_review", "laya_gate",
    "laya_capabilities",
  ]);
  assert.deepEqual(names(servableTools(true)).length, 12);
  assert.ok(names(servableTools(true)).includes("laya_pii"), "pii served when gliner ready");
  for (const t of Object.keys(TOOL_PRIMITIVES)) {
    assert.ok(["noul", "choice", "score", "spans"].includes(TOOL_PRIMITIVES[t]), `${t} primitive known`);
  }
});

await check("versioning policy: breaking -> major, additive-only -> minor", () => {
  for (const breaking of [{ removesTextBlock: true }, { renamesField: true }, { addsRequired: true }, { removesOrNarrows: true }, { tightensInput: true }]) {
    assert.equal(classifyContractChange(breaking), "major", JSON.stringify(breaking));
  }
  assert.equal(
    classifyContractChange({ addsRequired: true, addsTool: true, addsOptionalKey: true }),
    "major",
    "one breaking flag poisons additive flags",
  );
  for (const additive of [{ addsOptionalKey: true }, { addsTool: true }, { addsPolicy: true }, { addsOptionalParam: true }, {}]) {
    assert.equal(classifyContractChange(additive), "minor", JSON.stringify(additive));
  }
  // T5 itself is minor-class: a new tool + optional envelope properties.
  assert.equal(classifyContractChange({ addsTool: true, addsOptionalKey: true }), "minor", "T5 change class");
});

await check("policy registry source truth for policies[]", () => {
  const policies = listPolicies();
  assert.ok(policies.length >= 11, `registry covers all tools (${policies.length})`);
  for (const p of policies) {
    assert.equal(typeof p.name, "string");
    assert.equal(typeof p.version, "string");
  }
  assert.ok(policies.some((p) => p.name === "screen" && p.version === "1.0.0"), "screen@1.0.0 registered");
  assert.ok(policies.some((p) => p.name === "pii" && p.version === "1.0.0"), "pii@1.0.0 registered");
});

console.log(`\nT5 offline capabilities: ${passed} checks passed (no server involved).`);

// -------------------------------------------- Part B+C: live stub backends ---
const STUB_LAYA_MODELS = [
  { name: "english", repo: "org/laya-english", loaded: true, revision: null, revision_source: "unpinned", device: "cpu", circuit: "closed" },
  { name: "multilingual", repo: "org/laya-multi", loaded: false, revision: null, revision_source: "unpinned", device: "cpu", circuit: "closed" },
];
const STUB_GLINER_MODELS = [
  { name: "gliner-pii", repo: "org/gliner-pii", loaded: true, revision: null, revision_source: "unpinned", device: "cpu", circuit: "closed" },
];

function stubBackends() {
  const laya = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/live") return json(200, { alive: true, service: "laya-server", version: "0.4.0" });
    if (req.url === "/ready") {
      return json(200, {
        ready: true, reason: null, loaded: ["english"], failed: [],
        device: "cpu", versions: { "laya-server": "0.4.0" }, circuit: "closed",
      });
    }
    if (req.url === "/models") return json(200, { models: STUB_LAYA_MODELS });
    return json(404, { error: "stub" });
  });
  const gliner = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/live") return json(200, { alive: true, service: "gliner-server" });
    if (req.url === "/ready") return json(200, { ready: true, reason: null, loaded: ["gliner-pii"], failed: [], device: "cpu" });
    if (req.url === "/models") return json(200, { models: STUB_GLINER_MODELS });
    return json(404, { error: "stub" });
  });
  return { laya, gliner };
}

async function withServer({ layaPort, glinerPort, extraEnv = {} }, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST],
    env: {
      ...process.env,
      ...extraEnv,
      LAYA_MODEL_REVISION: "",
      GLINER_MODEL_REVISION: "",
      LAYA_URL: `http://127.0.0.1:${layaPort}`,
      GLINER_URL: `http://127.0.0.1:${glinerPort}`,
      LAYA_HEALTH_INTERVAL_MS: "200",
    },
  });
  const client = new Client({ name: "t5-capabilities", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function waitForList(client, wantLength, label) {
  const deadline = Date.now() + 20000;
  for (;;) {
    const listed = await client.listTools();
    if (listed.tools.length === wantLength) return listed.tools;
    assert.ok(Date.now() < deadline, `${label}: ${wantLength} tools (got ${listed.tools.length})`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

function checkCapabilitiesEnvelope(res, { expectTools, expectGlinerReachable }) {
  assert.ok(!res.isError, `capabilities succeeds: ${JSON.stringify(res).slice(0, 200)}`);
  assert.equal(res.content[0].type, "text");
  const parsed = JSON.parse(res.content[0].text);
  assert.deepStrictEqual(res.structuredContent, parsed, "structuredContent == parsed text (SDK-validated)");
  // Live backend inventory, verbatim with honest nulls.
  assert.deepStrictEqual(parsed.models, STUB_LAYA_MODELS, "models mirror stub /models");
  assert.equal(parsed.backend.ready, true);
  assert.deepStrictEqual(parsed.backend.loaded, ["english"]);
  assert.equal(parsed.backend.device, "cpu");
  assert.equal(parsed.gliner.reachable, expectGlinerReachable);
  // Primitives derived from the registry truth.
  assert.equal(parsed.primitives.length, 4);
  const byName = Object.fromEntries(parsed.primitives.map((p) => [p.name, p.tools]));
  assert.ok(byName.noul.includes("laya_screen"), "noul covers screen");
  assert.ok(byName.choice.includes("laya_find"), "choice covers find");
  assert.ok(byName.score.includes("laya_review"), "score covers review");
  assert.deepStrictEqual(byName.spans, ["laya_pii"], "spans is pii only");
  // Servable tools + summarized contracts.
  assert.equal(parsed.tools.length, expectTools);
  const toolNames = parsed.tools.map((t) => t.name);
  assert.ok(toolNames.includes("laya_capabilities"), "self listed");
  assert.equal(toolNames.includes("laya_pii"), expectGlinerReachable, "pii iff gliner");
  for (const t of parsed.tools) {
    assert.deepEqual(Object.keys(t).sort(), ["description", "input_required", "name", "output_required", "primitive"].sort(), `${t.name} summary keys`);
  }
  const self = parsed.tools.find((t) => t.name === "laya_capabilities");
  assert.equal(self.primitive, null, "observe tool primitive null even in its own report");
  // Registry + features + mode + versioning.
  assert.deepStrictEqual(parsed.policies, listPolicies(), "policies == registry");
  assert.deepStrictEqual(parsed.features.top_k.tools, ["laya_find", "laya_rerank", "laya_extract"]);
  assert.deepStrictEqual(parsed.features.pruning.tools, ["laya_find", "laya_rerank"]);
  assert.deepStrictEqual(parsed.features.pruning.methods, { laya_find: "token-overlap+exact-dedup", laya_rerank: "token-overlap" });
  assert.deepStrictEqual(parsed.features.two_stage.tools, ["laya_decide"]);
  assert.equal(parsed.features.structured.structured_content, true);
  assert.equal(parsed.features.structured.output_schema, true);
  assert.equal(parsed.features.structured.text_compat, true);
  assert.equal(parsed.features.revision.model_revision, true);
  assert.equal(parsed.mode, "observe");
  assert.equal(parsed.schema_version, "1.0.0");
  assert.equal(typeof parsed.latency_ms, "number");
  // T4 envelope augmentation also applies to the meta tool (honest nulls).
  assert.match(parsed.decision_id, /^dec_[0-9a-f]{16}$/, "decision_id stamped");
  assert.ok(!Number.isNaN(Date.parse(parsed.timestamp)), "timestamp stamped");
  assert.equal(parsed.model, null);
  assert.equal(parsed.policy, null);
  assert.equal(parsed.primitive, null);
  return parsed;
}

const { laya, gliner } = stubBackends();
await new Promise((r) => laya.listen(0, "127.0.0.1", r));
await new Promise((r) => gliner.listen(0, "127.0.0.1", r));
const layaPort = laya.address().port;
const glinerPort = gliner.address().port;
const DEAD_PORT = 9;

try {
  await withServer({ layaPort, glinerPort }, async (client) => {
    await check("live list advertises 12 tools (11+pii+capabilities, SDK-validated)", async () => {
      const tools = await waitForList(client, 12, "both backends up");
      const cap = tools.find((t) => t.name === "laya_capabilities");
      assert.ok(cap, "capabilities advertised");
      assert.equal(cap.outputSchema?.type, "object");
      assert.equal(cap.annotations?.readOnlyHint, true);
    });
    await check("live capabilities: real models/policies/features, observe mode, structured==text", async () => {
      const res = await client.callTool({ name: "laya_capabilities", arguments: {} });
      const parsed = checkCapabilitiesEnvelope(res, { expectTools: 12, expectGlinerReachable: true });
      assert.deepStrictEqual(parsed.gliner.models, STUB_GLINER_MODELS, "gliner models verbatim");
      assert.equal(parsed.gliner.ready, true);
      // Explicit schema fit on top of the SDK's own -32602 validation.
      assertValid(capabilitiesTool.outputSchema, parsed, "structured fits outputSchema");
    });
    await check("live capabilities honors timeout_ms; rejects out-of-range isError", async () => {
      const ok = await client.callTool({ name: "laya_capabilities", arguments: { timeout_ms: 500 } });
      assert.ok(!ok.isError, "in-range timeout succeeds");
      const bad = await client.callTool({ name: "laya_capabilities", arguments: { timeout_ms: 5 } });
      assert.ok(bad.isError, "out-of-range timeout isError");
      assert.ok(!("structuredContent" in bad) || bad.structuredContent === undefined, "no structuredContent on errors");
      assert.match(bad.content[0].text, /invalid_argument/, "invalid_argument vocabulary");
    });
  });

  await withServer({ layaPort, glinerPort: DEAD_PORT }, async (client) => {
    await check("gliner down: capabilities succeeds, pii absent, reachable:false", async () => {
      const tools = await waitForList(client, 11, "laya up, gliner down");
      assert.ok(!tools.some((t) => t.name === "laya_pii"), "pii not advertised");
      const res = await client.callTool({ name: "laya_capabilities", arguments: {} });
      checkCapabilitiesEnvelope(res, { expectTools: 11, expectGlinerReachable: false });
      assert.deepStrictEqual(JSON.parse(res.content[0].text).gliner.models, [], "gliner models [] when down");
    });
  });

  await withServer({ layaPort: DEAD_PORT, glinerPort }, async (client) => {
    await check("laya down: list advertises ONLY laya_capabilities (T5 exemption)", async () => {
      const tools = await waitForList(client, 1, "laya down");
      assert.deepStrictEqual(tools.map((t) => t.name), ["laya_capabilities"]);
      assert.equal(tools[0].outputSchema?.type, "object", "exempted entry carries its schema");
    });
    await check("laya down: capabilities call fails isError with the diagnosis", async () => {
      const res = await client.callTool({ name: "laya_capabilities", arguments: {} });
      assert.ok(res.isError, "backend-down call isError");
      assert.ok(!("structuredContent" in res) || res.structuredContent === undefined, "no structuredContent on errors");
      assert.match(res.content[0].text, /laya-server/, "diagnosis names the backend");
    });
  });
} finally {
  laya.close();
  gliner.close();
}

console.log(`\nT5 CAPABILITIES: ${passed} checks passed.`);
