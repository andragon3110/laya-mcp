/**
 * Fase-5 T6 contract-gap tests: ONLY the gaps left by the T3/T4/T5 batteries
 * (verified by grep over tests/fase5_*.mjs -- nothing below re-asserts what
 * those files already prove).
 *
 * Sec-8 mapping (schema validation, MCP contract, structured output,
 * backward compat, invalid input, malformed output):
 *
 *   schema validation .... T3 proves required-subset/properties, faithful
 *                          fixtures, missing-required/wrong-type/bad-enum and
 *                          input-cap mirroring for all 11 tools. GAP HERE
 *                          (Part A2): NEGATIVES the handlers never emit --
 *                          nested bad enums, null-vs-object swaps, dropped
 *                          nested required keys, array/object confusions --
 *                          two per tool for all 12 tools (capabilities incl).
 *   MCP contract ......... T3 proves tools/list publishes outputSchema +
 *                          annotations (SDK-validated); T5 proves the
 *                          capabilities list/call contract incl. the laya-down
 *                          exemption ([laya_capabilities]) and the gliner-down
 *                          degradation. No gap: not re-tested here.
 *   structured output .... T4 proves same-object text==structured for the 11
 *                          judgment tools (offline + live) and T5 proves it
 *                          for laya_capabilities -- each live success through
 *                          the real SDK client ALSO proves outputSchema fit
 *                          (the client itself rejects mismatches with
 *                          -32602). GAP HERE (Part B1): the 12-tool sweep in
 *                          ONE place, read through an OLD-client lens (see
 *                          backward compat).
 *   backward compat ...... GAP HERE (Parts A1 + B1): an old client reads ONLY
 *                          content[0].text. Offline (A1) every faithful
 *                          pre-Fase-5 payload round-trips through
 *                          buildCallResult and strips back to itself
 *                          byte-identically (deep-equal after removing exactly
 *                          the nine known envelope keys -- no surprise keys).
 *                          Live (B1) every tool's parsed text still carries
 *                          every handler-era key and adds ONLY those nine.
 *                          List-sin-Laya == [laya_capabilities] is T5 Part C
 *                          + tests/test_tools_offline.sh (updated in 1383c9e,
 *                          expectation already correct -- no edit needed).
 *   invalid input ........ GAP HERE (Part B2): per judgment tool, malformed
 *                          args over the REAL wire. Every case must RESOLVE
 *                          to isError with the structured builder vocabulary
 *                          (input_too_large / risk validation) and NO
 *                          structuredContent -- never a raw throw/rejection
 *                          to the wire. (Capabilities invalid timeout is T5;
 *                          not repeated.)
 *   malformed output ..... T4 proves buildCallResult degrades on garbage/
 *                          non-object text. GAP HERE (Part A3): the same at
 *                          DISPATCH level with test-only fake broken handlers
 *                          (garbage text, JSON-array text, throwing handler --
 *                          injected in this file, never in src/): text is
 *                          preserved without structuredContent, throws become
 *                          isError JSON, everything stays JSON-serializable.
 *
 * Stubs/fakes only; no models, no GPU, no pip. Uses the real SDK Client so
 * structured-vs-outputSchema validation (-32602) stays armed on every live
 * call: a mismatch would reject the call and fail the battery loudly.
 *
 * Run after build from the repo root: node tests/fase5_t6_contract_gaps.mjs
 */
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildCallResult } from "../dist/envelope.js";
import { envelopeMetadataProperties } from "../dist/tool.js";
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
import { capabilitiesTool } from "../dist/tools/capabilities.js";

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

// --- JSON-Schema-subset validator (union of the T3 + T5 validators: the
// --- outputSchemas use type/enum/required/properties/items/minimum/maximum/
// --- minItems/maxItems/minLength/maxLength/additionalProperties).
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
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${trail}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${trail}: longer than maxLength`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${trail}: fewer than minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${trail}: more than maxItems`);
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

// --- Faithful pre-Fase-5 payloads: exactly what each handler's
// --- JSON.stringify emitted before the envelope augmentation (mirrors the T3
// --- fixtures; the capabilities one mirrors handleCapabilities' report).
const decision = (d, name = "p", version = "1.0.0") => ({
  decision: d,
  reason_codes: ["some_reason"],
  policy: { name, version },
});

