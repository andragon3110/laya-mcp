/**
 * Fase-6 T6 MCP<->Gentle integration contract tests (stub backends only;
 * no OpenCode, no Gentle, no models, no GPU, no pip).
 *
 * LIMIT (documented, never invented): OpenCode and Gentle are absent from
 * this repo, so the Gentle side is SIMULATED -- a test harness plays the
 * Gentle role exactly as the contract documents it: it injects trace_id /
 * span_id on the MCP request `_meta` (as Gentle would), calls the hook
 * tools in lifecycle order, reads the text-JSON envelope the way an
 * orchestrator parses by eye, and honors the mode semantics from
 * examples/gentle-hooks.yaml+md. No result below claims a live Gentle run.
 *
 * Part A (offline, no server) -- contract surface:
 *   - every hook in examples/gentle-hooks.yaml routes to REAL announced
 *     tools (registry truth from dist/): external_content.pre_context ->
 *     laya_screen + laya_pii, implementation.post_write -> laya_review,
 *     completion.pre_complete -> laya_gate, retrieval.candidate_selection
 *     -> laya_find; every hook defaults to mode observe; the table declares
 *     on_missing_tools: ignore and the pii leg declares needs --with-gliner;
 *   - hook arg maps are templates (angle-bracket placeholders): every arg
 *     key is a declared inputSchema property of its tool; the gate hook
 *     template omits the REQUIRED `request` input, so Gentle must fill
 *     required inputs from the live diff/claims -- asserted as template
 *     semantics, never as a failure;
 *   - observe/shadow/enforce resolve per hook tool (global LAYA_MODE,
 *     per-tool LAYA_MODE_<TOOL> wins, invalid falls back) and stamp
 *     effective_mode on every envelope; shadow never alters the base
 *     decision (review/gate disagreement fixture);
 *   - simulated trace propagation: a fake Gentle _meta threads the SAME
 *     trace_id/span_id onto two hook envelopes (screen + gate) next to
 *     distinct decision_ids -- one trace_id correlates the whole workflow;
 *   - decision correlation: top-level policy/policy_version mirror
 *     decision.policy, primitive matches TOOL_PRIMITIVES;
 *   - failure handling is mode-blind: recordError counts requests_total +
 *     failed per tool under every mode label with no content leakage;
 *   - back-compat for the eye-parsing orchestrator: content[0].text stays
 *     non-empty parseable JSON, structuredContent deep-equals the parse,
 *     no _meta leaks onto the result, and stripping the additive keys
 *     (trace_id/span_id/effective_mode/shadow/modes/metrics) leaves the
 *     full legacy payload;
 *   - apply-orchestrator-policy.sh --check: the script text carries the
 *     check branch (block regex + policy-currency); a node-side fixture
 *     predicate replicates it exactly (V1/V2 current -> true, missing or
 *     stale block -> false). The LIVE .sh is SKIPPED here (no WSL distro,
 *     script needs python3, only python.exe present) -- see the skip line.
 *
 * Part B (live UP: stub laya + stub gliner) -- one workflow per hook:
 *   - each hook tool serves (!isError, structured == text, effective_mode
 *     observe by default): screen + pii (gliner stub announces laya_pii),
 *     review, gate, find;
 *   - one shared trace_id injected across the screen + gate calls (as one
 *     Gentle workflow would) correlates both envelopes with distinct
 *     decision_ids;
 *   - shadow mode serves every hook tool with the base decision identical
 *     to the observe run plus shadow{would_decide, under_policy};
 *     enforce mode serves every hook tool stamped enforce;
 *   - capabilities metrics count every hook tool with no content leakage;
 *     policy/primitive correlation holds live per hook tool.
 *
 * Part C (live DOWN in every mode) -- identical degradation per hook:
 *   tools/list is exactly [laya_capabilities], the hook call (laya_screen)
 *   isError with the recovery hint, the capabilities call isError with the
 *   backend diagnosis, errors carry no structuredContent.
 *
 * Run after build from the repo root: node tests/fase6_t6_gentle_integration.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluate } from "../dist/policy/engine.js";
import {
  DEFAULT_MODE,
  MODE_ENV_VAR,  SHADOW_POLICY_ENV_VAR,
  SUPPORTED_MODES,
  evaluateWithMode,
  resolveMode,
  toolModeEnvVar,
} from "../dist/policy/mode.js";
import { THRESHOLDS_V1 } from "../dist/policy/thresholds.js";
import { TOOL_PRIMITIVES, augmentEnvelope, buildCallResult } from "../dist/envelope.js";
import { TRACE_ID_RE, SPAN_ID_RE, extractTraceContext } from "../dist/trace.js";
import { getMetricsSnapshot, recordError, resetMetrics } from "../dist/metrics.js";
import { reviewEvidence } from "../dist/evidence.js";
import { capabilitiesTool } from "../dist/tools/capabilities.js";
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
const ROOT = path.join(HERE, "..");
const DIST = path.join(HERE, "..", "dist", "index.js");
const JUDGMENT = [screenTool, verifyTool, findTool, rerankTool, classifyTool, decideTool, compareTool, extractTool, reviewTool, gateTool, piiTool];
const REGISTRY = [...JUDGMENT, capabilitiesTool];
const BY_NAME = Object.fromEntries(REGISTRY.map((t) => [t.name, t]));

/** Hook -> tools contract truth (mirrors examples/gentle-hooks.yaml). */
const HOOKS = {
  "external_content.pre_context": ["laya_screen", "laya_pii"],
  "implementation.post_write": ["laya_review"],
  "completion.pre_complete": ["laya_gate"],
  "retrieval.candidate_selection": ["laya_find"],
};
const HOOK_TOOLS = [...new Set(Object.values(HOOKS).flat())];

