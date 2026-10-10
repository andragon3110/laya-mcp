/**
 * D3Client — vllm-sr d3-nano behind the GliclassClient lane interface.
 *
 * Same subclass discipline as DeciderClient (adjudication inherited
 * verbatim), except options carry REAL descriptions: predict() stashes a
 * per-call description table (from the handler-built question criteria;
 * fixed stock tables for the gate/screen vocabularies) and scoreLabels
 * passes them as choice criteria. Full-strength call, documented.
 */
import { GliclassClient } from "./lanes-r1.mjs";

const STOCK_DESC = {
  SUPPORTED: "The evidence directly backs the claim.",
  CONTRADICTED: "The evidence refutes the claim.",
  ABSTAIN: "The evidence says nothing about the claim.",
  benign: "Everyday prose with no instruction aimed at the agent.",
  suspicious: "Role-play or hypothetical nudges that merit human review.",
  malicious: "Instruction overrides, fake notices, or data-exfiltration attempts.",
};

export class D3Client extends GliclassClient {
  constructor(baseUrl = "http://127.0.0.1:8002", opts = {}) {
    super(baseUrl);
    this.d3Model = opts.model ?? "vllm-sr/d3-nano";
    this._desc = {};
  }

  async predict(state, questions, opts) {
    const table = {};
    for (const [key, q] of Object.entries(questions ?? {})) {
      const crit = q && typeof q === "object" ? q.criteria : null;
      if (crit && typeof crit === "object") {
        for (const [label, desc] of Object.entries(crit)) {
          if (typeof desc === "string" && desc) table[label] = desc;
        }
      }
    }
    this._desc = table;
    return super.predict(state, questions, opts);
  }

  async scoreLabels(text, labels, { timeoutMs = 120000 } = {}) {
    if (!Array.isArray(labels) || labels.length < 2) {
      throw new Error(
        `d3 lane unavailable: choice needs >=2 options (got ${Array.isArray(labels) ? labels.length : "non-array"})`,
      );
    }
    const criteria = {};
    for (const l of labels) criteria[l] = this._desc[l] ?? STOCK_DESC[l] ?? l;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
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
        throw new Error(`d3 POST /predict HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      }
      const ans = body?.answers?.q;
      if (!ans || typeof ans.probabilities !== "object") {
        throw new Error("d3 returned invalid payload (missing answers.q.probabilities)");
      }
      const scores = labels.map((l) => ({ label: l, score: Number(ans.probabilities[l] ?? 0) }));
      return { scores, latencyMs: Number(body.latency_ms ?? 0) };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("d3 ")) throw err;
      throw new Error(err?.name === "AbortError" ? `d3 timed out after ${timeoutMs}ms` : `d3 unreachable at ${this.baseUrl}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