const FIXTURES = [
  {
    tool: screenTool,
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
    negatives: [
      ["nested bad decision enum", (o) => ({ ...o, decision: { ...o.decision, decision: "MAYBE" } })],
      ["signals null (handler always emits the object)", (o) => ({ ...o, signals: null })],
    ],
  },
  {
    tool: verifyTool,
    validOutput: {
      summary: { supported: 1, insufficient_evidence: 0, contradicted: 0, abstain: 0 },
      verdicts: [{ claim: "c", signal: 0.9, verdict: "SUPPORTED" }],
      decision: decision("ALLOW", "verify"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    negatives: [
      ["verdict item missing its verdict", (o) => ({ ...o, verdicts: [{ claim: "c", signal: 0.9 }] })],
      ["summary count as string", (o) => ({ ...o, summary: { ...o.summary, supported: "1" } })],
    ],
  },
  {
    tool: findTool,
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
    negatives: [
      ["winner as number", (o) => ({ ...o, winner: 42 })],
      ["distribution as array", (o) => ({ ...o, distribution: ["a"] })],
    ],
  },
  {
    tool: rerankTool,
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
    negatives: [
      ["ranked as object", (o) => ({ ...o, ranked: {} })],
      ["rank as string", (o) => ({ ...o, ranked: [{ rank: "1", id: "a", relevance_score: 0.8 }] })],
    ],
  },
  {
    tool: classifyTool,
    validOutput: {
      classifications: [{ id: "i", classification: "c", winner_probability: 0.7 }],
      decision: decision("ALLOW", "classify"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    negatives: [
      ["classifications as string", (o) => ({ ...o, classifications: "x" })],
      ["item missing classification+winner_probability", (o) => ({ ...o, classifications: [{ id: "i" }] })],
    ],
  },
  {
    tool: decideTool,
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
    negatives: [
      ["requirements as array", (o) => ({ ...o, requirements: ["r"] })],
      ["distribution null (handler emits the object)", (o) => ({ ...o, distribution: null })],
    ],
  },
  {
    tool: compareTool,
    validOutput: {
      overall: { relation: "same_fact", distribution: { same_fact: 0.7 }, winner_probability: 0.7 },
      decision: decision("ALLOW", "compare"),
      latency_ms: 1,
      evidence: {},
      abstention: {},
    },
    negatives: [
      ["overall null", (o) => ({ ...o, overall: null })],
      ["decision missing its decision key", (o) => ({ ...o, decision: { reason_codes: ["r"], policy: { name: "compare", version: "1.0.0" } } })],
    ],
  },
  {
    tool: extractTool,
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
    negatives: [
      ["results null", (o) => ({ ...o, results: null })],
      ["result missing value/status/winner_probability", (o) => ({ ...o, results: [{ id: "f" }] })],
    ],
  },
  {
    tool: reviewTool,
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
    negatives: [
      ["rubric missing safe_to_apply", (o) => {
        const { safe_to_apply, ...rest } = o.rubric;
        void safe_to_apply;
        return { ...o, rubric: rest };
      }],
      ["evidence as array", (o) => ({ ...o, evidence: ["e"] })],
    ],
  },
  {
    tool: gateTool,
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
    negatives: [
      ["claims as string", (o) => ({ ...o, claims: "c" })],
      ["reason_codes as string", (o) => ({ ...o, decision: { ...o.decision, reason_codes: "r" } })],
    ],
  },
  {
    tool: piiTool,
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
    negatives: [
      ["findings as object", (o) => ({ ...o, findings: {} })],
      ["counts as array + secrets_found as string", (o) => ({ ...o, counts: ["x"], secrets_found: "zero" })],
    ],
  },
  {
    tool: capabilitiesTool,
    validOutput: {
      models: [],
      backend: { ready: true },
      gliner: { reachable: false, ready: false, models: [] },
      primitives: [],
      tools: [],
      policies: [],
      features: { top_k: {}, pruning: {}, two_stage: {}, structured: {}, revision: {} },
      mode: "observe",
      schema_version: "1.0.0",
      latency_ms: 1,
    },
    negatives: [
      ["mode write (observe-only enum)", (o) => ({ ...o, mode: "write" })],
      ["features missing four of five flags", (o) => ({ ...o, features: { top_k: {} } })],
    ],
  },
];

const ENVELOPE_KEYS = new Set(Object.keys(envelopeMetadataProperties()));
assert.equal(ENVELOPE_KEYS.size, 9, "nine known additive envelope keys");

function stripEnvelope(obj) {
  const out = { ...obj };
  for (const k of ENVELOPE_KEYS) delete out[k];
  return out;
}

// -------------------------------------- Part A1: old-client round-trip ----
for (const { tool, validOutput } of FIXTURES) {
  await check(`${tool.name}: text==structured, strips back to the pre-Fase-5 payload`, () => {
    const res = buildCallResult(tool.name, JSON.stringify(validOutput));
    assert.ok(!res.isError, "success result");
    assert.equal(res.content.length, 1, "single text block (2024-10-07 compat)");
    assert.ok(typeof res.content[0].text === "string" && res.content[0].text.length > 0, "text non-empty");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == parsed text");
    // The old client (reads text only) sees exactly its old object: every
    // additive key is one of the nine known ones, and removing them
    // restores the handler payload byte-identically. Exception:
    // laya_capabilities is Fase-5-native and emits schema_version ITSELF
    // (handler key AND envelope stamp, same value by construction), so its
    // stripped form drops that overlapping key too.
    for (const k of Object.keys(parsed)) {
      assert.ok(k in validOutput || ENVELOPE_KEYS.has(k), `key '${k}' is legacy or a known envelope key (no surprises)`);
    }
    const expectedStripped = { ...validOutput };
    if (tool.name === "laya_capabilities") {
      assert.equal(parsed.schema_version, "1.0.0", "handler-emitted version coincides with the envelope stamp");
      delete expectedStripped.schema_version;
    }
    assert.deepStrictEqual(stripEnvelope(parsed), expectedStripped, "stripped == pre-Fase-5 payload");
  });
}

// -------------------------------------- Part A2: schema negatives --------
for (const { tool, validOutput, negatives } of FIXTURES) {
  await check(`${tool.name}: outputSchema rejects what the handler never emits`, () => {
    assertValid(tool.outputSchema, validOutput, "faithful baseline still valid");
    assert.equal(negatives.length, 2, "two negatives per tool");
    for (const [label, mutate] of negatives) {
      assertInvalid(tool.outputSchema, mutate(validOutput), label);
    }
  });
}

// ----------------- Part A3: fake broken handlers at dispatch level -------
// Mirrors the src/index.ts CallTool dispatch (success -> buildCallResult,
// throw -> isError JSON) with TEST-ONLY fake handlers -- src/ untouched.
async function dispatchLikeIndex(toolName, fakeHandler) {
  try {
    const content = await fakeHandler();
    return buildCallResult(toolName, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ tool: toolName, error: message }, null, 2) }],
    };
  }
}

