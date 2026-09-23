/**
 * Fase-5 T3 contract tests: typed inputs + outputSchema + tools/list wiring.
 *
 * Part A (offline, no server): every ToolDefinition carries an `outputSchema`
 * {type:"object"} whose `required` keys exist in `properties`, plus honest
 * read-only annotations; a minimal JSON-Schema-subset validator checks that
 * faithful fixtures pass and that missing-required / wrong-type / bad-enum
 * values fail -- for BOTH inputSchema and outputSchema of all 11 tools.
 * Input caps that builders enforce with input_too_large (find/rerank top_k)
 * are mirrored as schema maximums (checked both ways).
 *
 * Part B (live list, stub backend): a stub Laya HTTP server answers
 * GET /live + GET /ready so tools/list advertises 11 tools (10 + T5
 * laya_capabilities; gliner down so no pii);
 * every wire entry must carry outputSchema + annotations, which also proves
 * the payload passes the SDK's own ListToolsResultSchema validation inside
 * client.listTools().
 *
 * Run after build from the repo root: node tests/fase5_t3_contract.mjs
 */
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { screenTool } from "../dist/tools/screen.js";
import { verifyTool } from "../dist/tools/verify.js";
import { findTool } from "../dist/tools/find.js";
import { rerankTool } from "../dist/tools/rerank.js";
import { classifyTool } from "../dist/tools/classify.js";
import { decideTool } from "../dist/tools/decide.js";
import { compareTool } from "../dist/tools/compare.js";
import { extractTool } from "../dist/tools/extract.js";
import { reviewTool } from "../dist/tools/review.js";
import { gateTool } from "../dist/tools/gate.js";
import { piiTool } from "../dist/tools/pii.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist", "index.js");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- Minimal JSON-Schema-subset validator (type/enum/required/properties/
// --- items/minimum/maximum/minItems/maxItems/minLength/maxLength). Enough to
// --- prove the declared schemas mean what they say.
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
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${trail}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${trail}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${trail}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${trail}: longer than maxLength`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${trail}: ${value.length} items < minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${trail}: ${value.length} items > maxItems ${schema.maxItems}`);
    }
    if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${trail}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${trail}: missing required '${k}'`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in value) errors.push(...validate(sub, value[k], `${trail}.${k}`));
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

function without(obj, key) {
  const out = { ...obj };
  delete out[key];
  return out;
}

const decision = (d, name = "p", version = "1.0.0") => ({
  decision: d,
  reason_codes: ["some_reason"],
  policy: { name, version },
});

// Faithful minimal fixtures: every required key present with a plausible
// type (mirrors what each handler's JSON.stringify always emits).
const TOOLS = [
  {
    tool: screenTool,
    validInput: { text: "hello", purpose: "test" },
    validOutput: {
      signals: {
        injection: { signal: 0.1, finding: "no-instruction" },
        substance: { signal: 0.9, finding: "has-substance" },
        relevance: { signal: 0.5, finding: "reported" },
      },
      assessment: "valid",
      decision: decision("ALLOW", "screen"),
      latency_ms: 3,
      evidence: {},
      abstention: {},
      authority_note: "note",
    },
    badOutputEnum: { assessment: "bogus" },
  },
  {
    tool: verifyTool,
    validInput: { claims: ["c"], evidence: "e" },
    validOutput: {
      summary: { supported: 1, insufficient_evidence: 0, contradicted: 0, abstain: 0 },
      verdicts: [{ claim: "c", signal: 0.9, verdict: "SUPPORTED" }],
      decision: decision("ALLOW", "verify"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
  },
  {
    tool: findTool,
    validInput: { query: "q", candidates: [{ id: "a", text: "b" }] },
    validOutput: {
      winner: "a",
      exists: true,
      distribution: { a: 0.8 },
      winner_probability: 0.8,
      decision: decision("ALLOW", "find"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
      pruned: false,
      pruning: { kept: 1, dropped: 0, method: "token-overlap+exact-dedup" },
    },
  },
  {
    tool: rerankTool,
    validInput: { query: "q", candidates: [{ id: "a", text: "b" }] },
    validOutput: {
      ranked: [{ rank: 1, id: "a", relevance_score: 0.8 }],
      truncated: false,
      truncated_ids: [],
      decision: decision("ALLOW", "rerank"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
      pruned: false,
      pruning: { kept: 1, dropped: 0, method: "token-overlap" },
    },
  },
  {
    tool: classifyTool,
    validInput: { purpose: "p", items: [{ id: "i", text: "t" }], classes: [{ id: "c", description: "d" }] },
    validOutput: {
      classifications: [{ id: "i", classification: "c", winner_probability: 0.7 }],
      decision: decision("ALLOW", "classify"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
  },
  {
    tool: decideTool,
    validInput: { decision: "d", candidates: [{ id: "a", description: "x" }, { id: "b", description: "y" }] },
    validOutput: {
      selected: "a",
      distribution: { a: 0.6 },
      winner_probability: 0.6,
      requirements: {},
      decision: decision("ALLOW", "decide"),
      latency_ms: 2,
      evidence: {},
      abstention: {},
    },
  },
  {
    tool: compareTool,
    validInput: { passage_a: "a", passage_b: "b" },
    validOutput: {
      overall: { relation: "same_fact", distribution: { same_fact: 0.7 }, winner_probability: 0.7 },
      decision: decision("ALLOW", "compare"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
  },
  {
    tool: extractTool,
    validInput: { document: "doc $29", fields: [{ id: "f", description: "F", pattern: "\\$\\d+" }] },
    validOutput: {
      results: [{ id: "f", value: "$29", status: "extracted", winner_probability: 0.5, start: 4, end: 7 }],
      source: "entities",
      truncated: false,
      dropped: 0,
      decision: decision("ALLOW", "extract"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    badOutputEnum: { source: "bogus" },
  },
  {
    tool: reviewTool,
    validInput: { request: "r", diff: "d" },
    validOutput: {
      rubric: {
        correctness: { score: 2 },
        spec_match: { score: 2 },
        test_gap: { score: 0 },
        blast_radius: { score: 0 },
        safe_to_apply: { signal: 0.9 },
      },
      decision: decision("ALLOW", "review"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
  },
  {
    tool: gateTool,
    validInput: { request: "r", diff: "d", claims: ["c"] },
    validOutput: {
      review: {
        correctness: { score: 2 },
        spec_match: { score: 1 },
        safe_to_apply: { signal: 0.9 },
      },
      claims: [{ claim: "c", signal: 0.9, verdict: "SUPPORTED" }],
      decision: decision("ALLOW", "gate"),
      context: { claim_count: 1 },
      risk: "normal",
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    badOutputEnum: { risk: "extreme" },
  },
  {
    tool: piiTool,
    validInput: { text: "hello" },
    validOutput: {
      pipeline: {
        stages: ["gliner", "laya_risk", "policy"],
        gliner_spans: 0,
        laya_judged: false,
        laya_note: "n",
        policy: { name: "pii", version: "1.0.0" },
      },
      findings: [],
      counts: {},
      secrets_found: 0,
      decision: decision("ALLOW", "pii"),
      latency_ms: 1,
      recommendation: "r",
      evidence: {},
      abstention: {},
    },
  },
];

// --- Part A: offline schema checks, table-driven over all 11 tools.
for (const { tool, validInput, validOutput, badOutputEnum } of TOOLS) {
  check(`${tool.name} outputSchema is type:object with required ⊆ properties`, () => {
    assert.equal(tool.outputSchema?.type, "object", "top type");
    assert.ok(Array.isArray(tool.outputSchema?.required) && tool.outputSchema.required.length > 0, "non-empty required");
    for (const k of tool.outputSchema.required) {
      assert.ok(tool.outputSchema.properties?.[k] !== undefined, `required '${k}' declared in properties`);
    }
  });

  check(`${tool.name} annotations are read-only and honest`, () => {
    assert.equal(tool.annotations?.readOnlyHint, true, "readOnlyHint");
    assert.equal(tool.annotations?.destructiveHint, false, "destructiveHint");
    assert.equal(tool.annotations?.idempotentHint, true, "idempotentHint");
  });

  check(`${tool.name} accepts its faithful output envelope`, () => {
    assertValid(tool.outputSchema, validOutput, "valid output");
  });

  check(`${tool.name} outputSchema requires the required, rejects wrong types`, () => {
    const first = tool.outputSchema.required[0];
    assertInvalid(tool.outputSchema, without(validOutput, first), `missing '${first}'`);
    assertInvalid(tool.outputSchema, { ...validOutput, latency_ms: "fast" }, "latency_ms as string");
    if (badOutputEnum) {
      const [k, v] = Object.entries(badOutputEnum)[0];
      assertInvalid(tool.outputSchema, { ...validOutput, [k]: v }, `bad enum ${k}=${v}`);
    }
  });

  check(`${tool.name} inputSchema accepts minimal input, rejects missing/wrong types`, () => {
    assertValid(tool.inputSchema, validInput, "valid input");
    assertInvalid(tool.inputSchema, {}, "empty input");
    const firstRequired = tool.inputSchema.required[0];
    assertInvalid(tool.inputSchema, without(validInput, firstRequired), `missing '${firstRequired}'`);
    assertInvalid(tool.inputSchema, { ...validInput, [firstRequired]: 42 }, `'${firstRequired}' as number`);
  });
}

// Optional-but-shaped outputs stay optional; nullable outputs stay nullable.
check("verify summary optional; empty-claims ABSTAIN shape passes", () => {
  const { summary, ...rest } = TOOLS[1].validOutput;
  void summary;
  assertValid(verifyTool.outputSchema, { ...rest, verdicts: [] }, "no summary");
});

check("compare relation optional (missing answer); aspect keys free-form", () => {
  assertValid(
    compareTool.outputSchema,
    {
      overall: { distribution: {}, winner_probability: null },
      price: { relation: "contradicts", distribution: {}, winner_probability: 0.4 },
      decision: decision("ALLOW", "compare"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    "overall without relation + one aspect",
  );
  assertInvalid(
    compareTool.outputSchema,
    {
      overall: { relation: "nope", distribution: {}, winner_probability: 0.4 },
      decision: decision("ALLOW", "compare"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    "bad relation enum",
  );
});

check("decide selected nullable (abstained pick)", () => {
  assertValid(
    decideTool.outputSchema,
    { ...TOOLS[5].validOutput, selected: null, winner_probability: null },
    "null selection",
  );
});

// Input caps the builders enforce with input_too_large are mirrored in schema.
check("find top_k maximum mirrors builder (251 rejected both ways)", () => {
  const base = { query: "q", candidates: [{ id: "a", text: "b" }] };
  assertValid(findTool.inputSchema, { ...base, top_k: 5 }, "top_k 5 schema-ok");
  assertInvalid(findTool.inputSchema, { ...base, top_k: 251 }, "top_k 251 schema-rejected");
  assert.throws(() => findTool.buildQuestions({ ...base, top_k: 251 }), /input_too_large/, "builder rejects too");
});

check("rerank top_k maximum mirrors builder (65 rejected both ways)", () => {
  const base = { query: "q", candidates: [{ id: "a", text: "b" }] };
  assertValid(rerankTool.inputSchema, { ...base, top_k: 5 }, "top_k 5 schema-ok");
  assertInvalid(rerankTool.inputSchema, { ...base, top_k: 65 }, "top_k 65 schema-rejected");
  assert.throws(() => rerankTool.buildQuestions({ ...base, top_k: 65 }), /input_too_large/, "builder rejects too");
});

check("extract source + gate risk enums reject unknown values", () => {
  assertInvalid(extractTool.inputSchema, { document: "d", fields: [], source: "bogus" }, "bad source");
  assertInvalid(
    gateTool.inputSchema,
    { request: "r", diff: "d", claims: ["c"], risk: "extreme" },
    "bad risk",
  );
});

check("decide candidates minItems 2 enforced in schema", () => {
  assertInvalid(decideTool.inputSchema, { decision: "d", candidates: [{ id: "a" }] }, "single candidate");
});

console.log(`\nT3 offline contract: ${passed} checks passed (no server involved).`);

// --- Part B: tools/list publishes outputSchema + annotations (stub backend).
async function stubLaya() {
  const server = http.createServer((req, res) => {
    if (req.url === "/live") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ alive: true }));
    } else if (req.url === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ready: true, loaded: [], failed: [] }));
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "stub" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const stub = await stubLaya();
const stubUrl = `http://127.0.0.1:${stub.address().port}`;
const transport = new StdioClientTransport({
  command: "node",
  args: [DIST],
  env: {
    ...process.env,
    LAYA_URL: stubUrl,
    GLINER_URL: "http://127.0.0.1:9",
    LAYA_HEALTH_INTERVAL_MS: "200",
  },
});
const client = new Client({ name: "t3-contract", version: "0" }, { capabilities: {} });
await client.connect(transport);