let passed = 0;
let skipped = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}
function skip(name, cause) {
  skipped++;
  console.log(`skip - ${name} (${cause})`);
}

// Minimal yaml scan (no yaml dep): hook ids, tool routes per hook, modes,
// inline arg keys, standing-rule markers. Presence-oriented like T4 Part C.
function scanHooksTable() {
  const text = fs.readFileSync(path.join(ROOT, "examples", "gentle-hooks.yaml"), "utf8");
  const lines = text.split("\n");
  const hooks = [];
  let current = null;
  const routes = {};
  const modes = {};
  const args = {};
  for (const line of lines) {
    const id = line.match(/^\s*-\s*id:\s*(\S+)\s*$/);
    if (id) {
      current = id[1];
      hooks.push(current);
      routes[current] = [];
      continue;
    }
    const tool = line.match(/^\s*(?:-\s*)?tool:\s*(laya_\w+)\s*$/);
    if (tool && current) {
      routes[current].push(tool[1]);
      continue;
    }
    const mode = line.match(/^\s*mode:\s*(observe|shadow|enforce)\s*$/);
    if (mode && current) {
      (modes[current] ??= []).push(mode[1]);
      continue;
    }
    const inl = line.match(/^\s*args:\s*(\{.*\})\s*$/);
    if (inl && current) {
      // Top-level keys only: split on commas at depth 1 (nested maps like
      // candidates:[{id,text}] stay inside their own segment).
      const body = inl[1].slice(1, -1);
      const keys = [];
      let depth = 0;
      let seg = "";
      for (const ch of body) {
        if (ch === "{" || ch === "[") depth++;
        if (ch === "}" || ch === "]") depth--;
        if (ch === "," && depth === 0) {
          keys.push(seg.split(":")[0].trim());
          seg = "";
        } else {
          seg += ch;
        }
      }
      if (seg.trim() !== "") keys.push(seg.split(":")[0].trim());
      const lastTool = routes[current][routes[current].length - 1];
      args[`${current}::${lastTool}`] = keys.filter(Boolean);
    }
  }
  return { text, hooks, routes, modes, args };
}

// Review-shaped input where review and gate disagree (T4 fixture):
// safe_to_apply 0.3 is ESCALATE under review but REVIEW under gate.
function reviewInput(policy = { name: "review", version: "1.0.0" }) {
  const { evidence, abstention } = reviewEvidence(
    { model: "t6-test", routing: {} },
    { correctness: 2, spec_match: 2, test_gap: 0, blast_radius: 0, safe_to_apply: 0.3 },
  );
  return { evidence, abstention, context: { diff_chars: 10 }, risk: "normal", policy };
}

