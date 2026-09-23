/**
 * Fase-6 T4 modes + declarative invocation tests: observe/shadow/enforce
 * config, decision invariance, and exposure.
 *
 * Part A (offline, no server): dist/policy/mode.js + dist/policy/engine.js
 * + dist/envelope.js + dist/tool.js + tool outputSchemas --
 *   - resolveMode: default observe; invalid falls back (never throws);
 *     global LAYA_MODE; per-tool LAYA_MODE_<TOOL> wins; case-insensitive;
 *   - resolveShadowRef/parsePolicyRef: name@version parsing; malformed or
 *     absent yields null (never throws); per-tool wins;
 *   - observe records without changing: evaluateWithMode decision deep-
 *     equals evaluate on the same input, shadow null;
 *   - shadow never alters the flow: base decision deep-equals evaluate on
 *     the base input even when the candidate disagrees; shadow carries
 *     would_decide (== evaluate on the candidate input) + under_policy;
 *     unknown candidate or missing candidate yields shadow null with the
 *     base decision intact;
 *   - enforce decides: decision deep-equals evaluate, shadow null,
 *     effective_mode enforce;
 *   - envelope stamps effective_mode (default observe, override wins) and
 *     preserves a handler shadow verbatim (structured == text); metrics
 *     record the call with no shadow/content leakage;
 *   - capabilities schema: modes{...} present but NOT required (pre-T4
 *     outputs keep validating); legacy mode enum still exactly [observe];
 *     every judgment outputSchema describes optional `shadow`.
 *
 * Part B (live round-trip, stub laya backend): one laya_screen call under
 * LAYA_MODE=shadow + LAYA_SHADOW_POLICY=gate@1.0.0 -- decision identical
 * to the observe run, shadow reported with under_policy, effective_mode
 * shadow; laya_capabilities reports modes{supported,effective,default}
 * with legacy mode untouched; a second server with per-tool override
 * (global enforce + LAYA_MODE_LAYA_SCREEN=observe) proves per-tool wins.
 *
 * Part C (hooks table documented, presence only -- no Gentle here):
 * examples/gentle-hooks.yaml + examples/gentle-hooks.md exist and name
 * the four hooks, their tools, and the default mode.
 *
 * Run after build from the repo root: node tests/fase6_t4_modes.mjs
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { evaluate } from "../dist/policy/engine.js";
import {
  DEFAULT_MODE,
  MODE_ENV_VAR,
  SHADOW_POLICY_ENV_VAR,
  SUPPORTED_MODES,
  effectiveMode,
  evaluateForTool,
  evaluateWithMode,
  parsePolicyRef,
  resolveMode,
  resolveShadowRef,
  shadowPolicyEnvVar,
  toolModeEnvVar,
} from "../dist/policy/mode.js";
import { THRESHOLDS_V1 } from "../dist/policy/thresholds.js";
import { augmentEnvelope, buildCallResult } from "../dist/envelope.js";
import { envelopeMetadataProperties, shadowSchema } from "../dist/tool.js";
import { getMetricsSnapshot, resetMetrics } from "../dist/metrics.js";
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
const DIST = path.join(HERE, "..", "dist", "index.js");
const JUDGMENT = [screenTool, verifyTool, findTool, rerankTool, classifyTool, decideTool, compareTool, extractTool, reviewTool, gateTool, piiTool];

let passed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`ok - ${name}`);
    });
}

// Review-shaped input where base (review) and candidate (gate) disagree:
// safe_to_apply 0.3 is ESCALATE under review (<= 0.5) but REVIEW under gate
// (low safety alone reviews, never escalates).
const RAW = { model: "t4-test", routing: {} };
function reviewInput(policy = { name: "review", version: "1.0.0" }) {
  const { evidence, abstention } = reviewEvidence(RAW, {
    correctness: 2,
    spec_match: 2,
    test_gap: 0,
    blast_radius: 0,
    safe_to_apply: 0.3,
  });
  return { evidence, abstention, context: { diff_chars: 10 }, risk: "normal", policy };
}

// ---------------------------------------------------------- Part A: unit ---
await check("resolveMode: default/invalid/global/per-tool/case", () => {
  assert.equal(resolveMode({}), "observe", "unset defaults to observe");
  assert.equal(resolveMode({ [MODE_ENV_VAR]: "bogus" }), "observe", "invalid falls back, never throws");
  assert.equal(resolveMode({ [MODE_ENV_VAR]: "" }), "observe", "blank falls back");
  assert.equal(resolveMode({ [MODE_ENV_VAR]: "shadow" }), "shadow", "global shadow");
  assert.equal(resolveMode({ [MODE_ENV_VAR]: "ENFORCE" }), "enforce", "case-insensitive");
  assert.equal(toolModeEnvVar("laya_screen"), "LAYA_MODE_LAYA_SCREEN", "per-tool env naming");
  assert.equal(
    resolveMode({ [MODE_ENV_VAR]: "enforce", [toolModeEnvVar("laya_screen")]: "observe" }, "laya_screen"),
    "observe",
    "per-tool wins over global",
  );
  assert.equal(resolveMode({ [MODE_ENV_VAR]: "enforce" }, "laya_gate"), "enforce", "global applies without override");
  assert.equal(DEFAULT_MODE, "observe", "documented default");
  assert.deepEqual([...SUPPORTED_MODES], ["observe", "shadow", "enforce"], "supported modes code truth");
});

await check("parsePolicyRef/resolveShadowRef: explicit candidate or null", () => {
  assert.deepEqual(parsePolicyRef("review@1.0.0"), { name: "review", version: "1.0.0" }, "name@version parses");
  assert.equal(parsePolicyRef("review"), null, "missing version rejected");
  assert.equal(parsePolicyRef("@1.0.0"), null, "missing name rejected");
  assert.equal(parsePolicyRef("review@"), null, "empty version rejected");
  assert.equal(parsePolicyRef(null), null, "non-string rejected");
  assert.equal(resolveShadowRef({}), null, "absent yields null (no shadow)");
  assert.deepEqual(
    resolveShadowRef({ [SHADOW_POLICY_ENV_VAR]: "gate@1.0.0" }),
    { name: "gate", version: "1.0.0" },
    "global candidate",
  );
  assert.equal(shadowPolicyEnvVar("laya_screen"), "LAYA_SHADOW_POLICY_LAYA_SCREEN", "per-tool candidate naming");
  assert.deepEqual(
    resolveShadowRef({
      [SHADOW_POLICY_ENV_VAR]: "gate@1.0.0",
      [shadowPolicyEnvVar("laya_screen")]: "review@1.0.0",
    }, "laya_screen"),
    { name: "review", version: "1.0.0" },
    "per-tool candidate wins",
  );
});

await check("observe records without changing: decision intact, no shadow", () => {
  const input = reviewInput();
  const base = evaluate(input, { thresholds: THRESHOLDS_V1 });
  const out = evaluateWithMode(input, { thresholds: THRESHOLDS_V1, mode: "observe" });
  assert.deepEqual(out.decision, base, "observe decision == engine decision");
  assert.equal(out.shadow, null, "observe never reports shadow");
  assert.equal(out.effective_mode, "observe");
  const def = evaluateWithMode(input, { thresholds: THRESHOLDS_V1 });
  assert.equal(def.effective_mode, "observe", "mode defaults to observe");
});

await check("shadow never alters decision and reports would_decide", () => {
  const input = reviewInput();
  const base = evaluate(input, { thresholds: THRESHOLDS_V1 });
  assert.equal(base.decision, "ESCALATE", "base review outcome pins the fixture");
  const candidate = { name: "gate", version: "1.0.0" };
  const expectedShadow = evaluate({ ...input, policy: candidate }, { thresholds: THRESHOLDS_V1 });
  assert.equal(expectedShadow.decision, "REVIEW", "candidate disagrees (the point of the fixture)");
  const out = evaluateWithMode(input, { thresholds: THRESHOLDS_V1, mode: "shadow", shadowPolicy: candidate });
  assert.deepEqual(out.decision, base, "shadow leaves the base decision byte-identical");
  assert.deepEqual(out.shadow.would_decide, expectedShadow, "would_decide == candidate evaluation");
  assert.deepEqual(out.shadow.under_policy, candidate, "under_policy echoes the explicit ref");
  assert.equal(out.effective_mode, "shadow");
});

await check("shadow without a resolvable candidate keeps the base decision", () => {
  const input = reviewInput();
  const base = evaluate(input, { thresholds: THRESHOLDS_V1 });
  const noCandidate = evaluateWithMode(input, { thresholds: THRESHOLDS_V1, mode: "shadow", shadowPolicy: null });
  assert.deepEqual(noCandidate.decision, base, "decision intact");
  assert.equal(noCandidate.shadow, null, "no shadow reported");
  const unknown = evaluateWithMode(input, {
    thresholds: THRESHOLDS_V1,
    mode: "shadow",
    shadowPolicy: { name: "nope", version: "9.9.9" },
  });
  assert.deepEqual(unknown.decision, base, "unknown candidate never breaks the flow");
  assert.equal(unknown.shadow, null, "unknown candidate reports no shadow");
});

await check("enforce decides: engine decision, no shadow", () => {
  const input = reviewInput();
  const base = evaluate(input, { thresholds: THRESHOLDS_V1 });
  const out = evaluateWithMode(input, { thresholds: THRESHOLDS_V1, mode: "enforce" });
  assert.deepEqual(out.decision, base, "enforce decision == engine decision");
  assert.equal(out.shadow, null, "enforce reports no shadow");
  assert.equal(out.effective_mode, "enforce");
});

await check("envelope stamps effective_mode and preserves handler shadow", () => {
  const saved = process.env[MODE_ENV_VAR];
  delete process.env[MODE_ENV_VAR];
  try {
    const probe = {
      decision: { decision: "ESCALATE", reason_codes: ["review_escalate"], policy: { name: "review", version: "1.0.0" } },
      latency_ms: 4,
      evidence: { model: "m", revision: null },
    };
    const def = augmentEnvelope("laya_review", { ...probe });
    assert.equal(def.effective_mode, "observe", "default mode stamped");
    const forced = augmentEnvelope("laya_review", { ...probe }, undefined, "enforce");
    assert.equal(forced.effective_mode, "enforce", "explicit override wins");
    const withShadow = {
      ...probe,
      shadow: {
        would_decide: { decision: "REVIEW", reason_codes: ["gate_review"], policy: { name: "gate", version: "1.0.0" } },
        under_policy: { name: "gate", version: "1.0.0" },
      },
    };
    const res = buildCallResult("laya_review", JSON.stringify(withShadow), undefined, "shadow");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == text with shadow");
    assert.deepEqual(parsed.shadow, withShadow.shadow, "handler shadow flows through untouched");
    assert.equal(parsed.decision.decision, "ESCALATE", "base decision untouched by the shadow");
    assert.equal(parsed.effective_mode, "shadow", "effective mode visible");
  } finally {
    if (saved !== undefined) process.env[MODE_ENV_VAR] = saved;
    else delete process.env[MODE_ENV_VAR];
  }
});

await check("observe records without changing: metrics carry no shadow or content", () => {
  resetMetrics();
  const canary = "canary-t4-551-shadow";
  const env = {
    decision: { decision: "ALLOW", reason_codes: ["r"], policy: { name: "screen", version: "1.0.0" } },
    shadow: {
      would_decide: { decision: "REVIEW", reason_codes: ["q"], policy: { name: "gate", version: "1.0.0" } },
      under_policy: { name: "gate", version: "1.0.0" },
    },
    assessment: canary,
    latency_ms: 6,
    evidence: { model: "stub-laya", revision: null },
    abstention: { abstained: false, reason: null },
  };
  buildCallResult("laya_screen", JSON.stringify(env));
  const snap = getMetricsSnapshot();
  assert.equal(snap.requests_total.laya_screen, 1, "call counted");
  assert.deepEqual(snap.policy_decisions.laya_screen, { ALLOW: 1 }, "decision counted from decision, not shadow");
  const snapText = JSON.stringify(snap);
  assert.ok(!snapText.includes(canary), "no content in metrics");
  assert.ok(!snapText.includes("shadow"), "no shadow vocabulary in metrics");
  resetMetrics();
});

await check("capabilities schema exposes modes without touching legacy mode", () => {
  const out = capabilitiesTool.outputSchema;
  assert.ok(out.properties?.modes !== undefined, "modes described");
  assert.ok(!out.required.includes("modes"), "modes OPTIONAL (pre-T4 outputs keep validating)");
  assert.deepEqual(out.properties.modes.required, ["supported", "effective", "default"], "modes shape");
  assert.equal(out.properties?.mode?.enum?.length, 1, "legacy mode enum still exactly [observe]");
  assert.deepEqual([...SUPPORTED_MODES], ["observe", "shadow", "enforce"]);
  // effectiveMode() reads the live env: default observe without overrides.
  const saved = process.env[MODE_ENV_VAR];
  delete process.env[MODE_ENV_VAR];
  try {
    assert.equal(effectiveMode(), "observe", "global effective defaults to observe");
  } finally {
    if (saved !== undefined) process.env[MODE_ENV_VAR] = saved;
    else delete process.env[MODE_ENV_VAR];
  }
});

await check("judgment outputSchemas describe optional shadow; fragment counts twelve", () => {
  // Fase-6 T4 intentional evolution (minor-additive): eleven T3 keys plus
  // effective_mode. Still all OPTIONAL (required lists untouched), so
  // stored pre-T4 outputs keep validating -- only this count moves.
  const frag = envelopeMetadataProperties();
  assert.equal(Object.keys(frag).length, 12, "twelve envelope keys (eleven T3 + effective_mode T4)");
  assert.deepEqual(frag.effective_mode.enum, ["observe", "shadow", "enforce"], "mode vocabulary in the fragment");
  for (const t of JUDGMENT) {
    assert.ok(t.outputSchema.properties?.shadow !== undefined, `${t.name} describes shadow (T4 gap closed)`);
    assert.ok(!t.outputSchema.required.includes("shadow"), `${t.name} keeps shadow optional`);
  }
  const good = {
    would_decide: { decision: "REVIEW", reason_codes: ["gate_review"], policy: { name: "gate", version: "1.0.0" } },
    under_policy: { name: "gate", version: "1.0.0" },
  };
  for (const t of JUDGMENT) {
    const sub = t.outputSchema.properties.shadow;
    const errs = [];
    if (sub.type !== "object") errs.push("shadow must be an object schema");
    if (!sub.properties?.would_decide || !sub.properties?.under_policy) errs.push("shadow shape incomplete");
    assert.deepEqual(errs, [], `${t.name}: shadow descriptor shape`);
  }
  assert.deepEqual(shadowSchema().required, ["would_decide", "under_policy"], "shadow helper shape");
  void good;
});

await check("evaluateForTool resolves env per call (I/O boundary, never cached)", () => {
  const savedMode = process.env[MODE_ENV_VAR];
  const savedShadow = process.env[SHADOW_POLICY_ENV_VAR];
  try {
    delete process.env[MODE_ENV_VAR];
    delete process.env[SHADOW_POLICY_ENV_VAR];
    const input = reviewInput();
    const base = evaluate(input, { thresholds: THRESHOLDS_V1 });
    const viaHelper = evaluateForTool("laya_review", input, { thresholds: THRESHOLDS_V1 });
    assert.deepEqual(viaHelper.decision, base, "default helper path == engine");
    assert.equal(viaHelper.shadow, null);
    assert.equal(viaHelper.effective_mode, "observe");
  } finally {
    if (savedMode !== undefined) process.env[MODE_ENV_VAR] = savedMode;
    else delete process.env[MODE_ENV_VAR];
    if (savedShadow !== undefined) process.env[SHADOW_POLICY_ENV_VAR] = savedShadow;
    else delete process.env[SHADOW_POLICY_ENV_VAR];
  }
});

console.log(`\nT4 offline modes: ${passed} checks passed (no server involved).`);

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

async function withClient(extraEnv, fn) {
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
      ...extraEnv,
    },
  });
  const client = new Client({ name: "t4-modes", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const deadline = Date.now() + 20000;
    for (;;) {
      const listed = await client.listTools();
      if (listed.tools.some((t) => t.name === "laya_screen")) break;
      assert.ok(Date.now() < deadline, "laya_screen advertised");
      await new Promise((r) => setTimeout(r, 300));
    }
    await fn(client);
  } finally {
    await client.close();
    laya.close();
  }
}

// Stub noul 0.85 trips screen_injection_block -> DENY; the same screen
// evidence under gate@1.0.0 lacks safe_to_apply -> gate_missing_signal
// ESCALATE. The two disagree, so the test proves non-interference.
await withClient({ [MODE_ENV_VAR]: "shadow", [SHADOW_POLICY_ENV_VAR]: "gate@1.0.0" }, async (client) => {
  await check("live shadow: decision unchanged, would_decide reported, mode visible", async () => {
    const res = await client.callTool({ name: "laya_screen", arguments: { text: "hello", purpose: "t4" } });
    assert.ok(!res.isError, "screen served");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == text");
    assert.equal(parsed.decision.decision, "DENY", "base screen decision intact under shadow");
    assert.deepEqual(parsed.shadow.under_policy, { name: "gate", version: "1.0.0" }, "explicit candidate echoed");
    assert.equal(parsed.shadow.would_decide.decision, "ESCALATE", "candidate evaluated on the same input");
    assert.equal(parsed.shadow.would_decide.policy.name, "gate", "would_decide carries the candidate identity");
    assert.equal(parsed.effective_mode, "shadow", "effective mode visible on the envelope");
  });

  await check("live capabilities: modes supported+effective, legacy mode untouched", async () => {
    const res = await client.callTool({ name: "laya_capabilities", arguments: {} });
    assert.ok(!res.isError, "capabilities served");
    const parsed = JSON.parse(res.content[0].text);
    assert.deepStrictEqual(res.structuredContent, parsed, "structured == text");
    assert.deepEqual(parsed.modes.supported, ["observe", "shadow", "enforce"], "supported from code truth");
    assert.equal(parsed.modes.effective, "shadow", "global effective resolved live");
    assert.equal(parsed.modes.default, "observe", "default advertised");
    assert.equal(parsed.mode, "observe", "legacy MCP-layer mode untouched");
    assert.ok((parsed.metrics.requests_total.laya_screen ?? 0) >= 1, "shadow call recorded like any call");
  });
});

await withClient(
  { [MODE_ENV_VAR]: "enforce", [toolModeEnvVar("laya_screen")]: "observe" },
  async (client) => {
    await check("live per-tool mode wins over global; enforce visible elsewhere", async () => {
      const screen = await client.callTool({ name: "laya_screen", arguments: { text: "hi", purpose: "t4" } });
      const parsed = JSON.parse(screen.content[0].text);
      assert.equal(parsed.effective_mode, "observe", "per-tool override wins");
      assert.ok(!("shadow" in parsed), "no shadow outside shadow mode");
      const caps = await client.callTool({ name: "laya_capabilities", arguments: {} });
      const capsParsed = JSON.parse(caps.content[0].text);
      assert.equal(capsParsed.modes.effective, "enforce", "global effective reported");
      assert.equal(capsParsed.mode, "observe", "legacy mode still observe");
    });
  },
);

// ------------------------------------------------- Part C: hooks table ----
await check("hooks table documented as Gentle-side config (presence only)", () => {
  const yaml = fs.readFileSync(path.join(HERE, "..", "examples", "gentle-hooks.yaml"), "utf8");
  const md = fs.readFileSync(path.join(HERE, "..", "examples", "gentle-hooks.md"), "utf8");
  for (const hook of [
    "external_content.pre_context",
    "implementation.post_write",
    "completion.pre_complete",
    "retrieval.candidate_selection",
  ]) {
    assert.ok(yaml.includes(hook), `yaml names hook ${hook}`);
    assert.ok(md.includes(hook), `doc names hook ${hook}`);
  }
  for (const tool of ["laya_screen", "laya_pii", "laya_review", "laya_gate", "laya_find"]) {
    assert.ok(yaml.includes(tool), `yaml routes tool ${tool}`);
    assert.ok(md.includes(tool), `doc routes tool ${tool}`);
  }
  for (const mode of ["observe", "shadow", "enforce"]) {
    assert.ok(yaml.includes(mode), `yaml documents mode ${mode}`);
    assert.ok(md.includes(mode), `doc documents mode ${mode}`);
  }
  assert.ok(yaml.includes("on_missing_tools: ignore"), "hooks never force calls when tools are absent");
  assert.ok(yaml.includes("defaults:") && yaml.includes("mode: observe"), "non-intrusive default declared");
});

console.log(`\nT4 MODES: ${passed} checks passed.`);
