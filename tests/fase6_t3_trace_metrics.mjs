/**
 * Fase-6 T3 trace + metrics tests: inbound correlation, in-process
 * aggregates, capabilities exposure.
 *
 * Part A (offline, no server): dist/trace.js + dist/metrics.js +
 * dist/envelope.js --
 *   - incoming trace_id/span_id (via _meta) correlate: the SAME ids land
 *     on the envelope next to decision_id; structuredContent deep-equals
 *     the parsed text (trace keys included in both);
 *   - absent _meta generates fresh ids (trace 32 hex, span 16 hex, unique
 *     per call); malformed incoming ids are replaced, never throw;
 *   - buildCallResult without a trace stays without trace keys
 *     (back-compat for direct callers);
 *   - metrics count per tool/decision (ALLOW/REVIEW/DENY/ESCALATE),
 *     abstentions, escalations, failed, per-model buckets;
 *   - p50/p95/p99 exact on the known series 1..100 (nearest-rank);
 *   - bounded window: 1000 observations retain <= LATENCY_WINDOW_MAX
 *     samples while requests_total keeps the full count;
 *   - no sensitive content: a canary planted in handler output never
 *     appears in the metrics snapshot (aggregates only, no free text).
 *
 * Part B (live round-trip, stub laya backend): one laya_screen call with
 * an inbound _meta trace (echoed verbatim on the envelope) plus a
 * generated-trace call, then laya_capabilities -- its `metrics` field
 * carries requests_total/latency quantiles for laya_screen and
 * model_load probes, and the metrics JSON contains no canary text.
 *
 * Run after build from the repo root: node tests/fase6_t3_trace_metrics.mjs
 */
import assert from "node:assert";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  SPAN_ID_RE,
  TRACE_ID_RE,
  extractTraceContext,
  newSpanId,
  newTraceId,
  normalizeTraceId,
} from "../dist/trace.js";
import {
  LATENCY_WINDOW_MAX,
  UNKNOWN_MODEL,
  getMetricsSnapshot,
  quantile,
  recordCall,
  recordEnvelope,
  recordError,
  recordProbe,
  resetMetrics,
} from "../dist/metrics.js";
import { augmentEnvelope, buildCallResult } from "../dist/envelope.js";

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
const fakeEnvelope = () => ({
  assessment: "valid",
  decision: { decision: "ALLOW", reason_codes: ["screen_pass"], policy: { name: "screen", version: "1.0.0" } },
  latency_ms: 7,
  evidence: { signals: [], model: "stub-laya", revision: null, detector: "router" },
  abstention: { abstained: false, reason: null },
});

// ---------------------------------------------------------- Part A: unit ---
await check("incoming _meta trace correlates: same ids land on the envelope", () => {
  const trace = extractTraceContext({
    _meta: { trace_id: "aa".repeat(16), span_id: "bb".repeat(8) },
  });
  assert.equal(trace.trace_id, "aa".repeat(16));
  assert.equal(trace.span_id, "bb".repeat(8));
  const out = augmentEnvelope("laya_screen", fakeEnvelope(), trace);
  assert.equal(out.trace_id, "aa".repeat(16), "trace_id threaded");
  assert.equal(out.span_id, "bb".repeat(8), "span_id threaded");
  assert.match(out.decision_id, DECISION_ID_RE, "decision_id alongside");
  const res = buildCallResult("laya_screen", JSON.stringify(fakeEnvelope()), trace);
  assert.deepStrictEqual(res.structuredContent, JSON.parse(res.content[0].text), "structured == text with trace");
  assert.equal(res.structuredContent.trace_id, "aa".repeat(16));
});