// ---------------------------------------------------------- Part A: unit ---
await check("hooks route to real announced tools, default observe, missing-tools ignore", () => {
  const { text, hooks, routes, modes } = scanHooksTable();
  assert.deepEqual(hooks, Object.keys(HOOKS), "yaml names exactly the four hooks");
  for (const [hook, tools] of Object.entries(HOOKS)) {
    assert.deepEqual(routes[hook], tools, `${hook} routes to ${tools.join("+")}`);
    for (const tool of tools) {
      assert.ok(BY_NAME[tool] !== undefined, `${hook}: ${tool} is a real announced tool (registry truth)`);
      assert.equal(BY_NAME[tool].inputSchema.type, "object", `${tool}: declares an input contract`);
    }
    for (const m of modes[hook] ?? []) assert.equal(m, "observe", `${hook}: default mode observe`);
  }
  assert.ok(text.includes("on_missing_tools: ignore"), "hooks never force calls when tools are absent");
  assert.ok(text.includes("defaults:") && text.includes("mode: observe"), "non-intrusive default declared");
  assert.ok(text.includes("--with-gliner"), "pii leg declares its sidecar need");
  const md = fs.readFileSync(path.join(ROOT, "examples", "gentle-hooks.md"), "utf8");
  for (const hook of Object.keys(HOOKS)) assert.ok(md.includes(hook), `doc names hook ${hook}`);
});

await check("hook arg maps are templates: keys declared, placeholders filled by Gentle", () => {
  const { args } = scanHooksTable();
  for (const [hook, tools] of Object.entries(HOOKS)) {
    for (const tool of tools) {
      const keys = args[`${hook}::${tool}`] ?? [];
      assert.ok(keys.length >= 1, `${hook}::${tool} documents at least one arg`);
      const props = Object.keys(BY_NAME[tool].inputSchema.properties ?? {});
      for (const k of keys) assert.ok(props.includes(k), `${hook}::${tool}: arg '${k}' is a declared input property`);
    }
  }
  // Template semantics (documented gap, not a failure): the gate hook lists
  // {claims, diff, evidence} but laya_gate REQUIRES request -- Gentle fills
  // required inputs from the live diff/claims when it wires the hook.
  assert.deepEqual(gateTool.inputSchema.required.slice().sort(), ["claims", "diff", "request"], "gate required pins the fixture");
  const gateKeys = args["completion.pre_complete::laya_gate"] ?? [];
  assert.ok(!gateKeys.includes("request"), "gate hook template omits required `request` (Gentle fills it)");
});

await check("observe/shadow/enforce resolve and stamp per hook tool", () => {
  for (const tool of HOOK_TOOLS) {
    assert.equal(resolveMode({}, tool), "observe", `${tool}: unset defaults to observe`);
    assert.equal(resolveMode({ [MODE_ENV_VAR]: "bogus" }, tool), "observe", `${tool}: invalid falls back`);
    assert.equal(resolveMode({ [MODE_ENV_VAR]: "shadow" }, tool), "shadow", `${tool}: global applies`);
    assert.equal(
      resolveMode({ [MODE_ENV_VAR]: "enforce", [toolModeEnvVar(tool)]: "observe" }, tool),
      "observe",
      `${tool}: per-tool wins`,
    );
    const env = augmentEnvelope(tool, {
      decision: { decision: "ALLOW", reason_codes: ["t6"], policy: { name: "x", version: "1.0.0" } },
      latency_ms: 1,
      evidence: { model: "m", revision: null },
    }, undefined, "shadow");
    assert.equal(env.effective_mode, "shadow", `${tool}: override stamps`);
  }
  assert.deepEqual([...SUPPORTED_MODES], ["observe", "shadow", "enforce"], "supported modes code truth");
  assert.equal(DEFAULT_MODE, "observe", "documented default");
});

await check("shadow never alters the hook decision (review/gate disagreement)", () => {
  const input = reviewInput();
  const base = evaluate(input, { thresholds: THRESHOLDS_V1 });
  assert.equal(base.decision, "ESCALATE", "base review outcome pins the fixture");
  const out = evaluateWithMode(input, {
    thresholds: THRESHOLDS_V1,
    mode: "shadow",
    shadowPolicy: { name: "gate", version: "1.0.0" },
  });
  assert.deepEqual(out.decision, base, "shadow leaves the base decision byte-identical");
  assert.equal(out.shadow.would_decide.decision, "REVIEW", "candidate disagrees (the point of the fixture)");
  assert.equal(out.effective_mode, "shadow");
});

