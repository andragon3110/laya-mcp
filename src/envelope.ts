/**
 * Fase-5 T4: decision envelope metadata + structuredContent plumbing.
 *
 * Every `tools/call` success envelope is a JSON object (the handler's
 * text-JSON). This module augments that object ADDITIVELY with decision
 * metadata and returns it both as the (still non-empty) text block --
 * protocol 2024-10-07 clients keep reading text -- and as
 * `structuredContent` (the SAME object: structuredContent deep-equals
 * JSON.parse of the returned text).
 *
 * Metadata added per envelope (existing keys such as `latency_ms`,
 * `decision` and `evidence` are preserved verbatim):
 *
 *   - `decision_id`:    unique per call. Format `dec_<16 lowercase hex>`
 *                       (8 random bytes via node:crypto). Randomness is the
 *                       uniqueness mechanism; collisions are negligible and
 *                       carry no semantics (an id, never a hash of content).
 *   - `trace_id` / `span_id` (fase-6 T3, OPTIONAL keys): inbound trace
 *                       correlation from the request `_meta` (validated,
 *                       generated when absent -- see trace.ts). Stamped only
 *                       when a trace context is passed (index.ts always
 *                       passes one); opaque ids only, never content.
 *   - `timestamp`:      ISO-8601 creation time (new Date().toISOString()).
 *   - `model`:          judging backend label, taken from
 *                       `evidence.model` (the LayaClient already defaults a
 *                       laya call to "laya"; pii evidence stays GLiNER-sourced
 *                       so its model is the honest null -- the per-span Laya
 *                       judge signals live in findings[].laya_signal, not in
 *                       evidence). Never invented here.
 *   - `model_revision`: operator pin via LAYA_MODEL_REVISION (laya tools)
 *                       or GLINER_MODEL_REVISION (laya_pii), else the
 *                       backend-supplied `evidence.revision`, else the honest
 *                       null. A hash is NEVER invented.
 *   - `revision_source`: `env:LAYA_MODEL_REVISION` /
 *                       `env:GLINER_MODEL_REVISION` when pinned via env,
 *                       `backend` when the backend supplied a revision,
 *                       `unpinned` for the honest null.
 *   - `primitive`:      dominant signal kind for the tool: noul / choice /
 *                       score / spans (see TOOL_PRIMITIVES).
 *   - `policy` / `policy_version`: top-level mirror of
 *                       `decision.policy.{name,version}` (null when the
 *                       envelope carries no decision, which never happens
 *                       for the 11 shipped tools).
 *   - `effective_mode` (fase-6 T4, OPTIONAL key): the policy-decision
 *                       mode this call ran under (observe/shadow/enforce,
 *                       resolved per call from LAYA_MODE / LAYA_MODE_<TOOL>,
 *                       default observe; explicit override wins in tests).
 *                       Minor-additive like the trace keys: old readers
 *                       ignore it, stored pre-T4 outputs still validate.
 *   - `schema_version`: envelope contract version, constant "1.0.0"
 *                       (ENVELOPE_SCHEMA_VERSION). Versioning/compat policy
 *                       is T5's SCHEMA_VERSION_POLICY below (major = breaking, minor = additive).
 *   - `latency_ms`:     already emitted by every handler; conserved here
 *                       (never recomputed, never overwritten with a new key).
 *
 * Degenerate path: if the handler text does not parse as a JSON object
 * (should never happen -- handlers always stringify objects), the text is
 * returned intact with NO structuredContent and a one-line note on stderr.
 * The text block is never emptied and the call never throws for this.
 *
 * outputSchema note (deliberate T4 scope cut): T3 fixed the 11
 * outputSchemas and the SDK's low-level Server does NOT validate
 * structuredContent against outputSchema (verified in
 * node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js: only
 * the call envelope is validated), so the new additive keys flow without
 * touching schemas. Documenting the new keys IN the schemas belongs to
 * T5 (schema_version/versioning) + T6 (schema tests).
 */
import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  GLINER_MODEL_REVISION_ENV,
  LAYA_MODEL_REVISION_ENV,
  readRevisionEnv,
} from "./evidence.js";
import { recordCall, recordEnvelope } from "./metrics.js";
import { effectiveMode, type ToolMode } from "./policy/mode.js";
import type { TraceContext } from "./trace.js";

/** Envelope contract version stamped on every augmented envelope (T4). */
export const ENVELOPE_SCHEMA_VERSION = "1.0.0";

