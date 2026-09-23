import type { LayaClient } from "../client.js";
import { compareEvidence, winnerOf } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const compareTool: ToolDefinition = {
  name: "laya_compare",
  description:
    "Compare two passages overall and optionally per aspect. Returns relation (same_fact / contradicts / " +
    "different_facts) with the raw, uncalibrated distribution and winner_probability (never a calibrated " +
    "probability) plus the deterministic ALLOW/ESCALATE `decision` from the versioned compare@1.0.0 policy. " +
    "Every firm judgment set is reportable (the relation VALUE never gates); an ESCALATE decision is " +
    "authoritative. Use for source reconciliation, changelog-vs-doc drift, " +
    "and summary-vs-source validation. Passages at most 20,000 chars each, at most 32 aspects per call " +
    "(larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      passage_a: { type: "string", maxLength: LIMITS.maxStateChars, description: "First passage (max 20,000 chars)." },
      passage_b: { type: "string", maxLength: LIMITS.maxStateChars, description: "Second passage (max 20,000 chars)." },
      aspects: {
        type: "array",
        maxItems: LIMITS.maxCompareAspects,
        items: { type: "string" },
        description: "Optional aspects to evaluate independently (max 32, e.g. price, date, scope).",
      },
    },
    required: ["passage_a", "passage_b"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const aspects = Array.isArray(args.aspects) ? args.aspects : [];
    assertLength(
      String(args.passage_a ?? ""),
      LIMITS.maxStateChars,
      "passage_a",
      `passage_a exceeds ${LIMITS.maxStateChars} chars; compare per section instead`,
    );
    assertLength(
      String(args.passage_b ?? ""),
      LIMITS.maxStateChars,
      "passage_b",
      `passage_b exceeds ${LIMITS.maxStateChars} chars; compare per section instead`,
    );
    assertCount(
      aspects.length,
      LIMITS.maxCompareAspects,
      "aspects",
      `at most ${LIMITS.maxCompareAspects} aspects per call to stay within the ${LIMITS.maxQuestions}-question server budget`,
    );
    const relationCriteria = {
      same_fact: "Both passages make the same assertion.",
      contradicts: "The two passages contradict each other.",
      different_facts: "The passages do not both make a comparable assertion.",
    };
    const state = {
      passage_a: String(args.passage_a ?? ""),
      passage_b: String(args.passage_b ?? ""),
    };
    const out: Record<string, unknown> = {
      overall: {
        type: "choice",
        instructions: "How do the two passages relate overall?",
        criteria: relationCriteria,
      },
    };
    aspects.forEach((aspect, i) => {
      out[`aspect_${i}_${String(aspect).replace(/\W/g, "_")}`] = {
        type: "choice",
        instructions: `For the aspect '${aspect}', how do the passages relate?`,
        criteria: relationCriteria,
      };
    });
    // Attach state via the predict call: the client passes the whole args object as state.
    void state;
    return out;
  },
};

/**
 * P1-T6 (breaking): `laya_compare` routes the relation judgments through
 * the engine. Each judgment's legacy `confidence` dict (raw choice shares
 * labelled as a calibrated probability) is now `distribution` with the
 * honest `winner_probability` top share (null when empty), and the output
 * carries the ALLOW-or-ESCALATE `decision` from compare@1.0.0. The
 * relation VALUE never gates (same_fact, contradicts, and different_facts
 * are all reportable); T3 abstention (missing overall/aspect answers) is
 * now authoritative via the engine ESCALATE exit. No threshold literal
 * lives here: v1 has no cut point.
 */
export async function handleCompare(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const aspects = Array.isArray(args.aspects) ? args.aspects : [];
  const result = await runTool(client, args, compareTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const aspectInputs = aspects.map((aspect, i) => {
      const key = `aspect_${i}_${String(aspect).replace(/\W/g, "_")}`;
      return {
        key,
        label: String(aspect),
        choice: typeof a[key]?.choice === "string" ? a[key].choice : null,
        distribution: (a[key]?.probabilities as Record<string, number> | undefined) ?? null,
        missing: a[key] == null,
      };
    });
    const { evidence, abstention } = compareEvidence(raw, {
      overall: {
        choice: typeof a.overall?.choice === "string" ? a.overall.choice : null,
        distribution: (a.overall?.probabilities as Record<string, number> | undefined) ?? null,
        missing: a.overall == null,
      },
      aspects: aspectInputs,
    });
    // P1-T6: decision owned by the engine.
    const { thresholds } = getPolicy("compare", "1.0.0");
    const decision = evaluate(
      {
        evidence,
        abstention,
        context: { aspect_count: aspects.length },
        risk: "normal",
        policy: { name: "compare", version: "1.0.0" },
      },
      { thresholds },
    );
    const judgmentOf = (choice: string | undefined, distribution: Record<string, number> | undefined) => ({
      relation: choice,
      distribution: distribution ?? {},
      winner_probability: winnerOf(distribution ?? null),
    });
    const out: Record<string, unknown> = {
      overall: judgmentOf(a.overall?.choice, a.overall?.probabilities),
      decision,
      latency_ms: raw.latencyMs,
    };
    aspects.forEach((aspect, i) => {
      const key = `aspect_${i}_${String(aspect).replace(/\W/g, "_")}`;
      if (a[key]) {
        out[aspect as string] = judgmentOf(a[key].choice, a[key].probabilities);
      }
    });
    out.evidence = evidence;
    out.abstention = abstention;
    return JSON.stringify(out, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
