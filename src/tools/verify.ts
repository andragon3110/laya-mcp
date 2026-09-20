import type { LayaClient } from "../client.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const verifyTool: ToolDefinition = {
  name: "laya_verify",
  description:
    "Verify one or more claims against the supplied evidence. Each claim is judged independently " +
    "(verified / contradicted / unsupported) with a calibrated probability. Use to fact-check PR descriptions, " +
    "agent briefs, or any statement before relying on it.",
  inputSchema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: { type: "string" },
        description: "Claims to verify. One independent judgment per claim.",
      },
      evidence: {
        type: "string",
        description: "Evidence text. The agent's instructions for what to judge are explicit; do not let other fields leak in.",
      },
    },
    required: ["claims", "evidence"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const claims = Array.isArray(args.claims) ? args.claims : [];
    const out: Record<string, unknown> = {};
    claims.forEach((claim, i) => {
      out[`claim_${i}`] = {
        type: "noul",
        instructions: `Decide if the following claim is directly supported by the evidence. Claim: "${claim}"`,
        criteria: {
          true: "Evidence directly states or implies the claim.",
          false: "Evidence contradicts the claim or does not address it.",
        },
      };
    });
    return out;
  },
};

export async function handleVerify(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const claims = Array.isArray(args.claims) ? args.claims : [];
  const result = await runTool(client, args, verifyTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { noul: number }>;
    const verdicts = claims.map((claim, i) => {
      const prob = a[`claim_${i}`]?.noul ?? 0;
      const verdict = prob >= 0.8 ? "verified" : prob >= 0.4 ? "unsupported" : "contradicted";
      return { claim, probability: prob, verdict };
    });
    const summary = {
      verified: verdicts.filter((v) => v.verdict === "verified").length,
      unsupported: verdicts.filter((v) => v.verdict === "unsupported").length,
      contradicted: verdicts.filter((v) => v.verdict === "contradicted").length,
    };
    return JSON.stringify({ summary, verdicts, latency_ms: raw.latencyMs }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