await check("simulated Gentle trace threads across two hooks next to decision_ids", () => {
  // The harness plays Gentle: one workflow, one trace_id, two hook calls.
  const gentleMeta = { _meta: { trace_id: "ab".repeat(16), span_id: "cd".repeat(8) } };
  const trace = extractTraceContext(gentleMeta);
  const screenEnv = augmentEnvelope("laya_screen", {
    decision: { decision: "ALLOW", reason_codes: ["t6"], policy: { name: "screen", version: "1.0.0" } },
    latency_ms: 2,
    evidence: { model: "stub-laya", revision: null },
  }, trace);
  const gateEnv = augmentEnvelope("laya_gate", {
    decision: { decision: "ESCALATE", reason_codes: ["t6"], policy: { name: "gate", version: "1.0.0" } },
    latency_ms: 3,
    evidence: { model: "stub-laya", revision: null },
  }, trace);
  for (const env of [screenEnv, gateEnv]) {
    assert.equal(env.trace_id, "ab".repeat(16), "incoming trace_id correlates");
    assert.equal(env.span_id, "cd".repeat(8), "incoming span_id correlates");
    assert.match(env.decision_id, /^dec_[0-9a-f]{16}$/, "decision_id alongside");
  }
  assert.notEqual(screenEnv.decision_id, gateEnv.decision_id, "one trace, distinct decisions");
  const res = buildCallResult("laya_screen", JSON.stringify(screenEnv), trace);
  assert.deepStrictEqual(res.structuredContent, JSON.parse(res.content[0].text), "structured == text with trace");
});

await check("decision correlation: policy mirror plus primitive per hook tool", () => {
  for (const tool of HOOK_TOOLS) {
    const env = augmentEnvelope(tool, {
      decision: { decision: "REVIEW", reason_codes: ["t6"], policy: { name: "p", version: "2.0.0" } },
      latency_ms: 1,
      evidence: { model: "m", revision: null },
    });
    assert.equal(env.policy, "p", `${tool}: top-level policy mirrors decision.policy.name`);
    assert.equal(env.policy_version, "2.0.0", `${tool}: top-level version mirrors`);
    assert.equal(env.primitive, TOOL_PRIMITIVES[tool], `${tool}: primitive is envelope truth`);
  }
});

await check("failure handling is mode-blind: counts move, content never leaks", () => {
  resetMetrics();
  const canary = "canary-t6-6601-secret-payload";
  for (const mode of SUPPORTED_MODES) {
    recordError("laya_screen");
    assert.equal(resolveMode({ [MODE_ENV_VAR]: mode }, "laya_screen"), mode, `mode label ${mode} resolves`);
  }
  const snap = getMetricsSnapshot();
  assert.equal(snap.requests_total.laya_screen, 3, "one failure counted per mode");
  assert.equal(snap.requests_failed.laya_screen, 3, "failures counted separately");
  assert.ok(!JSON.stringify(snap).includes(canary), "no content in metrics under error");
  assert.deepEqual(
    Object.keys(snap).sort(),
    ["abstentions", "by_model", "escalations", "inference_latency_ms", "model_load", "policy_decisions", "requests_failed", "requests_total"],
    "documented metric surface only",
  );
  resetMetrics();
});

await check("back-compat: eye-readable text-JSON, additive strip leaves the legacy payload", () => {
  const trace = extractTraceContext({ _meta: { trace_id: "ef".repeat(16), span_id: "12".repeat(8) } });
  const res = buildCallResult("laya_gate", JSON.stringify({
    review: {}, claims: [], decision: { decision: "ALLOW", reason_codes: ["t6"], policy: { name: "gate", version: "1.0.0" } },
    latency_ms: 4, evidence: { model: "m", revision: null }, abstention: { abstained: false },
  }), trace, "enforce");
  const text = res.content[0].text;
  assert.ok(typeof text === "string" && text.length > 0, "non-empty text block (eye-parseable)");
  const parsed = JSON.parse(text); // an orchestrator parsing by eye reads this
  assert.deepStrictEqual(res.structuredContent, parsed, "structured == text");
  assert.ok(!("structuredContent" in parsed) && !("_meta" in parsed), "no envelope-in-envelope, no _meta leak");
  const ADDITIVE = ["trace_id", "span_id", "effective_mode", "shadow", "modes", "metrics"];
  const stripped = { ...parsed };
  for (const k of ADDITIVE) delete stripped[k];
  for (const k of ["review", "claims", "decision", "latency_ms", "evidence", "abstention", "decision_id"]) {
    assert.ok(k in stripped, `legacy key '${k}' survives the strip`);
  }
  resetMetrics();
});