/**
 * Fase-5 T5: envelope-contract versioning policy (SCHEMA_VERSION_POLICY).
 *
 * The `schema_version` stamped on every envelope versions the WHOLE
 * tools/call contract (envelope keys + outputSchemas + list behaviour),
 * not just this file. Compat surface that is ALWAYS preserved:
 * content[0] is a non-empty text block with the full JSON (protocol
 * 2024-10-07 clients keep reading text), and structuredContent carries the
 * SAME object (deep-equals JSON.parse of the text).
 *
 * MINOR bump (1.x.0) -- additive, old clients keep working:
 * - a new OPTIONAL envelope/output key (old readers ignore unknown keys);
 * - a new tool with its own input+output schemas (old lists are a subset);
 * - a new policy version registered ALONGSIDE the old (loader keeps both);
 * - a new optional input parameter (old callers omit it).
 * T5 itself is a minor-class change: laya_capabilities is a new tool and
 * the nine envelope keys only become OPTIONAL outputSchema properties.
 *
 * MAJOR bump (2.0.0) -- breaking, old clients may fail:
 * - removing or emptying the text block (2024-10-07 clients go blind);
 * - renaming an envelope/output field (old readers miss it);
 * - adding a REQUIRED key or making an optional key required (stored old
 *   outputs stop validating);
 * - removing a property/tool/input or narrowing a type/enum (valid old
 *   payloads become invalid);
 * - newly rejecting a previously valid input (tightened inputs).
 *
 * classifyContractChange below encodes exactly this table so tests (and
 * T7's MCP_CONTRACT.md) assert it instead of quoting prose.
 */
export interface ContractChange {
  /** The text block is removed or allowed to be empty. */
  removesTextBlock?: boolean;
  /** An existing envelope/output field is renamed. */
  renamesField?: boolean;
  /** A new required key appears, or an optional key becomes required. */
  addsRequired?: boolean;
  /** An existing property/tool/input is removed, or a type/enum narrows. */
  removesOrNarrows?: boolean;
  /** A previously valid input is newly rejected. */
  tightensInput?: boolean;
  /** A new optional envelope/output key (old readers ignore unknown keys). */
  addsOptionalKey?: boolean;
  /** A new tool with its own input+output schemas (old lists are a subset). */
  addsTool?: boolean;
  /** A new policy version registered alongside the old one. */
  addsPolicy?: boolean;
  /** A new optional input parameter (old callers omit it). */
  addsOptionalParam?: boolean;
}

/** "major" = schema_version major bump; "minor" = additive, compat kept. */
export type ContractChangeKind = "major" | "minor";

/**
 * Classify a contract change per SCHEMA_VERSION_POLICY. Any single breaking
 * flag forces "major" (even combined with additive flags); a change with
 * only additive flags -- or no flags at all -- is "minor".
 */
export function classifyContractChange(change: ContractChange): ContractChangeKind {
  if (
    change.removesTextBlock === true ||
    change.renamesField === true ||
    change.addsRequired === true ||
    change.removesOrNarrows === true ||
    change.tightensInput === true
  ) {
    return "major";
  }
  return "minor";
}

/** Dominant signal kind per tool (display/contract metadata, no semantics). */
export type DecisionPrimitive = "noul" | "choice" | "score" | "spans";

/**
 * Fase-5 T4: which primitive each tool judges with. Rationale per tool:
 * screen/verify/rerank ask Router `noul` questions; find/classify/decide/
 * compare/extract ask Router `choice` questions (extract's entity spans are
 * still picked via a choice among candidates); review/gate report 0-2
 * rubric `score` numbers as their primary display (safe_to_apply noul is
 * secondary); pii reports GLiNER `span` signals (pluralized `spans` at the
 * envelope level per the fase-5 contract vocabulary).
 */
export const TOOL_PRIMITIVES: Readonly<Record<string, DecisionPrimitive>> = {
  laya_screen: "noul",
  laya_verify: "noul",
  laya_find: "choice",
  laya_rerank: "noul",
  laya_classify: "choice",
  laya_decide: "choice",
  laya_compare: "choice",
  laya_extract: "choice",
  laya_review: "score",
  laya_gate: "score",
  laya_pii: "spans",
};

/** True for the GLiNER-judged tool (revision resolves from the gliner env). */
export function isGlinerTool(toolName: string): boolean {
  return toolName === "laya_pii";
}

/**
 * New unique decision id per call. Format: `dec_` + 16 lowercase hex chars
 * (8 random bytes). Documented here as the contract; tests assert the shape
 * and per-call uniqueness, never a specific value.
 */
export function newDecisionId(): string {
  return `dec_${randomBytes(8).toString("hex")}`;
}

/** Envelope revision in the same honest vocabulary as evidence.ts. */
export interface EnvelopeRevision {
  model_revision: string | null;
  revision_source: string;
}

/**
 * Resolve the top-level revision for an envelope. Operator env pin wins
 * (laya tools: LAYA_MODEL_REVISION; laya_pii: GLINER_MODEL_REVISION), else
 * the backend-supplied evidence revision, else the honest null. The value
 * is passed through verbatim in every case -- never synthesized.
 *
 * @param evidenceRevision the already-resolved `evidence.revision` value
 *        (which itself prefers the same env pin, so both layers agree).
 */