await check("malformed: garbage-text handler preserves text, omits structuredContent", async () => {
  const res = await dispatchLikeIndex("laya_screen", async () => "not json at all {{{");
  assert.ok(!res.isError, "garbage text is not an error");
  assert.equal(res.content[0].text, "not json at all {{{", "text intact");
  assert.ok(!("structuredContent" in res), "no structuredContent");
});

await check("malformed: JSON-array handler preserves text, omits structuredContent", async () => {
  const res = await dispatchLikeIndex("laya_find", async () => "[1,2]");
  assert.equal(res.content[0].text, "[1,2]", "text intact");
  assert.ok(!("structuredContent" in res), "non-object omits structuredContent");
});

await check("malformed: throwing handler becomes serializable isError (never a raw throw)", async () => {
  const res = await dispatchLikeIndex("laya_gate", async () => {
    throw new Error("boom");
  });
  assert.equal(res.isError, true, "isError");
  assert.ok(!("structuredContent" in res), "no structuredContent on errors");
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.tool, "laya_gate");
  assert.match(parsed.error, /boom/);
  JSON.parse(JSON.stringify(res)); // wire-safe: no raw exception leaks
});

console.log(`\nT6 offline gaps: ${passed} checks passed (no server involved).`);

// -------------------------------------------- Part B: live stub backends ---
function stubBackends() {
  const genericAnswer = () => ({ noul: 0.85, choice: "none", probabilities: {}, score: 2 });
  // Compare judges relations: overall/aspect questions need a schema-valid
  // relation choice or the SDK client itself rejects the structuredContent
  // with -32602 (see T4).
  const compareAnswer = () => ({ noul: 0.85, choice: "same_fact", probabilities: { same_fact: 0.7 }, score: 2 });
  const answerFor = (qid) => (qid === "overall" || /^aspect_\d+_/.test(qid) ? compareAnswer() : genericAnswer());
  const laya = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/live") return json(200, { alive: true });
    if (req.url === "/ready") return json(200, { ready: true, loaded: [], failed: [] });
    if (req.url === "/models") return json(200, { models: [] });
    if (req.url === "/predict" && req.method === "POST") {
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
        json(200, { answers, confidence: {}, routing: {}, model: "stub-laya", latency_ms: 1, usage: {} });
      });
      return;
    }
    return json(404, { error: "stub" });
  });
  const gliner = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/live") return json(200, { alive: true });
    if (req.url === "/ready") return json(200, { ready: true, loaded: ["gliner-pii"], failed: [] });
    if (req.url === "/models") return json(200, { models: [] });
    if (req.url === "/pii_scan" && req.method === "POST") return json(200, { findings: [], counts: {}, latency_ms: 1 });
    if (req.url === "/extract_entities" && req.method === "POST") return json(200, { entities: {}, latency_ms: 1 });
    return json(404, { error: "stub" });
  });
  return { laya, gliner };
}

