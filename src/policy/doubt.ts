/**
 * doubt-gate-es T5: ambient per-case confidence for the global doubt gate.
 *
 * The engine (engine.ts) reads case confidence from `input.context`
 * (`answer_confidence` map or `min_confidence` scalar), but no handler
 * builds that context -- the 11 judgment tools never forwarded the
 * backend's declared confidence, so the gate slept (0 `low_confidence`
 * hits live). Rather than editing every handler, the two funnels every
 * judgment already passes through carry it:
 *
 *   - FEED: `LayaClient.predict` (client.ts) -- the single funnel for
 *     every /predict raw (runTool's 9 tools, decide's 2 stages, the pii
 *     judge call) -- merges the sanitized per-question table
 *     (`answer_confidence`, fallback `confidence`) into this ambient.
 *     A throw clears it: a dead case must not poison the next one.
 *   - CONSUME: `evaluateForTool` (mode.ts) -- the single funnel for all
 *     11 judgments -- takes the ambient (clearing it) and fills
 *     `context.answer_confidence` when the handler set neither that nor
 *     `min_confidence`. Explicit handler context always wins; abstention
 *     still precedes the gate (engine order unchanged).
 *
 * Union semantics: multi-predict cases (decide selection+requirements,
 * pii judge) accumulate keys across their predicts, so the gate sees the
 * whole case (weakest link). `runTool` alone would cover only 9/11
 * (decide + pii bypass it with direct `client.predict` calls), which is
 * why the feed lives one layer down, in `predict` itself.
 *
 * Staleness: a bare predict with no later evaluation (warmup probes)
 * leaves one table that the next evaluation consumes once; every handler
 * predict is followed by exactly one `evaluateForTool`, which consumes.
 * Direction is escalate-only, never a pass. The MCP server handles tool
 * calls sequentially, so cases cannot interleave here.
 */

/** Sanitized per-question confidence table (finite numbers only). */
export type DoubtTable = Record<string, number>;

let ambient: DoubtTable | null = null;

/**
 * Build the per-case table from a raw result. Prefers
 * `answer_confidence`, falls back to `confidence` (never mixes the two
 * within one predict: the fallback only applies when the preferred map
 * is absent or carries no usable value). Non-finite and non-numeric
 * entries are dropped; returns null when nothing usable remains -- the
 * gate then sleeps rather than inventing certainty.
 */
export function doubtTableFromRaw(raw: {
  answer_confidence?: unknown;
  confidence?: unknown;
}): DoubtTable | null {
  const pick = (v: unknown): DoubtTable | null => {
    if (typeof v !== "object" || v === null) return null;
    const out: DoubtTable = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  return pick(raw?.answer_confidence) ?? pick(raw?.confidence);
}

/** Feed one predict's table into the ambient (key-union across stages). */
export function mergeDoubtTable(table: DoubtTable | null): void {
  if (!table) return;
  ambient = { ...(ambient ?? {}), ...table };
}

/** Consume the ambient exactly once (clears it). Null when nothing fed. */
export function takeDoubtTable(): DoubtTable | null {
  const t = ambient;
  ambient = null;
  return t;
}

/** Drop the ambient without consuming (dead case, backend throw). */
export function clearDoubtTable(): void {
  ambient = null;
}