await check("absent _meta generates fresh W3C-shaped ids, unique per call", () => {
  for (const params of [undefined, null, {}, { _meta: {} }, "nope"]) {
    const t = extractTraceContext(params);
    assert.match(t.trace_id, TRACE_ID_RE, `trace shape for ${JSON.stringify(params)}`);
    assert.match(t.span_id, SPAN_ID_RE, "span shape");
  }
  const a = extractTraceContext({});
  const b = extractTraceContext({});
  assert.notEqual(a.trace_id, b.trace_id, "trace unique");
  assert.notEqual(a.span_id, b.span_id, "span unique");
  assert.match(newTraceId(), TRACE_ID_RE);
  assert.match(newSpanId(), SPAN_ID_RE);
});

await check("malformed incoming ids are replaced, never throw", () => {
  const t = extractTraceContext({ _meta: { trace_id: "!!!not-hex!!!", span_id: 42 } });
  assert.match(t.trace_id, TRACE_ID_RE, "bad trace regenerated");
  assert.match(t.span_id, SPAN_ID_RE, "bad span regenerated");
  assert.equal(normalizeTraceId("short"), null, "too short rejected");
  assert.equal(normalizeTraceId("x".repeat(65)), null, "too long rejected");
  assert.equal(normalizeTraceId(null), null, "non-string rejected");
  // UUID-with-dashes normalizes (32 hex body).
  assert.equal(
    normalizeTraceId("a8098c1a-f86e-11da-bd1a-00112444be1e"),
    "a8098c1af86e11dabd1a00112444be1e",
    "uuid accepted",
  );
});

await check("buildCallResult without a trace stays without trace keys (back-compat)", () => {
  const res = buildCallResult("laya_screen", JSON.stringify(fakeEnvelope()));
  const parsed = JSON.parse(res.content[0].text);
  assert.ok(!("trace_id" in parsed) && !("span_id" in parsed), "no trace keys for direct callers");
  assert.deepStrictEqual(res.structuredContent, parsed, "structured == text still");
  resetMetrics();
});

await check("metrics count per tool/decision/abstention/escalation/model", () => {
  resetMetrics();
  recordCall({ tool: "laya_screen", model: "stub-laya", decision: "ALLOW", latencyMs: 5, abstained: false });
  recordCall({ tool: "laya_screen", model: "stub-laya", decision: "allow", latencyMs: 9, abstained: false });
  recordCall({ tool: "laya_screen", model: null, decision: "DENY", latencyMs: 3, abstained: false });
  recordCall({ tool: "laya_gate", model: "stub-laya", decision: "ESCALATE", latencyMs: 11, abstained: true });
  recordCall({ tool: "laya_review", model: "stub-laya", decision: "REVIEW", latencyMs: null, abstained: false });
  recordError("laya_find");
  const snap = getMetricsSnapshot();
  assert.deepEqual(snap.requests_total, { laya_screen: 3, laya_gate: 1, laya_review: 1, laya_find: 1 });
  assert.equal(snap.requests_failed.laya_find, 1, "error branch counts failed");
  assert.equal(snap.requests_failed.laya_screen ?? 0, 0, "successes not failed");
  assert.deepEqual(snap.policy_decisions.laya_screen, { ALLOW: 2, DENY: 1 }, "labels uppercased verbatim");
  assert.deepEqual(snap.policy_decisions.laya_gate, { ESCALATE: 1 });
  assert.equal(snap.escalations.laya_gate, 1, "escalation shorthand");
  assert.equal(snap.abstentions.laya_gate, 1, "abstention counted");
  assert.equal(snap.abstentions.laya_screen, 0);
  assert.equal(snap.by_model.laya_screen["stub-laya"].total, 2, "per-model bucket");
  assert.equal(snap.by_model.laya_screen[UNKNOWN_MODEL].total, 1, "null model buckets as none");
  assert.equal(snap.inference_latency_ms.laya_review.count, 0, "null latency enters no samples");
  assert.equal(snap.inference_latency_ms.laya_review.p50, null, "empty series quantiles null");
  resetMetrics();
});

