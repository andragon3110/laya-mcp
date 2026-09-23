import type { LayaClient } from "../client.js";
import { findEvidence, winnerOf } from "../evidence.js";
import { LIMITS, assertCount } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const findTool: ToolDefinition = {
  name: "laya_find",
  description:
    "Pick the best candidate id for a query from a list, or report that none of them answers. " +
    "Cheaper than calling the main LLM for routing decisions over up to 250 candidates. " +
    "Lists above 250 are rejected with input_too_large (no silent truncation). " +
    "Returns the winner with its raw, uncalibrated distribution and winner_probability (never a " +
    "confidence) plus the deterministic ALLOW/ESCALATE `decision` from the versioned find@1.0.0 policy. " +
    "An ESCALATE decision is authoritative: do not act on the winner when the decision escalates.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Plain-language query the candidate should answer." },
      candidates: {
        type: "array",
        maxItems: LIMITS.maxFindCandidates,
        description: "Candidate list (max 250). Each entry needs `id` (returned verbatim) and `text` (the candidate's body).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "text"],
        },
      },
    },
    required: ["query", "candidates"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    assertCount(
      candidates.length,
      LIMITS.maxFindCandidates,
      "candidates",
      `laya_find accepts at most ${LIMITS.maxFindCandidates} candidates per call; split the list and merge winners`,
    );
    const criteria: Record<string, string> = {};
    for (const c of candidates) {
      if (c && typeof c.id === "string") criteria[c.id] = String(c.text ?? "").slice(0, 240);
    }
    criteria.none = "None of the candidates addresses the query.";
    return {
      exists: {
        type: "choice",
        instructions: `Pick the candidate that best answers the query: "${args.query ?? ""}". If none of them address it, choose 'none'.`,
        criteria,
      },
    };
  },
};

/**
 * P1-T6 (breaking): `laya_find` routes the winner through the engine. The
 * legacy `probabilities` dict (uncalibrated shares labelled as a confidence
 * probability) is now `distribution` with the honest `winner_probability`
 * top share (null when the dict came back empty), and the output carries
 * the ALLOW-or-ESCALATE `decision` from find@1.0.0. The winner value itself
 * is unchanged (firm, unique, above-baseline winners still ALLOW); T3
 * abstention bands (none/empty/tie/weak) are now authoritative via the
 * engine ESCALATE exit -- consumers must not act on the winner when the
 * decision escalates. No threshold literal lives here: the 1/N weak-winner
 * baseline reads context.candidateCount inside the policy.
 */
export async function handleFind(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const result = await runTool(client, args, findTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const choice = a.exists?.choice ?? "none";
    const distribution = (a.exists?.probabilities as Record<string, number> | undefined) ?? null;
    const candidates = Array.isArray(args.candidates) ? args.candidates : [];
    const { evidence, abstention } = findEvidence(raw, {
      choice: typeof a.exists?.choice === "string" ? a.exists.choice : null,
      distribution,
      candidateCount: candidates.length,
    });
    // P1-T6: decision owned by the engine (shared table resolved for uniformity;
    // find@1.0.0 applies no numeric cut -- firmness is presence + uniqueness).
    const { thresholds } = getPolicy("find", "1.0.0");
    const decision = evaluate(
      {
        evidence,
        abstention,
        context: { candidateCount: candidates.length, query_chars: String(args.query ?? "").length },
        risk: "normal",
        policy: { name: "find", version: "1.0.0" },
      },
      { thresholds },
    );
    return JSON.stringify(
      {
        winner: choice,
        exists: choice !== "none",
        distribution: distribution ?? {},
        winner_probability: winnerOf(distribution ?? null),
        decision,
        latency_ms: raw.latencyMs,
        evidence,
        abstention,
      },
      null,
      2,
    );
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
