/**
 * `laya_redact` -- deterministic PII redaction transform (tool 14).
 *
 * `laya_pii` detects and `laya_extract` locates; this closes the loop for
 * pipelines that must clean text before logging, storing, or forwarding it.
 * Pure function of its arguments: no backend, no policy decision, no state
 * (annotations stay read-only; the contract stretch is documented in
 * MCP_CONTRACT.md §3 -- a transform, not a judgment).
 *
 * Offsets are Unicode CODE POINTS (they come from the Python GLiNER
 * producer, and pii speaks of "chars"), converted internally to UTF-16 for
 * slicing -- emoji-safe by contract, pinned by test.
 *
 * Overlap rule (deterministic): sort by start asc, end desc; drop any span
 * starting before the previous span's end (earliest wins, longest wins ties).
 * Strategies: `label` (default) `[REDACTED:<type>]`, `placeholder`
 * `[REDACTED]`. Missing `entity_type` under `label` falls back to the
 * placeholder marker for that span (never invents a type).
 */
import {
  type ToolDefinition,
  READONLY_TOOL_ANNOTATIONS,
  envelopeMetadataProperties,
} from "../tool.js";

export const REDACT_STRATEGIES = ["label", "placeholder"] as const;

export interface RedactFinding {
  start: number;
  end: number;
  entity_type?: unknown;
}

/** Code-point length of a JS string (astral chars count once). */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * Slice text by code-point range [start, end). Throws invalid_argument on
 * any malformed span; pure and total otherwise.
 */
export function redactText(
  text: string,
  findings: RedactFinding[],
  strategy: string,
): string {
  if (strategy !== "label" && strategy !== "placeholder") {
    throw invalidArg(`strategy must be one of label|placeholder (got ${JSON.stringify(strategy) ?? "undefined"})`);
  }
  if (!Array.isArray(findings) || findings.length === 0) {
    throw invalidArg("findings must be a non-empty array (redacting nothing is a caller bug)");
  }
  const len = codePointLength(text);
  for (const [i, f] of findings.entries()) {
    if (typeof f !== "object" || f === null) throw invalidArg(`findings[${i}] must be an object`);
    if (!Number.isInteger(f.start) || !Number.isInteger(f.end)) {
      throw invalidArg(`findings[${i}].start/end must be integers`);
    }
    if (f.start < 0 || f.end > len || f.start >= f.end) {
      throw invalidArg(
        `findings[${i}] out of range: need 0 <= start < end <= ${len} (got ${f.start}, ${f.end})`,
      );
    }
  }
  const ordered = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
  // Code-point → UTF-16 index map (one entry per code point + sentinel).
  const units: number[] = [0];
  for (const ch of text) units.push(units[units.length - 1] + ch.length);
  let out = "";
  let cursor = 0; // code-point cursor into text
  for (const f of ordered) {
    if (f.start < cursor) continue; // overlapped by an earlier (or longer tied) span
    out += text.slice(units[cursor], units[f.start]);
    const type = typeof f.entity_type === "string" && f.entity_type.trim() !== "" ? f.entity_type : null;
    out += strategy === "label" && type !== null ? `[REDACTED:${type}]` : "[REDACTED]";
    cursor = f.end;
  }
  out += text.slice(units[cursor]);
  return out;
}

export const redactTool: ToolDefinition = {
  name: "laya_redact",
  description:
    "Deterministically redact caller-supplied spans (e.g. from laya_pii/laya_extract) from text before " +
    "logging, storing, or forwarding it. Pure transform: no backend, no judgment, same input always yields " +
    "the same output. Offsets are Unicode code points (matches the GLiNER producer). Overlaps resolve " +
    "deterministically (earliest wins, longest wins ties). Strategies: label (default, [REDACTED:<type>]) " +
    "or placeholder ([REDACTED]). Needs no backend: advertised and callable even with every sidecar down.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Text to redact (non-empty).",
      },
      findings: {
        type: "array",
        description: "Non-empty span list {start, end, entity_type?} in Unicode code points.",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            start: { type: "integer", minimum: 0 },
            end: { type: "integer", minimum: 1 },
            entity_type: { type: "string" },
          },
          required: ["start", "end"],
        },
      },
      strategy: {
        type: "string",
        enum: [...REDACT_STRATEGIES],
        description: "label (default) or placeholder.",
      },
    },
    required: ["text", "findings"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      redacted: {
        type: "string",
        description: "Input text with every kept span replaced by its marker.",
      },
      spans_redacted: {
        type: "integer",
        description: "How many spans were replaced (after overlap resolution).",
      },
      spans_dropped: {
        type: "integer",
        description: "How many spans overlap-resolution dropped.",
      },
      strategy: { type: "string", enum: [...REDACT_STRATEGIES] },
      ...envelopeMetadataProperties(),
    },
    required: ["redacted", "spans_redacted", "spans_dropped", "strategy"],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  // No backend call: the questions builder is a no-op satisfying ToolDefinition.
  buildQuestions: () => ({}),
};

function invalidArg(detail: string): Error {
  return new Error(`invalid_argument: laya_redact ${detail}`);
}

/**
 * Redact and report. Throws ( -> isError, no structuredContent) on invalid
 * arguments. Counts dropped spans so callers can notice overlap surprises.
 */
export async function handleRedact(
  _client: unknown,
  args: Record<string, unknown>,
  _ctx: unknown,
): Promise<string> {
  const { text, findings, strategy } = args;
  if (typeof text !== "string" || text === "") {
    throw invalidArg("text must be a non-empty string");
  }
  const strat = strategy ?? "label";
  const redacted = redactText(text, findings as RedactFinding[], strat as string);
  const ordered = [...(findings as RedactFinding[])].sort((a, b) => a.start - b.start || b.end - a.end);
  let kept = 0;
  let cursor = -1;
  for (const f of ordered) {
    if (f.start < cursor) continue;
    kept++;
    cursor = f.end;
  }
  return JSON.stringify(
    {
      redacted,
      spans_redacted: kept,
      spans_dropped: (findings as RedactFinding[]).length - kept,
      strategy: strat,
    },
    null,
    2,
  );
}