await check("p50/p95/p99 exact on the known series 1..100 (nearest-rank)", () => {
  resetMetrics();
  for (let i = 1; i <= 100; i++) {
    recordCall({ tool: "laya_find", model: "m", decision: "ALLOW", latencyMs: i });
  }
  const snap = getMetricsSnapshot();
  const lat = snap.inference_latency_ms.laya_find;
  assert.equal(lat.count, 100);
  assert.equal(lat.p50, 50, "nearest-rank p50");
  assert.equal(lat.p95, 95, "nearest-rank p95");
  assert.equal(lat.p99, 99, "nearest-rank p99");
  assert.equal(quantile([], 0.5), null, "empty quantile null");
  resetMetrics();
});

await check("window bounded: 1000 observations retain <= cap, totals exact", () => {
  resetMetrics();
  assert.ok(LATENCY_WINDOW_MAX > 0 && LATENCY_WINDOW_MAX <= 1024, `documented cap sane (${LATENCY_WINDOW_MAX})`);
  for (let i = 0; i < 1000; i++) {
    recordCall({ tool: "laya_screen", model: "m", decision: "ALLOW", latencyMs: i });
  }
  const snap = getMetricsSnapshot();
  assert.equal(snap.requests_total.laya_screen, 1000, "counters unbounded by design (fixed key cardinality)");
  assert.ok(
    snap.inference_latency_ms.laya_screen.count <= LATENCY_WINDOW_MAX,
    `retained ${snap.inference_latency_ms.laya_screen.count} <= ${LATENCY_WINDOW_MAX}`,
  );
  assert.ok(
    snap.by_model.laya_screen.m.p50 !== null,
    "per-model quantiles computed over the retained window",
  );
  resetMetrics();
});

await check("recordEnvelope extracts model/decision/latency/abstention; odd shapes never throw", () => {
  resetMetrics();
  recordEnvelope("laya_screen", {
    decision: { decision: "DENY", policy: { name: "screen", version: "1.0.0" } },
    evidence: { model: "stub-laya" },
    abstention: { abstained: true, reason: "r" },
    latency_ms: 13,
  });
  recordEnvelope("laya_gate", null);
  recordEnvelope("laya_gate", { latency_ms: "fast" });
  const snap = getMetricsSnapshot();
  assert.deepEqual(snap.policy_decisions.laya_screen, { DENY: 1 });
  assert.equal(snap.abstentions.laya_screen, 1);
  assert.equal(snap.inference_latency_ms.laya_screen.p50, 13);
  assert.equal(snap.requests_total.laya_gate, 2, "odd shapes still count the request");
  resetMetrics();
});

await check("recordProbe counts probes/failures; unknown sources ignored", () => {
  resetMetrics();
  recordProbe("laya", true, 4);
  recordProbe("laya", false, 6);
  recordProbe("gliner", true, 2);
  recordProbe("nope", false, 1);
  const snap = getMetricsSnapshot();
  assert.equal(snap.model_load.laya.probes, 2);
  assert.equal(snap.model_load.laya.failures, 1);
  assert.equal(snap.model_load.laya.p50, 4);
  assert.equal(snap.model_load.gliner.probes, 1);
  assert.equal(snap.model_load.gliner.failures, 0);
  assert.ok(!("nope" in snap.model_load), "unknown source ignored");
  resetMetrics();
});

await check("no sensitive content: canary in handler output absent from the snapshot", () => {
  resetMetrics();
  const canary = "canary-zqx-7741-secret-payload";
  const env = { ...fakeEnvelope(), assessment: canary };
  const res = buildCallResult("laya_screen", JSON.stringify(env), extractTraceContext({}));
  assert.ok(JSON.stringify(res.structuredContent).includes(canary), "envelope (decision content) intact");
  const snapText = JSON.stringify(getMetricsSnapshot());
  assert.ok(!snapText.includes(canary), "metrics carry aggregates only, no content");
  assert.ok(!snapText.includes("assessment"), "no envelope field names leak either");
  resetMetrics();
});

console.log(`\nT3 offline trace+metrics: ${passed} checks passed (no server involved).`);

