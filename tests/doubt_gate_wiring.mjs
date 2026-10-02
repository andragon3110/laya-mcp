/**
 * doubt-gate-es T5 wiring tests: the gate wakes up end to end.
 *
 * Covers what tests/policy_engine.mjs never pinned: the `low_confidence`
 * branch with a real context, the feed (LayaClient.predict -> ambient) and
 * the consume (evaluateForTool -> context fill), precedence (abstention
 * first, explicit handler context wins, missing/non-finite sleeps), and
 * the dead-case rule (a predict throw clears the ambient).
 *
 * Run after build from the repo root:  node tests/doubt_gate_wiring.mjs
 */
import assert from "node:assert";
import http from "node:http";
import { evaluate } from "../dist/policy/engine.js";
import { evaluateForTool } from "../dist/policy/mode.js";
import { THRESHOLDS_V1 } from "../dist/policy/thresholds.js";
import {
  clearDoubtTable,
  doubtTableFromRaw,
  mergeDoubtTable,
  takeDoubtTable,
} from "../dist/policy/doubt.js";
import { LayaClient } from "../dist/client.js";
import * as E from "../dist/evidence.js";

const RAW = { model: "t5-test", routing: {} };
const T1 = THRESHOLDS_V1;
/** Screen evidence that ALLOWS on its own (inj 0.1, substance 0.9). */
const allowScreen = () =>
  E.screenEvidence(RAW, { injection: 0.1, substance: 0.9, relevance: 0.9, missing: [] });

let passed = 0;
const pending = [];
function check(name, fn) {
  const r = fn();
  if (r && typeof r.then === "function") {
    pending.push(
      r.then(() => {
        passed++;
        console.log(`ok - ${name}`);
      }),
    );
  } else {
    passed++;
    console.log(`ok - ${name}`);
  }
}

// ------------------------------------------------------- table builder ---
check("prefers answer_confidence over confidence", () => {
  assert.deepEqual(
    doubtTableFromRaw({ answer_confidence: { q: 0.5 }, confidence: { q: 0.9 } }),
    { q: 0.5 },
  );
});
check("falls back to confidence when answer_confidence is absent/empty", () => {
  assert.deepEqual(doubtTableFromRaw({ confidence: { q: 0.7 } }), { q: 0.7 });
  assert.deepEqual(doubtTableFromRaw({ answer_confidence: {}, confidence: { q: 0.7 } }), { q: 0.7 });
  assert.deepEqual(doubtTableFromRaw({ answer_confidence: null, confidence: { q: 0.7 } }), { q: 0.7 });
});
check("drops non-finite/non-numeric; null when nothing usable", () => {
  assert.deepEqual(
    doubtTableFromRaw({ answer_confidence: { a: 0.5, b: NaN, c: Infinity, d: "x", e: null } }),
    { a: 0.5 },
  );
  assert.equal(doubtTableFromRaw({ answer_confidence: { a: NaN } }), null);
  assert.equal(doubtTableFromRaw({}), null);
  assert.equal(doubtTableFromRaw({ answer_confidence: "high" }), null);
});
check("merge unions stages; take consumes exactly once", () => {
  clearDoubtTable();
  mergeDoubtTable({ selected: 0.95 });
  mergeDoubtTable({ requirement_0: 0.4 });
  mergeDoubtTable(null);
  assert.deepEqual(takeDoubtTable(), { selected: 0.95, requirement_0: 0.4 });
  assert.equal(takeDoubtTable(), null);
});

// ------------------------------------------------------------- engine ----
check("engine: low case confidence escalates with low_confidence", () => {
  const { evidence } = allowScreen();
  const d = evaluate(
    { evidence, abstention: E.notAbstained(), context: { answer_confidence: { q: 0.5 } }, policy: { name: "screen", version: "1.0.0" } },
    { thresholds: T1 },
  );
  assert.equal(d.decision, "ESCALATE");
  assert.deepEqual(d.reason_codes, ["low_confidence"]);
});
check("engine: abstention still precedes the doubt gate", () => {
  const { evidence } = allowScreen();
  const d = evaluate(
    {
      evidence,
      abstention: E.abstained("t5 precedence probe"),
      context: { answer_confidence: { q: 0.1 } },
      policy: { name: "screen", version: "1.0.0" },
    },
    { thresholds: T1 },
  );
  assert.equal(d.decision, "ESCALATE");
  assert.deepEqual(d.reason_codes, ["abstained_evidence"]);
});
check("engine: missing/non-finite confidence sleeps the gate", () => {
  const { evidence } = allowScreen();
  const noCtx = evaluate(
    { evidence, abstention: E.notAbstained(), policy: { name: "screen", version: "1.0.0" } },
    { thresholds: T1 },
  );
  assert.deepEqual(noCtx.reason_codes, ["screen_pass"]);
  const nonFinite = evaluate(
    {
      evidence,
      abstention: E.notAbstained(),
      context: { answer_confidence: { q: NaN } },
      policy: { name: "screen", version: "1.0.0" },
    },
    { thresholds: T1 },
  );
  assert.deepEqual(nonFinite.reason_codes, ["screen_pass"]);
  const aboveCut = evaluate(
    {
      evidence,
      abstention: E.notAbstained(),
      context: { answer_confidence: { q: 0.99 } },
      policy: { name: "screen", version: "1.0.0" },
    },
    { thresholds: T1 },
  );
  assert.deepEqual(aboveCut.reason_codes, ["screen_pass"]);
});

