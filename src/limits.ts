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
 *   surfaces it via truncated/dropped instead of silence.
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