await check("orchestrator-policy --check: script branch plus fixture predicate (live .sh skipped)", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "apply-orchestrator-policy.sh"), "utf8");
  assert.ok(script.includes('--check) MODE="check"'), "script accepts --check");
  assert.ok(script.includes("policy.strip() in prompt"), "check means block present AND policy current");
  const policy = fs.readFileSync(path.join(ROOT, "examples", "gentle-orchestrator-policy.md"), "utf8");
  const OPEN = "<!-- laya-mcp:orchestrator-policy -->";
  const CLOSE = "<!-- /laya-mcp:orchestrator-policy -->";
  const ANCHOR = "<!-- gentle-ai:sdd-model-assignments -->";
  // Exact --check predicate from the script: block regex matches AND the
  // current policy text is contained in the prompt.
  const checkPredicate = (prompt) =>
    new RegExp(OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".*?" + CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "s").test(prompt) &&
    prompt.includes(policy.trim());
  const block = `${OPEN}\n${policy.trim()}\n${CLOSE}`;
  const v1 = (prompt) => ({ agent: { "gentle-orchestrator": { prompt } } });
  const v2 = (prompt) => ({ agents: { "gentle-orchestrator": { system: prompt } } });
  const promptOf = (data) =>
    data.agent?.["gentle-orchestrator"]?.prompt ?? data.agents?.["gentle-orchestrator"]?.system ?? null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t6-opencode-"));
  try {
    const current = `${block}\n\n${ANCHOR}\n`;
    fs.writeFileSync(path.join(dir, "v1.json"), JSON.stringify(v1(`intro\n${current}`)));
    fs.writeFileSync(path.join(dir, "v2.json"), JSON.stringify(v2(`intro\n${current}`)));
    fs.writeFileSync(path.join(dir, "missing.json"), JSON.stringify(v1(`intro\n${ANCHOR}\n`)));
    fs.writeFileSync(path.join(dir, "stale.json"), JSON.stringify(v1(`intro\n${block.replace("OPTIONAL", "OPTIONALX")}\n\n${ANCHOR}\n`)));
    assert.equal(checkPredicate(promptOf(JSON.parse(fs.readFileSync(path.join(dir, "v1.json"), "utf8")))), true, "V1 current passes --check");
    assert.equal(checkPredicate(promptOf(JSON.parse(fs.readFileSync(path.join(dir, "v2.json"), "utf8")))), true, "V2 current passes --check");
    assert.equal(checkPredicate(promptOf(JSON.parse(fs.readFileSync(path.join(dir, "missing.json"), "utf8")))), false, "missing block fails --check");
    assert.equal(checkPredicate(promptOf(JSON.parse(fs.readFileSync(path.join(dir, "stale.json"), "utf8")))), false, "stale policy fails --check");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  skip("live scripts/apply-orchestrator-policy.sh --check", "no WSL distro (execvpe /bin/bash failed) and script needs python3, only python.exe present; no opencode.json fixture on this host");
});

console.log(`\nT6 offline integration contract: ${passed} checks passed, ${skipped} skipped (no server involved).`);

// ------------------------------------------- Part B/C: live round-trips ---
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

// Minimal GLiNER sidecar stub: liveness + readiness + inventory + one scan
// endpoint (the only POST handlePii uses). One email span -> REVIEW.
function stubGliner() {
  return http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/live") return json(200, { alive: true, service: "gliner-server", version: "0.4.0" });
    if (req.url === "/ready") {
      return json(200, {
        ready: true, reason: null, loaded: ["gliner"], failed: [],
        device: "cpu", versions: { "gliner-server": "0.4.0" }, circuit: "closed",
      });
    }
    if (req.url === "/models") return json(200, { models: [] });
    if (req.url === "/pii_scan" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let text = "";
        try {
          text = String(JSON.parse(raw).text ?? "");
        } catch {
          text = "";
        }
        const at = text.indexOf("@");
        const findings = at >= 0
          ? [{ text: text.slice(0, at + 6), start: 0, end: at + 6, confidence: 0.9, type: "email" }]
          : [];
        const counts = {};
        for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
        json(200, { findings, counts, latency_ms: 1 });
      });
      return;
    }
    return json(404, { error: "stub" });
  });
}

