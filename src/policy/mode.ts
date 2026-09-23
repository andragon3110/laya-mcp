/**
 * Fase-6 T4: observe / shadow / enforce modes (ADDITIVE, engine untouched).
 *
 * Exact semantics (nothing else is promised):
 *   - `observe` (DEFAULT): execute the tool and record the observation
 *     (metrics, trace, envelope). The engine `decision` is ADVISORY
 *     evidence for the calling agent/policy to consume. Handler output
 *     shape is byte-identical to pre-T4 (no `shadow` key).
 *   - `shadow`: execute with the tool's own base policy; the `decision`
 *     is UNCHANGED (the flow continues with the previous logic) AND the
 *     engine ALSO evaluates the SAME input (evidence, abstention,
 *     context, risk, thresholds) under an explicit candidate policy
 *     `{name, version}`. The candidate outcome is reported in the
 *     top-level `shadow: { would_decide, under_policy }` field, which is
 *     present ONLY in shadow mode with a resolvable candidate.
 *   - `enforce`: execute; the engine `decision` is AUTHORITATIVE -- the
 *     Gentle side MUST honor it (allow/review/deny/escalate). This repo
 *     never orchestrates Gentle and no code here forces calls (see
 *     examples/gentle-hooks.*): the obligation lives in the documented
 *     Gentle-side hook table. Output shape matches observe (decision, no
 *     shadow); only the `effective_mode` stamp differs.
 *
 * Configuration (three levels; invalid values fall back to `observe`,
 * never throw -- a mode must never break a judgment call):
 *   - global:  `LAYA_MODE=observe|shadow|enforce` (default `observe`).
 *   - per tool: `LAYA_MODE_<TOOL>=...` (e.g. `LAYA_MODE_LAYA_SCREEN`;
 *     tool name uppercased, non-alphanumerics become `_`). Wins over the
 *     global value.
 *   - per policy (candidate selection, shadow only): `LAYA_SHADOW_POLICY`
 *     / `LAYA_SHADOW_POLICY_<TOOL>` as `name@version` (explicit, e.g.
 *     `review@1.0.0`). Malformed or unknown candidates yield NO shadow
 *     (base decision intact) plus a one-line stderr note -- shadow must
 *     never alter the flow, including under misconfiguration.
 *
 * I/O boundary (same style as loader thresholds): `resolveMode` /
 * `resolveShadowRef` / `parsePolicyRef` / `evaluateWithMode` are pure
 * over explicit arguments (tests never touch process.env);
 * `effectiveMode` / `shadowPolicyRef` / `evaluateForTool` read the live
 * process env per call (never cached at import, so operators and tests
 * can set/unset without a reload). The decision path in engine.ts stays
 * pure; mode resolution wraps it here.
 *
 * Visibility (additive): every envelope stamps `effective_mode` (see
 * envelope.ts) and `laya_capabilities` reports `modes:{supported,
 * effective, default}` while the legacy `mode:"observe"` field is kept
 * verbatim -- it describes the MCP layer (read-only, never acts), which
 * stays true under every policy mode.
 */
import { evaluate, type EvaluateOptions } from "./engine.js";
import type { PolicyDecision, PolicyInput, PolicyRef } from "./types.js";

/** Policy-decision modes. Never `write`/`act`: laya-mcp never executes actions. */
export type ToolMode = "observe" | "shadow" | "enforce";

/** Code truth for the supported modes (capabilities re-exports this, never a copy). */
export const SUPPORTED_MODES: readonly ToolMode[] = ["observe", "shadow", "enforce"];

/** Default when unset or invalid: advisory, non-intrusive. */
export const DEFAULT_MODE: ToolMode = "observe";

/** Global mode env var. */
export const MODE_ENV_VAR = "LAYA_MODE";

/** Global shadow-candidate env var (`name@version`). */
export const SHADOW_POLICY_ENV_VAR = "LAYA_SHADOW_POLICY";