export function resolveEnvelopeRevision(
  toolName: string,
  evidenceRevision: unknown,
): EnvelopeRevision {
  const envName = isGlinerTool(toolName) ? GLINER_MODEL_REVISION_ENV : LAYA_MODEL_REVISION_ENV;
  const pinned = readRevisionEnv(envName);
  if (pinned !== null) return { model_revision: pinned, revision_source: `env:${envName}` };
  const backend =
    typeof evidenceRevision === "string"
      ? evidenceRevision.trim() === ""
        ? null
        : evidenceRevision
      : typeof evidenceRevision === "number"
        ? String(evidenceRevision)
        : null;
  if (backend !== null) return { model_revision: backend, revision_source: "backend" };
  return { model_revision: null, revision_source: "unpinned" };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Augment a parsed handler envelope ADDITIVELY. Every pre-existing key is
 * preserved (spread first); only the documented metadata keys are set.
 * `latency_ms` is conserved, never recomputed.
 *
 * Fase-6 T3: `trace` threads the inbound trace context (OpenCode -> Gentle
 * -> laya-mcp correlation, see trace.ts) as the OPTIONAL keys `trace_id` /
 * `span_id` alongside `decision_id`. Optional is the minor-additive sense:
 * old readers ignore them; stored pre-T3 outputs still validate. Callers
 * that pass no trace (tests, direct callers) get the envelope without the
 * keys -- index.ts always passes one (generated when the request carries
 * none), so live envelopes always carry both.
 *
 * Fase-6 T4: `modeOverride` pins the stamped `effective_mode` (test path);
 * when absent the mode resolves from the live env for this tool
 * (effectiveMode, default observe -- see policy/mode.ts). Handler-emitted
 * `shadow` reports (shadow mode only) flow through untouched: the spread
 * preserves every pre-existing key.
 */
export function augmentEnvelope(
  toolName: string,
  parsed: Record<string, unknown>,
  trace?: TraceContext,
  modeOverride?: ToolMode,
): Record<string, unknown> {
  const evidence = isPlainObject(parsed.evidence) ? parsed.evidence : null;
  const decision = isPlainObject(parsed.decision) ? parsed.decision : null;
  const decisionPolicy = isPlainObject(decision?.policy) ? decision.policy : null;
  const policyName = typeof decisionPolicy?.name === "string" ? decisionPolicy.name : null;
  const policyVersion = typeof decisionPolicy?.version === "string" ? decisionPolicy.version : null;
  const { model_revision, revision_source } = resolveEnvelopeRevision(
    toolName,
    evidence?.revision ?? null,
  );
  return {
    ...parsed,
    decision_id: newDecisionId(),
    ...(trace !== undefined ? { trace_id: trace.trace_id, span_id: trace.span_id } : {}),
    timestamp: new Date().toISOString(),
    effective_mode: modeOverride ?? effectiveMode(toolName),
    model: evidence !== null && (typeof evidence.model === "string" || evidence.model === null)
      ? (evidence.model as string | null)
      : null,
    model_revision,
    revision_source,
    primitive: TOOL_PRIMITIVES[toolName] ?? null,
    policy: policyName,
    policy_version: policyVersion,
    schema_version: ENVELOPE_SCHEMA_VERSION,
  };
}

/**
 * Build the `tools/call` success result for a handler's text-JSON: the
 * text block stays (re-serialized WITH the additive metadata, still
 * indented JSON, never empty) and `structuredContent` carries the SAME
 * object. On degenerate input (unparseable text or a non-object), the
 * text is returned intact with no structuredContent plus a stderr note.
 *
 * Fase-6 T3: central metrics hook. The success path records the served
 * observation (model/decision/latency/abstention extracted from the
 * augmented envelope via recordEnvelope); the degenerate path counts the
 * request with an empty observation. Failures never break the result --
 * recordEnvelope never throws. `trace` is threaded to augmentEnvelope
 * (absent => envelope without trace keys; index.ts always passes one).
 * Fase-6 T4: `modeOverride` threads the effective-mode stamp the same way
 * (absent => resolved from the live env for this tool).
 */
export function buildCallResult(toolName: string, text: string, trace?: TraceContext, modeOverride?: ToolMode): CallToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(
      `[laya-mcp] tools/call ${toolName}: handler text is not JSON; ` +
        `returning text without structuredContent`,
    );
    recordCall({ tool: toolName });
    return { content: [{ type: "text" as const, text }] };
  }
  if (!isPlainObject(parsed)) {
    console.error(
      `[laya-mcp] tools/call ${toolName}: handler envelope is not a JSON object; ` +
        `returning text without structuredContent`,
    );
    recordCall({ tool: toolName });
    return { content: [{ type: "text" as const, text }] };
  }
  const augmented = augmentEnvelope(toolName, parsed, trace, modeOverride);
  recordEnvelope(toolName, augmented);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(augmented, null, 2) }],
    structuredContent: augmented,
  };
}