// -------------------------------------------------------------- wiring ---
check("evaluateForTool fills the gate context from the ambient", () => {
  clearDoubtTable();
  mergeDoubtTable({ is_injection: 0.5, has_substance: 0.6, is_relevant: 0.7 });
  const { evidence, abstention } = allowScreen();
  const { decision } = evaluateForTool(
    "laya_screen",
    { evidence, abstention, context: { text_chars: 42 }, policy: { name: "screen", version: "1.0.0" } },
    { thresholds: T1 },
  );
  assert.equal(decision.decision, "ESCALATE");
  assert.deepEqual(decision.reason_codes, ["low_confidence"]);
  // Consumed: the next judgment on identical input sleeps the gate.
  const again = evaluateForTool(
    "laya_screen",
    { evidence, abstention, context: { text_chars: 42 }, policy: { name: "screen", version: "1.0.0" } },
    { thresholds: T1 },
  );
  assert.deepEqual(again.decision.reason_codes, ["screen_pass"]);
});
check("evaluateForTool respects explicit handler context over the ambient", () => {
  clearDoubtTable();
  mergeDoubtTable({ q: 0.1 });
  const { evidence, abstention } = allowScreen();
  const { decision } = evaluateForTool(
    "laya_screen",
    {
      evidence,
      abstention,
      context: { answer_confidence: { q: 0.99 } },
      policy: { name: "screen", version: "1.0.0" },
    },
    { thresholds: T1 },
  );
  assert.deepEqual(decision.reason_codes, ["screen_pass"]);
  clearDoubtTable();
});

// --------------------------------------------- end to end over stub HTTP ---
function stubServer(handler) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = handler(req.url, body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const predictBody = (answerConfidence, confidence) => ({
  answers: { is_injection: { noul: 0.1 }, has_substance: { noul: 0.9 }, is_relevant: { noul: 0.9 } },
  ...(confidence !== undefined ? { confidence } : {}),
  ...(answerConfidence !== undefined ? { answer_confidence: answerConfidence } : {}),
  routing: {},
  model: "t5-stub",
  latency_ms: 1,
  usage: {},
});

check("predict feeds answer_confidence; gate fires on the live path", async () => {
  const srv = await stubServer(() => ({
    status: 200,
    body: predictBody({ is_injection: 0.5, has_substance: 0.6, is_relevant: 0.7 }, { is_injection: 0.99 }),
  }));
  try {
    const port = srv.address().port;
    const client = new LayaClient(`http://127.0.0.1:${port}`);
    clearDoubtTable();
    const raw = await client.predict({ text: "x" }, { q: { type: "noul" } }, 5000);
    assert.deepEqual(raw.answer_confidence, { is_injection: 0.5, has_substance: 0.6, is_relevant: 0.7 });
    const { evidence, abstention } = allowScreen();
    const { decision } = evaluateForTool(
      "laya_screen",
      { evidence, abstention, context: { text_chars: 1 }, policy: { name: "screen", version: "1.0.0" } },
      { thresholds: T1 },
    );
    assert.equal(decision.decision, "ESCALATE");
    assert.deepEqual(decision.reason_codes, ["low_confidence"]);
  } finally {
    srv.close();
  }
});

check("predict falls back to confidence when the backend omits answer_confidence", async () => {
  const srv = await stubServer(() => ({ status: 200, body: predictBody(undefined, { q: 0.4 }) }));
  try {
    const port = srv.address().port;
    const client = new LayaClient(`http://127.0.0.1:${port}`);
    clearDoubtTable();
    await client.predict({ text: "x" }, { q: { type: "noul" } }, 5000);
    const { evidence, abstention } = allowScreen();
    const { decision } = evaluateForTool(
      "laya_screen",
      { evidence, abstention, policy: { name: "screen", version: "1.0.0" } },
      { thresholds: T1 },
    );
    assert.deepEqual(decision.reason_codes, ["low_confidence"]);
  } finally {
    srv.close();
  }
});

check("predict throw clears the ambient (dead case poisons nothing)", async () => {
  const srv = await stubServer(() => ({ status: 500, body: { detail: "boom" } }));
  try {
    const port = srv.address().port;
    const client = new LayaClient(`http://127.0.0.1:${port}`);
    mergeDoubtTable({ stale: 0.1 });
    await assert.rejects(client.predict({ text: "x" }, { q: { type: "noul" } }, 5000));
    assert.equal(takeDoubtTable(), null);
  } finally {
    srv.close();
  }
});

// Async checks above run inline: top-level await keeps order deterministic.
await Promise.all(pending);
console.log(`\nDoubt gate T5 wiring: ${passed} checks passed (stub HTTP only, no models).`);
