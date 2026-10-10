/**
 * DeciderClient — Strands Decider 2B behind the GliclassClient lane interface.
 *
 * Subclasses GliclassClient and overrides ONLY the scoring transport
 * (scoreLabels): every adjudication path (predictClassify/Gate/Screen/Rerank,
 * argmax-first-max, ABSTAIN-omit, screen margin-tau routing, callLog evidence
 * shape with margins) is inherited VERBATIM, so a Decider matrix is scored
 * with byte-identical methodology to the gliclass matrices.
 *
 * Two deliberate, documented differences (both favor the incumbent):
 *  1. Bare-name options: choice criteria map label -> label (no
 *     descriptions). Decider's own docs say criteria sharpen boundaries,
 *     so this benches a LOWER bound for Decider.
 *  2. answers.model still reads "gliclass" (inherited literal); the bench
 *     manifest labels the backend "decider" explicitly. Scoring never
 *     branches on that string (verified: no "gliclass" branch in suites).
 */
import { GliclassClient } from "./lanes-r1.mjs";

export class DeciderClient extends GliclassClient {
  constructor(baseUrl = "http://127.0.0.1:8001", opts = {}) {
    super(baseUrl);
    this.deciderModel = opts.model ?? "StrandsAgents/strands-decider-2B-hobson-v21";
  }

  async scoreLabels(text, labels, { timeoutMs = 120000 } = {}) {
    if (!Array.isArray(labels) || labels.length < 2) {
      throw new Error(
        `decider lane unavailable: choice needs >=2 options (got ${Array.isArray(labels) ? labels.length : "non-array"})`,
      );
    }
    const criteria = Object.fromEntries(labels.map((l) => [l, l]));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          state: text,
          questions: { q: { type: "choice", instructions: "Pick the best option.", criteria } },
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`decider POST /v1/systemone HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      }
      const ans = body?.answers?.q;
      if (!ans || typeof ans.probabilities !== "object") {
        throw new Error("decider returned invalid payload (missing answers.q.probabilities)");
      }
      const scores = labels.map((l) => ({ label: l, score: Number(ans.probabilities[l] ?? 0) }));
      return { scores, latencyMs: Number(body.latency_ms ?? 0) };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("decider")) throw err;
      throw new Error(err?.name === "AbortError" ? `decider timed out after ${timeoutMs}ms` : `decider unreachable at ${this.baseUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