const VALID_CALLS = [
  { name: "laya_screen", args: { text: "hello world", purpose: "test" } },
  { name: "laya_verify", args: { claims: ["sky is blue"], evidence: "the sky is blue today" } },
  { name: "laya_find", args: { query: "q", candidates: [{ id: "a", text: "alpha beta" }] } },
  { name: "laya_rerank", args: { query: "q", candidates: [{ id: "a", text: "alpha beta" }] } },
  {
    name: "laya_classify",
    args: { purpose: "p", items: [{ id: "i", text: "some text" }], classes: [{ id: "c", description: "category" }] },
  },
  {
    name: "laya_decide",
    args: { decision: "pick", candidates: [{ id: "a", description: "first" }, { id: "b", description: "second" }] },
  },
  { name: "laya_compare", args: { passage_a: "cats sit", passage_b: "dogs run" } },
  {
    name: "laya_extract",
    args: { document: "total $29 due", fields: [{ id: "amount", description: "total amount", pattern: "\\$\\d+" }] },
  },
  { name: "laya_review", args: { request: "fix", diff: "+line" } },
  { name: "laya_gate", args: { request: "fix", diff: "+line", claims: ["tests pass"] } },
  { name: "laya_pii", args: { text: "hello world" } },
  { name: "laya_capabilities", args: {} },
];

// Per judgment tool: args the builders reject BEFORE any backend round-trip.
// Expected wire shape: the promise RESOLVES to isError (never rejects), the
// text carries the structured builder vocabulary, no structuredContent.
const INVALID_CALLS = [
  { name: "laya_screen", args: { text: "x".repeat(20001), purpose: "t" }, vocabulary: /input_too_large/ },
  { name: "laya_verify", args: { claims: Array(65).fill("c"), evidence: "e" }, vocabulary: /input_too_large/ },
  { name: "laya_find", args: { query: "q", candidates: [{ id: "a", text: "b" }], top_k: 251 }, vocabulary: /input_too_large/ },
  { name: "laya_rerank", args: { query: "q", candidates: [{ id: "a", text: "b" }], top_k: 65 }, vocabulary: /input_too_large/ },
  {
    name: "laya_classify",
    args: { purpose: "p", items: Array(65).fill({ id: "i", text: "t" }), classes: [{ id: "c", description: "d" }] },
    vocabulary: /input_too_large/,
  },
  {
    name: "laya_decide",
    args: { decision: "d", candidates: Array(7).fill({ id: "a", description: "x" }) },
    vocabulary: /input_too_large/,
  },
  { name: "laya_compare", args: { passage_a: "x".repeat(20001), passage_b: "b" }, vocabulary: /input_too_large/ },
  {
    name: "laya_extract",
    args: { document: "d", fields: Array(65).fill({ id: "f", description: "F" }) },
    vocabulary: /input_too_large/,
  },
  { name: "laya_review", args: { request: "r", diff: "x".repeat(20001) }, vocabulary: /input_too_large/ },
  {
    name: "laya_gate",
    args: { request: "r", diff: "d", claims: ["c"], risk: "extreme" },
    vocabulary: /risk must be one of/,
  },
  { name: "laya_pii", args: { text: "x".repeat(50001) }, vocabulary: /input_too_large/ },
];