try {
  let tools = [];
  const deadline = Date.now() + 20000;
  // Fase-5 T5: wait for the FULL list, not the first non-empty one -- the
  // capabilities exemption means a transient 1-tool list ([laya_capabilities]
  // while the watcher still probes) precedes the steady 11-tool list.
  while (Date.now() < deadline) {
    const res = await client.listTools();
    if (res.tools.length === 11) {
      tools = res.tools;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.equal(tools.length, 11, `11 tools advertised with stub laya up, gliner down (got ${tools.length})`);
  passed++;
  console.log("ok - tools/list advertises 11 tools against stub backend (fase-5 T5: 10 + laya_capabilities)");
  for (const t of tools) {
    assert.equal(t.outputSchema?.type, "object", `${t.name} wire outputSchema type`);
    assert.ok(
      Array.isArray(t.outputSchema?.required) && t.outputSchema.required.length > 0,
      `${t.name} wire outputSchema required`,
    );
    for (const k of t.outputSchema.required) {
      assert.ok(t.outputSchema.properties?.[k] !== undefined, `${t.name} wire required '${k}' in properties`);
    }
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} wire annotations.readOnlyHint`);
    assert.equal(t.inputSchema?.type, "object", `${t.name} wire inputSchema type`);
  }
  passed++;
  console.log("ok - every wire tool carries outputSchema + read-only annotations (SDK-validated)");
} finally {
  await client.close();
  stub.close();
}

console.log(`\nT3 CONTRACT: ${passed} checks passed.`);