// ----------------------------------------------- Part B: live round-trip ---
function stubLaya() {
  return http.createServer((req, res) => {
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
    if (req.url === "/models") {
      return json(200, {
        models: [
          { name: "english", repo: "org/laya-english", loaded: true, revision: null, revision_source: "unpinned", device: "cpu", circuit: "closed" },
        ],
      });
    }
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
        const answers = Object.fromEntries(
          Object.keys(questions).map((qid) => [qid, { noul: 0.85, choice: "none", probabilities: {}, score: 2 }]),
        );
        json(200, { answers, confidence: {}, routing: {}, model: "stub-laya", latency_ms: 1, usage: {} });
      });
      return;
    }
    return json(404, { error: "stub" });
  });
}

const CANARY = "canary-live-zqx-9921";
const IN_TRACE = "ab".repeat(16);
const IN_SPAN = "cd".repeat(8);

const laya = stubLaya();
await new Promise((r) => laya.listen(0, "127.0.0.1", r));
const transport = new StdioClientTransport({
  command: "node",
  args: [DIST],
  env: {
    ...process.env,
    LAYA_MODEL_REVISION: "",
    GLINER_MODEL_REVISION: "",
    LAYA_URL: `http://127.0.0.1:${laya.address().port}`,
    GLINER_URL: "http://127.0.0.1:1",
    LAYA_HEALTH_INTERVAL_MS: "200",
  },
});
const client = new Client({ name: "t3-trace-metrics", version: "0" }, { capabilities: {} });
await client.connect(transport);
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    const listed = await client.listTools();
    if (listed.tools.some((t) => t.name === "laya_screen")) break;
    assert.ok(Date.now() < deadline, "laya_screen advertised");
    await new Promise((r) => setTimeout(r, 300));
  }

  await check("live inbound _meta trace echoes verbatim on the envelope", async () => {
    const res = await client.callTool({
      name: "laya_screen",
      arguments: { text: `hello ${CANARY}`, purpose: "t3" },
      _meta: { trace_id: IN_TRACE, span_id: IN_SPAN },
    });
    assert.ok(!res.isError, "screen served");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == text");
    assert.equal(parsed.trace_id, IN_TRACE, "incoming trace_id correlates");
    assert.equal(parsed.span_id, IN_SPAN, "incoming span_id correlates");
    assert.match(parsed.decision_id, DECISION_ID_RE, "decision_id alongside");
  });

  await check("live call without _meta still carries generated trace ids", async () => {
    const res = await client.callTool({ name: "laya_screen", arguments: { text: "hi", purpose: "t3" } });
    const parsed = JSON.parse(res.content[0].text);
    assert.match(parsed.trace_id, TRACE_ID_RE, "generated trace present");
    assert.match(parsed.span_id, SPAN_ID_RE, "generated span present");
  });

  await check("live laya_capabilities exposes metrics without content", async () => {
    const res = await client.callTool({ name: "laya_capabilities", arguments: {} });
    assert.ok(!res.isError, "capabilities served");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == text");
    const m = parsed.metrics;
    assert.ok(m && typeof m === "object", "metrics field present");
    assert.ok((m.requests_total.laya_screen ?? 0) >= 2, "screen requests counted");
    const lat = m.inference_latency_ms.laya_screen;
    assert.ok(lat.count >= 2 && typeof lat.p50 === "number", "latency quantiles present");
    assert.ok(typeof lat.p95 === "number" && typeof lat.p99 === "number", "p95/p99 present");
    assert.ok((m.policy_decisions.laya_screen.DENY ?? 0) >= 2, "decisions counted per tool (stub noul 0.85 trips screen_injection_block -> DENY)");
    assert.ok(m.model_load.laya.probes >= 1, "probe observations recorded");
    assert.ok(!JSON.stringify(m).includes(CANARY), "no argument content in metrics");
    assert.ok(!JSON.stringify(m).includes("hello"), "no free text in metrics");
  });
} finally {
  await client.close();
  laya.close();
}

console.log(`\nT3 TRACE+METRICS: ${passed} checks passed.`);