/** Per-tool mode env var, e.g. `LAYA_MODE_LAYA_SCREEN`. */
export function toolModeEnvVar(toolName: string): string {
  return `LAYA_MODE_${String(toolName ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/** Per-tool shadow-candidate env var, e.g. `LAYA_SHADOW_POLICY_LAYA_SCREEN`. */
export function shadowPolicyEnvVar(toolName: string): string {
  return `${SHADOW_POLICY_ENV_VAR}_${String(toolName ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Pure resolver: effective mode for a tool over an env-like dict.
 * Per-tool value wins over global; unknown/blank values fall back to
 * `observe` (never throws).
 */
export function resolveMode(env: Record<string, string | undefined>, toolName?: string): ToolMode {
  const perTool = toolName !== undefined ? env[toolModeEnvVar(toolName)] : undefined;
  const raw = perTool ?? env[MODE_ENV_VAR];
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return v === "observe" || v === "shadow" || v === "enforce" ? v : DEFAULT_MODE;
}

/** I/O boundary: effective mode for a tool from the live process env. */
export function effectiveMode(toolName?: string): ToolMode {
  return resolveMode(process.env as Record<string, string | undefined>, toolName);
}

/**
 * Parse an explicit candidate policy ref (`name@version`). Returns null
 * for absent/malformed values (never throws -- shadow stays absent).
 */
export function parsePolicyRef(raw: unknown): PolicyRef | null {
  if (typeof raw !== "string") return null;
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at >= raw.length - 1) return null;
  const name = raw.slice(0, at).trim();
  const version = raw.slice(at + 1).trim();
  if (name === "" || version === "") return null;
  return { name, version };
}

/**
 * Pure resolver: shadow candidate for a tool over an env-like dict.
 * Per-tool value wins over global; null when absent or malformed.
 */
export function resolveShadowRef(env: Record<string, string | undefined>, toolName?: string): PolicyRef | null {
  const perTool = toolName !== undefined ? env[shadowPolicyEnvVar(toolName)] : undefined;
  return parsePolicyRef(perTool ?? env[SHADOW_POLICY_ENV_VAR]);
}

/** I/O boundary: shadow candidate for a tool from the live process env. */
export function shadowPolicyRef(toolName?: string): PolicyRef | null {
  return resolveShadowRef(process.env as Record<string, string | undefined>, toolName);
}

/** Shadow report: what the candidate policy WOULD have decided (flow untouched). */
export interface ShadowReport {
  would_decide: PolicyDecision;
  under_policy: PolicyRef;
}

/** Mode-aware evaluation result: base decision always intact, shadow only on request. */
export interface ModeResult {
  decision: PolicyDecision;
  shadow: ShadowReport | null;
  effective_mode: ToolMode;
}

export interface EvaluateWithModeOptions extends EvaluateOptions {
  /** Explicit mode (default `observe`). */
  mode?: ToolMode;
  /** Explicit candidate (shadow only; null/absent means no shadow). */
  shadowPolicy?: PolicyRef | null;
}

/**
 * Evaluate the base input, plus -- ONLY when `mode === "shadow"` with a
 * candidate -- the same input under the candidate policy. The base
 * `decision` object is never modified; an unknown candidate yields
 * `shadow: null` (never throws, never alters the flow).
 */
export function evaluateWithMode(input: PolicyInput, opts?: EvaluateWithModeOptions): ModeResult {
  const mode = opts?.mode ?? DEFAULT_MODE;
  const decision = evaluate(input, { thresholds: opts?.thresholds });
  if (mode !== "shadow" || !opts?.shadowPolicy) {
    return { decision, shadow: null, effective_mode: mode };
  }
  const under_policy = { ...opts.shadowPolicy };
  let would_decide: PolicyDecision;
  try {
    would_decide = evaluate({ ...input, policy: under_policy }, { thresholds: opts?.thresholds });
  } catch {
    return { decision, shadow: null, effective_mode: mode };
  }
  return { decision, shadow: { would_decide, under_policy: { ...under_policy } }, effective_mode: mode };
}

/**
 * Handler drop-in (I/O boundary): resolve mode + candidate from the live
 * process env for this tool, then evaluate. Unknown shadow candidates
 * keep the base decision and log a one-line stderr note (no content --
 * only the tool name and the bad ref).
 */
export function evaluateForTool(
  toolName: string,
  input: PolicyInput,
  opts?: EvaluateOptions,
): ModeResult {
  const env = process.env as Record<string, string | undefined>;
  const mode = resolveMode(env, toolName);
  const candidate = mode === "shadow" ? resolveShadowRef(env, toolName) : null;
  const out = evaluateWithMode(input, { thresholds: opts?.thresholds, mode, shadowPolicy: candidate });
  if (mode === "shadow" && out.shadow === null) {
    const raw = env[shadowPolicyEnvVar(toolName)] ?? env[SHADOW_POLICY_ENV_VAR];
    console.error(
      `[laya-mcp] ${toolName}: shadow mode without a resolvable candidate policy ` +
        `(${JSON.stringify(raw ?? null)}); continuing with the base decision, no shadow reported. ` +
        `Set ${SHADOW_POLICY_ENV_VAR} (or ${shadowPolicyEnvVar(toolName)}) to "name@version".`,
    );
  }
  return out;
}
