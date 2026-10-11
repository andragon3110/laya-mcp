/**
 * `laya_redact` -- deterministic PII redaction transform (tool 14).
 *
 * `laya_pii` detects and `laya_extract` locates; this closes the loop for
 * pipelines that must clean text before logging, storing, or forwarding it.
 * Pure function of its arguments: no backend, no policy decision, no state
 * (annotations stay read-only; the contract stretch is documented in
 * MCP_CONTRACT.md §3 -- a transform, not a judgment).
 *
 * Two input modes (mutually exclusive): caller-supplied `findings` (v1,
 * fully offline) or `detect` (v2 auto-detect: spans come from the GLiNER
 * sidecar in the same call -- `pii` via piiScan, `entities` via
 * extractEntities with caller `entity_types`, `auto` picks pii; without
 * the sidecar detect fails isError with the backend diagnosis). The
 * redaction itself stays the pure deterministic transform in both modes;
 * detect responses additionally carry `detection` (never on v1 calls, so
 * old clients keep validating).
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
export const REDACT_DETECT_SOURCES = ["auto", "pii", "entities"] as const;

export interface RedactFinding {
  start: number;
  end: number;
  entity_type?: unknown;
}

export interface GlinerLikeSpan {
  start: number;
  end: number;
  type?: unknown;
  entity_type?: unknown;
}

/**
 * Map producer spans ({start, end, type}) to redact findings
 * ({start, end, entity_type}). Pure; range validation stays in redactText.
 */
export function mapGlinerFindings(spans: GlinerLikeSpan[]): RedactFinding[] {
  if (!Array.isArray(spans)) {
    throw invalidArg("producer spans must be an array");
  }
  return spans.map((s) => {
    if (typeof s !== "object" || s === null) throw invalidArg("producer span must be an object");
    const entityType = typeof s.type === "string" ? s.type : s.entity_type;
    return { start: s.start, end: s.end, entity_type: entityType };
  });
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
    "or placeholder ([REDACTED]). Needs no backend: advertised and callable even with every sidecar down. " +
    "detect mode (v2): pass detect instead of findings to detect spans via the GLiNER sidecar in the same " +
    "call (source auto|pii|entities; entities needs entity_types); without the sidecar detect fails isError.",
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
      detect: {
        type: "object",
        description:
          "Auto-detect mode (mutually exclusive with findings): detect spans via the GLiNER sidecar. " +
          "source auto uses piiScan (default); pii the same explicitly; entities uses extractEntities " +
          "with entity_types. Same limits as laya_pii.",
        properties: {
          source: { type: "string", enum: [...REDACT_DETECT_SOURCES] },
          extra_types: { type: "array", items: { type: "string" } },
          entity_types: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    required: ["text"],
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
      detection: {
        type: "object",
        description: "Detect-mode only (never on findings calls): producer span count and source.",
        properties: {
          spans_found: { type: "integer" },
          producer: { type: "string" },
        },
      },
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
 * v1 (findings) stays fully offline; detect mode resolves spans through
 * ctx.gliner (piiScan / extractEntities) and reports `detection`.
 */
export async function handleRedact(
  _client: unknown,
  args: Record<string, unknown>,
  ctx: unknown,
): Promise<string> {
  const { text, findings, strategy, detect } = args as {
    text?: unknown;
    findings?: unknown;
    strategy?: unknown;
    detect?: unknown;
  };
  if (typeof text !== "string" || text === "") {
    throw invalidArg("text must be a non-empty string");
  }
  const strat = strategy ?? "label";
  if (detect == null) {
    return renderResult(text, findings as RedactFinding[], strat as string, null);
  }
  if (typeof detect !== "object" || Array.isArray(detect)) {
    throw invalidArg("detect must be an object");
  }
  const spec = detect as { source?: unknown; extra_types?: unknown; entity_types?: unknown };
  const source = spec.source ?? "auto";
  if (source !== "auto" && source !== "pii" && source !== "entities") {
    throw invalidArg("detect.source must be one of auto|pii|entities");
  }
  if (findings != null) {
    throw invalidArg("findings and detect are mutually exclusive (pass exactly one)");
  }
  const extra = spec.extra_types ?? [];
  if (!Array.isArray(extra) || !extra.every((s) => typeof s === "string")) {
    throw invalidArg("detect.extra_types must be an array of strings");
  }
  const entityTypes = (spec as { entity_types?: unknown }).entity_types;
  if (source === "entities") {
    if (!Array.isArray(entityTypes) || entityTypes.length === 0 || !entityTypes.every((s) => typeof s === "string")) {
      throw invalidArg("detect.entity_types must be a non-empty array of strings for source entities");
    }
    if (extra.length > 0) throw invalidArg("detect.extra_types applies to pii only, not entities");
  } else if (entityTypes != null) {
    throw invalidArg("detect.entity_types applies to entities only");
  }
  const c = ctx as {
    glinerReady?: unknown;
    gliner?: {
      piiScan(text: string, extra: string[]): Promise<{ findings: GlinerLikeSpan[] }>;
      extractEntities(text: string, labels: string[]): Promise<{ spansByType: Record<string, GlinerLikeSpan[]> }>;
    } | null;
  } | null;
  if (c == null || typeof c.glinerReady !== "function" || c.glinerReady() !== true || c.gliner == null) {
    throw new Error(
      "laya_redact detect needs the gliner-server sidecar, which is not reachable. " +
        "Start it with $HOME/laya-mcp/start_gliner.sh (installed via install.sh --with-gliner), " +
        "or pass findings explicitly (v1 offline mode).",
    );
  }
  let spans: GlinerLikeSpan[];
  let producer: string;
  if (source === "entities") {
    const { spansByType } = await c.gliner.extractEntities(text, entityTypes as string[]);
    spans = Object.entries(spansByType ?? {}).flatMap(([type, arr]) =>
      (Array.isArray(arr) ? arr : []).map((s) => ({ ...s, type })),
    );
    producer = "gliner-entities";
  } else {
    const scanned = await c.gliner.piiScan(text, extra as string[]);
    spans = scanned?.findings ?? [];
    producer = "gliner-pii";
  }
  const mapped = mapGlinerFindings(spans);
  return renderResult(text, mapped, strat as string, { spans_found: mapped.length, producer });
}

function renderResult(
  text: string,
  findings: RedactFinding[],
  strat: string,
  detection: { spans_found: number; producer: string } | null,
): string {
  const redacted = redactText(text, findings, strat);
  const ordered = [...findings].sort((a, b) => a.start - b.start || b.end - a.end);
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
      spans_dropped: findings.length - kept,
      strategy: strat,
      ...(detection === null ? {} : { detection }),
    },
    null,
    2,
  );
}