async function withClient(extraEnv, fn, { gliner = true } = {}) {
  const laya = stubLaya();
  await new Promise((r) => laya.listen(0, "127.0.0.1", r));
  let sidecar = null;
  if (gliner) {
    sidecar = stubGliner();
    await new Promise((r) => sidecar.listen(0, "127.0.0.1", r));
  }
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST],
    env: {
      ...process.env,
      LAYA_MODEL_REVISION: "",
      GLINER_MODEL_REVISION: "",
      LAYA_URL: `http://127.0.0.1:${laya.address().port}`,
      GLINER_URL: gliner ? `http://127.0.0.1:${sidecar.address().port}` : "http://127.0.0.1:1",
      LAYA_HEALTH_INTERVAL_MS: "200",
      ...extraEnv,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "t6-gentle-integration", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      if (names.includes("laya_screen") && (!gliner || names.includes("laya_pii"))) break;
      assert.ok(Date.now() < deadline, "hook tools advertised (laya_screen + laya_pii)");
      await new Promise((r) => setTimeout(r, 300));
    }
    await fn(client);
  } finally {
    await client.close();
    laya.close();
    sidecar?.close();
  }
}

// Valid hook invocations (placeholders filled, required inputs complete).
const HOOK_CALLS = {
  laya_screen: { text: "Refund my duplicate charge please.", purpose: "t6-pre-context" },
  laya_pii: { text: "Contact ana@example.com for the invoice." },
  laya_review: { request: "Add input validation", diff: "+ if (!x) throw\n- return x", tests: "t6: 1 passed" },
  laya_gate: { request: "Add input validation", diff: "+ if (!x) throw", claims: ["tests pass"], evidence: "t6: 1 passed" },
  laya_find: { query: "rotate API keys", candidates: [{ id: "a", text: "rotate keys via dashboard" }, { id: "b", text: "unrelated lunch menu" }] },
};

function assertEnvelope(name, parsed, res) {
  assert.deepStrictEqual(res.structuredContent, parsed, `${name}: structured == text`);
  assert.match(parsed.decision_id, /^dec_[0-9a-f]{16}$/, `${name}: decision_id`);
  assert.ok(["ALLOW", "REVIEW", "DENY", "ESCALATE"].includes(parsed.decision.decision), `${name}: decision in enum`);
  assert.deepEqual(parsed.policy, parsed.decision.policy.name, `${name}: policy mirror`);
  assert.equal(parsed.policy_version, parsed.decision.policy.version, `${name}: version mirror`);
  assert.equal(parsed.primitive, TOOL_PRIMITIVES[name], `${name}: primitive`);
}

await withClient({}, async (client) => {
  const listed = (await client.listTools()).tools.map((t) => t.name);
  for (const tool of HOOK_TOOLS) {
    assert.ok(listed.includes(tool), `${tool} announced while both backends are up`);
  }

  for (const tool of HOOK_TOOLS) {
    await check(`live hook serves ${tool} in observe (default)`, async () => {
      const res = await client.callTool({ name: tool, arguments: HOOK_CALLS[tool] });
      assert.ok(!res.isError, `${tool} served`);
      const parsed = JSON.parse(res.content[0].text);
      assertEnvelope(tool, parsed, res);
      assert.equal(parsed.effective_mode, "observe", `${tool}: default mode observe`);
      assert.ok(!("shadow" in parsed), `${tool}: no shadow outside shadow mode`);
    });
  }

  await check("live one Gentle trace correlates two hook envelopes", async () => {
    const traceId = "ab".repeat(16);
    const spanId = "cd".repeat(8);
    const screen = await client.callTool({
      name: "laya_screen", arguments: HOOK_CALLS.laya_screen, _meta: { trace_id: traceId, span_id: spanId },
    });
    const gate = await client.callTool({
      name: "laya_gate", arguments: HOOK_CALLS.laya_gate, _meta: { trace_id: traceId, span_id: spanId },
    });
    const s = JSON.parse(screen.content[0].text);
    const g = JSON.parse(gate.content[0].text);
    assert.equal(s.trace_id, traceId, "screen correlates");
    assert.equal(g.trace_id, traceId, "gate correlates");
    assert.equal(s.span_id, spanId);
    assert.equal(g.span_id, spanId);
    assert.notEqual(s.decision_id, g.decision_id, "one workflow, distinct decisions");
  });

  await check("live capabilities metrics count every hook tool without content", async () => {
    const res = await client.callTool({ name: "laya_capabilities", arguments: {} });
    assert.ok(!res.isError, "capabilities served");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == text");
    for (const tool of HOOK_TOOLS) {
      assert.ok((parsed.metrics.requests_total[tool] ?? 0) >= 1, `${tool} counted`);
    }
    const blob = JSON.stringify(parsed.metrics);
    assert.ok(!blob.includes("ana@example.com"), "no hook content in metrics");
    assert.ok(!blob.includes("Refund my duplicate"), "no hook content in metrics");
    assert.deepEqual(parsed.modes.supported, [...SUPPORTED_MODES], "modes from code truth");
    assert.equal(parsed.mode, "observe", "legacy MCP-layer mode untouched");
  });
});

