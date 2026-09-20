import type { LayaClient } from "../client.js";
import { type ToolDefinition, runTool } from "../tool.js";

export const extractTool: ToolDefinition = {
  name: "laya_extract",
  description:
    "Pull structured field values from a document. The caller supplies a regex per field, " +
    "Laya picks among the matches, and the returned value is always a verbatim substring of the document " +
    "(never model-generated). Use for prices, versions, dates, IDs -- anywhere regex can find candidates.",
  inputSchema: {
    type: "object",
    properties: {
      document: { type: "string", description: "Source document." },
      fields: {
        type: "array",
        description: "Fields to extract. Each needs `id`, `pattern` (regex string), and `description`.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            pattern: { type: "string", description: "ECMAScript regex (no flags)." },
            description: { type: "string", description: "What the field means." },
          },
          required: ["id", "pattern", "description"],
        },
      },
    },
    required: ["document", "fields"],
    additionalProperties: false,
  },
  buildQuestions: (args) => {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    const document = String(args.document ?? "");
    const out: Record<string, unknown> = {};
    fields.forEach((f: { id?: string; pattern?: string; description?: string }, i: number) => {
      if (!f || typeof f.id !== "string" || typeof f.pattern !== "string") return;
      let candidates: string[] = [];
      try {
        const re = new RegExp(f.pattern, "g");
        candidates = Array.from(document.matchAll(re), (m) => m[0]).slice(0, 20);
      } catch {
        candidates = [];
      }
      const criteria: Record<string, string> = {};
      candidates.forEach((c, idx) => {
        criteria[`m${idx}`] = c.slice(0, 240);
      });
      criteria.none = "None of the regex matches is the true value of the field.";
      out[`extract_${i}_${f.id}`] = {
        type: "choice",
        instructions:
          `Pick the substring candidate that is the real value of field "${f.id}". ` +
          `Field meaning: ${f.description ?? ""}.`,
        criteria,
      };
    });
    return out;
  },
};

export async function handleExtract(client: LayaClient, args: Record<string, unknown>): Promise<string> {
  const fields = Array.isArray(args.fields) ? args.fields : [];
  const result = await runTool(client, args, extractTool.buildQuestions(args), (raw) => {
    const a = raw.answers as Record<string, { choice: string; probabilities: Record<string, number> }>;
    const results: Array<Record<string, unknown>> = [];
    fields.forEach((f: { id?: string; pattern?: string }, i: number) => {
      if (!f || typeof f.id !== "string" || typeof f.pattern !== "string") return;
      const key = `extract_${i}_${f.id}`;
      const ans = a[key];
      const choice = ans?.choice ?? "none";
      const value = choice === "none" ? null : choice;
      results.push({
        id: f.id,
        value,
        status: choice === "none" ? "not_found" : "extracted",
        confidence: ans ? Math.max(...Object.values(ans.probabilities ?? {})) : 0,
      });
    });
    return JSON.stringify({ results, latency_ms: raw.latencyMs }, null, 2);
  });
  if (!result.ok) throw new Error(result.error);
  return result.content;
}
