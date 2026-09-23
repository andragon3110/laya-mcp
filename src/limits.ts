/**
 * T6: input limits shared by every tool, with one error vocabulary.
 *
 * The Python servers are the authority (LAYA_LIMITS_* / GLINER_LIMITS_*
 * envs, see py/laya_server.py and py/gliner_server.py). The constants below
 * mirror the server DEFAULTS so tools fail fast with the SAME shape the
 * servers answer over HTTP ({code:"input_too_large", field, limit, actual,
 * hint}) instead of spending a round trip to learn it. When the server env
 * overrides differ, the server still wins -- these are early, fail-fast
 * checks only, never a bypass.
 *
 * Every value below was validated against the real system:
 * - maxStateChars/maxBodyChars/maxQuestions mirror the /predict guards
 *   (20000 / 100000 / 64): Laya checkpoints run 512-1024 token windows, so
 *   anything near 20000 chars is already beyond what the judge can use.
 * - maxFindCandidates=250 honours the long-standing "up to 250" description,
 *   now enforced (previously silently sliced by Array iteration -- every
 *   candidate became a criterion, so >250 just built ever-larger payloads).
 * - Per-tool item caps derive from the 1-item = 1-question fan-out: classify
 *   items, verify claims and rerank candidates each become exactly one
 *   /predict question, so their caps sit at or under the 64-question budget.
 *   Gate keeps 3 fixed rubric questions, hence 61 claims (3 + 61 = 64).
 * - maxRerankCandidateChars=2000 makes the old "(truncated to 2,000 chars
 *   internally)" description real -- previously zero code hits.
 * - maxExtractCandidates=20 keeps the existing slice(0,20) behaviour but
 *   surfaces it via truncated/dropped instead of silence. Since fase-4 T3
 *   the extract candidate cap is operator-tunable at call time
 *   (top_k/max_candidates params, validated with the same input_too_large
 *   vocabulary) and via the LAYA_LIMITS_MAX_EXTRACT_CANDIDATES env ceiling
 *   (see resolveExtractLimits below); defaults stay 20 so existing callers
 *   see byte-identical behaviour.
 * - maxGlinerTextChars/maxExtraTypes mirror the /pii_scan and
 *   /extract_entities guards (50000 / 32).
 */
export const LIMITS = {
  maxStateChars: 20000,
  maxBodyChars: 100000,
  maxQuestions: 64,
  maxFindCandidates: 250,
  minDecideOptions: 2,
  maxDecideOptions: 6,
  maxDecideRequirements: 32,
  maxClassifyItems: 64,
  maxVerifyClaims: 64,
  maxGateClaims: 61,
  maxCompareAspects: 32,
  maxRerankCandidates: 64,
  maxRerankCandidateChars: 2000,
  maxExtractFields: 64,
  maxExtractCandidates: 20,
  maxGlinerTextChars: 50000,
  maxExtraTypes: 32,
} as const;

export interface InputTooLargeDetail {
  code: "input_too_large";
  field: string;
  limit: number;
  actual: number;
  hint: string;
}

/**
 * Build the shared limit error. Thrown (builders) or returned as
 * {ok:false} (handlers via runTool) -- either way the MCP layer surfaces
 * the message, so code/field/limit/actual/hint travel IN the message text,
 * mirroring the Python 413 body vocabulary. A structured `detail` is
 * attached for programmatic callers.
 */
export function inputTooLarge(field: string, limit: number, actual: number, hint: string): Error {
  const err = new Error(
    `input_too_large: field="${field}" limit=${limit} actual=${actual} hint="${hint}"`,
  );
  err.name = "InputTooLargeError";
  (err as Error & { detail: InputTooLargeDetail }).detail = {
    code: "input_too_large",
    field,
    limit,
    actual,
    hint,
  };
  return err;
}

/** Throw inputTooLarge when `text` exceeds `limit` chars. */
export function assertLength(text: string, limit: number, field: string, hint: string): void {
  if (text.length > limit) throw inputTooLarge(field, limit, text.length, hint);
}

/** Throw inputTooLarge when `count` exceeds `limit` items. */
export function assertCount(count: number, limit: number, field: string, hint: string): void {
  if (count > limit) throw inputTooLarge(field, limit, count, hint);
}

/**
 * Fase-4 T3: env-tunable ceiling for the extract candidate pipeline.
 *
 * The Python servers stay the authority for oversized PAYLOADS (413 over
 * HTTP); this ceiling only bounds the per-call top_k/max_candidates params
 * before candidates are built, failing fast with the same input_too_large
 * vocabulary instead of building ever-larger judge payloads.
 *
 *   - LAYA_LIMITS_MAX_EXTRACT_CANDIDATES (default 20 = LIMITS.maxExtractCandidates)
 *
 * Missing, non-integer, or <1 values fall back to the default (no throw:
 * a misconfigured env must not break default callers). The resolver is pure
 * (takes the env dict) so tests never touch process.env; extract.ts reads
 * the live env at CALL time so operators can retune without a restart.
 */
export const EXTRACT_LIMIT_ENV_VARS = {
  maxExtractCandidates: "LAYA_LIMITS_MAX_EXTRACT_CANDIDATES",
} as const;

export function resolveExtractLimits(env: Record<string, string | undefined>): {
  maxExtractCandidates: number;
} {
  const raw = env[EXTRACT_LIMIT_ENV_VARS.maxExtractCandidates];
  if (raw !== undefined) {
    const v = Number(raw);
    if (Number.isInteger(v) && v >= 1) return { maxExtractCandidates: v };
  }
  return { maxExtractCandidates: LIMITS.maxExtractCandidates };
}

/** I/O boundary: read the live process env. Called ONLY from extract.ts. */
export function extractLimitsFromEnv(): { maxExtractCandidates: number } {
  return resolveExtractLimits({ ...(process.env as Record<string, string | undefined>) });
}