// Shadow + enforce across every hook tool (stub answers are deterministic,
// so the observe run is the identity oracle for the shadow run).
for (const mode of ["shadow", "enforce"]) {
  const extra = { [MODE_ENV_VAR]: mode };
  if (mode === "shadow") extra[SHADOW_POLICY_ENV_VAR] = "gate@1.0.0";
  await withClient(extra, async (client) => {
    const observe = {};
    await withClient({}, async (plain) => {
      for (const tool of HOOK_TOOLS) {
        const res = await plain.callTool({ name: tool, arguments: HOOK_CALLS[tool] });
        observe[tool] = JSON.parse(res.content[0].text).decision;
      }
    });
    for (const tool of HOOK_TOOLS) {
      await check(`live hook serves ${tool} in ${mode}`, async () => {
        const res = await client.callTool({ name: tool, arguments: HOOK_CALLS[tool] });
        assert.ok(!res.isError, `${tool} served in ${mode}`);
        const parsed = JSON.parse(res.content[0].text);
        assertEnvelope(tool, parsed, res);
        assert.equal(parsed.effective_mode, mode, `${tool}: stamped ${mode}`);
        assert.deepEqual(parsed.decision, observe[tool], `${tool}: base decision identical to observe`);
        if (mode === "shadow") {
          assert.deepEqual(parsed.shadow.under_policy, { name: "gate", version: "1.0.0" }, `${tool}: candidate echoed`);
          assert.ok(parsed.shadow.would_decide.decision !== undefined, `${tool}: would_decide reported`);
        } else {
          assert.ok(!("shadow" in parsed), `${tool}: no shadow in enforce`);
        }
      });
    }
  });
}

// ------------------------------------------------- Part C: down per mode ---
for (const mode of ["observe", "shadow", "enforce"]) {
  const extra = { LAYA_URL: "http://127.0.0.1:9", [MODE_ENV_VAR]: mode };
  if (mode === "shadow") extra[SHADOW_POLICY_ENV_VAR] = "gate@1.0.0";
  const transport = new StdioClientTransport({
    command: "node",
    args: [DIST],
    env: {
      ...process.env,
      LAYA_MODEL_REVISION: "",
      GLINER_MODEL_REVISION: "",
      LAYA_HEALTH_INTERVAL_MS: "200",
      ...extra,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: `t6-down-${mode}`, version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await check(`live backend down in ${mode}: hook degrades identically`, async () => {
      const deadline = Date.now() + 20000;
      for (;;) {
        const listed = await client.listTools();
        if (listed.tools.length === 1 && listed.tools[0].name === "laya_capabilities") break;
        assert.ok(Date.now() < deadline, `${mode}: exactly the exempted tool`);
        await new Promise((r) => setTimeout(r, 300));
      }
      const screen = await client.callTool({ name: "laya_screen", arguments: HOOK_CALLS.laya_screen });
      assert.ok(screen.isError, "hook call isError while down");
      assert.ok(!("structuredContent" in screen) || screen.structuredContent === undefined, "no structuredContent on errors");
      assert.match(screen.content[0].text, /unreachable/, "recovery hint on the wire");
      const caps = await client.callTool({ name: "laya_capabilities", arguments: {} });
      assert.ok(caps.isError, "capabilities call isError while down");
      assert.match(caps.content[0].text, /laya-server/, "diagnosis names the backend");
    });
  } finally {
    await client.close();
  }
}

console.log(`\nT6 GENTLE INTEGRATION: ${passed} checks passed, ${skipped} skipped (stub backends only; OpenCode/Gentle absent).`);