const { laya, gliner } = stubBackends();
await new Promise((r) => laya.listen(0, "127.0.0.1", r));
await new Promise((r) => gliner.listen(0, "127.0.0.1", r));
const transport = new StdioClientTransport({
  command: "node",
  args: [DIST],
  env: {
    ...process.env,
    LAYA_MODEL_REVISION: "",
    GLINER_MODEL_REVISION: "",
    LAYA_URL: `http://127.0.0.1:${laya.address().port}`,
    GLINER_URL: `http://127.0.0.1:${gliner.address().port}`,
    LAYA_HEALTH_INTERVAL_MS: "200",
  },
});
const client = new Client({ name: "t6-gaps", version: "0" }, { capabilities: {} });
await client.connect(transport);

try {
  const deadline = Date.now() + 20000;
  for (;;) {
    const listed = await client.listTools();
    if (listed.tools.length === 12) break;
    assert.ok(Date.now() < deadline, `12 tools advertised (got ${listed.tools.length})`);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Part B1: old-client back-compat sweep over all 12 tools. Each success
  // through client.callTool ALSO re-proves outputSchema fit: the SDK client
  // validates structuredContent itself and would reject with -32602.
  const byName = Object.fromEntries(FIXTURES.map((f) => [f.tool.name, f.validOutput]));
  for (const call of VALID_CALLS) {
    await check(`live ${call.name}: old-client text has every legacy key, only known additive keys`, async () => {
      const res = await client.callTool({ name: call.name, arguments: call.args });
      assert.ok(!res.isError, `${call.name} succeeds: ${JSON.stringify(res).slice(0, 200)}`);
      assert.equal(res.content.length, 1, "single text block");
      assert.equal(res.content[0].type, "text");
      const text = res.content[0].text;
      assert.ok(typeof text === "string" && text.length > 0, "text non-empty");
      const parsed = JSON.parse(text);
      assert.deepStrictEqual(res.structuredContent, parsed, "structured == parsed text");
      const legacyKeys = Object.keys(byName[call.name]);
      for (const k of legacyKeys) assert.ok(k in parsed, `legacy key '${k}' present`);
      for (const k of Object.keys(parsed)) {
        assert.ok(k in byName[call.name] || ENVELOPE_KEYS.has(k), `key '${k}' is legacy or a known envelope key`);
      }
    });
  }

  // Part B2: invalid input per judgment tool -- structured error, never a
  // raw throw to the wire.
  for (const call of INVALID_CALLS) {
    await check(`live ${call.name}: malformed args resolve isError with builder vocabulary`, async () => {
      let res;
      try {
        res = await client.callTool({ name: call.name, arguments: call.args });
      } catch (err) {
        assert.fail(`${call.name}: callTool threw raw to the wire: ${err}`);
      }
      assert.equal(res.isError, true, "isError");
      assert.ok(!("structuredContent" in res) || res.structuredContent === undefined, "no structuredContent on errors");
      assert.ok(Array.isArray(res.content) && res.content.length > 0, "error content non-empty");
      assert.match(res.content[0].text, call.vocabulary, "builder vocabulary on the wire");
      JSON.parse(JSON.stringify(res)); // wire-safe
    });
  }
} finally {
  await client.close();
  laya.close();
  gliner.close();
}

console.log(`\nT6 CONTRACT GAPS: ${passed} checks passed.`);
