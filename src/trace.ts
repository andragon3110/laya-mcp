/**
 * Fase-6 T3: inbound trace correlation (trace_id / span_id).
 *
 * Correlation chain (documented, no live OpenCode/Gentle here -- contract):
 *   OpenCode -> Gentle -> laya-mcp -> Evidence/Policy -> Decision -> Gentle
 *   -> Action -> Verification.
 * A caller (OpenCode/Gentle) may attach `trace_id` / `span_id` on the MCP
 * request `_meta` object (2024-10-07 `_meta` passthrough). This module
 * extracts and validates them, generates fresh ids when absent or malformed,
 * and threads them into the decision envelope as OPTIONAL keys alongside
 * `decision_id` (see envelope.ts: augmentEnvelope). "Optional" is the
 * SCHEMA_VERSION_POLICY minor-additive sense: old readers ignore unknown
 * keys and stored pre-T3 outputs still validate (outputSchema lists them
 * as optional, never required). Live envelopes always carry both keys.
 *
 * Id format:
 *   - Incoming ids are normalized (dashes stripped, lowercased) and valid
 *     iff the remainder is 8-64 lowercase hex chars. This accepts W3C
 *     traceparent trace-ids (32 hex), span-ids (16 hex), UUIDs (32 hex
 *     with dashes), and short correlation tokens (8+ hex). Anything else
 *     (wrong charset, too short/long, non-string) is discarded and a fresh
 *     id is generated -- extraction NEVER throws and NEVER trusts malformed
 *     input (a malformed id correlates with nothing, so replacing it is
 *     the honest behaviour).
 *   - Generation: `trace_id` = 32 lowercase hex (16 random bytes,
 *     W3C-trace-id-compatible); `span_id` = 16 lowercase hex (8 random
 *     bytes, W3C-span-id-compatible) via node:crypto. Randomness is the
 *     uniqueness mechanism, same rationale as decision_id (an id, never a
 *     hash of content).
 *
 * Privacy (deliberate T3 choice -- PII spans EXCLUDED, not hashed):
 *   - The trace context carries ONLY opaque ids. Argument content NEVER
 *     enters the trace path: no logging of args here (nothing in this
 *     module logs at all), no content-derived ids, and decision_id stays
 *     random (never a hash of content, which would leak content equality).
 *   - Rationale for exclusion over hashing: a hash still enables
 *     correlation-by-equality against known PII (confirmation attack), so
 *     `laya_pii` payloads and every other tool's args are excluded outright.
 *     Metrics (metrics.ts) likewise records only tool names, ids, decision
 *     labels, counts and latency numbers -- never sizes beyond... (only
 *     fixed-shape numeric/categorical aggregates; no free text).
 */
import { randomBytes } from "node:crypto";

/** Opaque trace correlation threaded into each decision envelope. */
export interface TraceContext {
  trace_id: string;
  span_id: string;
}

/** Normalized incoming ids: 8-64 hex chars after dash-stripping. */
const TRACE_ID_BODY_RE = /^[0-9a-f]{8,64}$/;

/** Generated trace_id shape: 32 lowercase hex (W3C-compatible). */
export const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** Generated span_id shape: 16 lowercase hex (W3C-compatible). */
export const SPAN_ID_RE = /^[0-9a-f]{16}$/;

/** Fresh trace id: 16 random bytes as 32 lowercase hex. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Fresh span id: 8 random bytes as 16 lowercase hex. */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Normalize one incoming id: must be a string whose dash-stripped,
 * lowercased form is 8-64 hex chars. Returns the normalized form or null.
 */
export function normalizeTraceId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const body = raw.replace(/-/g, "").toLowerCase();
  return TRACE_ID_BODY_RE.test(body) ? body : null;
}

/**
 * Extract the trace context from an MCP request `_meta` object (or the
 * whole `request.params`: pass through whatever holds `_meta`). Accepts
 * `trace_id` / `span_id` (snake_case, the MCP `_meta` convention).
 * Absent or malformed ids are replaced with fresh generated ones --
 * never throws, never logs content (this module never logs at all).
 */
export function extractTraceContext(params: unknown): TraceContext {
  let meta: Record<string, unknown> | null = null;
  if (typeof params === "object" && params !== null) {
    const holder = params as Record<string, unknown>;
    const direct = holder._meta;
    if (typeof direct === "object" && direct !== null) {
      meta = direct as Record<string, unknown>;
    } else if ("trace_id" in holder || "span_id" in holder) {
      // Tolerate callers passing the _meta object itself.
      meta = holder;
    }
  }
  const traceId = normalizeTraceId(meta?.trace_id) ?? newTraceId();
  const spanId = normalizeTraceId(meta?.span_id) ?? newSpanId();
  return { trace_id: traceId, span_id: spanId };
}
