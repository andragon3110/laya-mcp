/**
 * P1-T4: policy registry + loader (versioned, structured errors).
 *
 * Policies are addressed by {name, version}. Unknown names OR unknown
 * versions fail with a structured `PolicyNotFoundError`
 * (`code === "policy_not_found"`, `detail` carries the requested ref plus
 * the full `available` list) — never with undefined behavior, never by
 * falling back to another policy.
 *
 * Threshold binding: `getPolicy` resolves the shared v1 table (with the
 * documented env overrides from thresholds.ts) at LOAD time when the
 * caller does not inject thresholds explicitly. Tests inject thresholds
 * via `opts.thresholds` and stay on the pure path.
 */
import type { PolicyThresholds } from "./thresholds.js";
import { thresholdsFromEnv } from "./thresholds.js";
import type { PolicyDefinition, PolicyRef } from "./types.js";
import { screenPolicy } from "./policies/screen.js";
import { verifyPolicy } from "./policies/verify.js";
import { findPolicy } from "./policies/find.js";
import { rerankPolicy } from "./policies/rerank.js";
import { classifyPolicy } from "./policies/classify.js";
import { decidePolicy } from "./policies/decide.js";
import { comparePolicy } from "./policies/compare.js";
import { extractPolicy } from "./policies/extract.js";
import { reviewPolicy } from "./policies/review.js";
import { gatePolicy } from "./policies/gate.js";
import { piiPolicy } from "./policies/pii.js";
import { codeReviewPolicy } from "./policies/code-review.js";
import { securityPolicy } from "./policies/security.js";
import { normalPolicy } from "./policies/normal.js";

const ALL: PolicyDefinition[] = [
  screenPolicy,
  verifyPolicy,
  findPolicy,
  rerankPolicy,
  classifyPolicy,
  decidePolicy,
  comparePolicy,
  extractPolicy,
  reviewPolicy,
  gatePolicy,
  piiPolicy,
  codeReviewPolicy,
  securityPolicy,
  normalPolicy,
];

const REGISTRY: ReadonlyMap<string, ReadonlyMap<string, PolicyDefinition>> = (() => {
  const byName = new Map<string, Map<string, PolicyDefinition>>();
  for (const p of ALL) {
    let versions = byName.get(p.name);
    if (!versions) {
      versions = new Map();
      byName.set(p.name, versions);
    }
    versions.set(p.version, p);
  }
  return byName;
})();

export interface PolicyNotFoundDetail {
  code: "policy_not_found";
  policy: PolicyRef;
  available: PolicyRef[];
}

/** Structured loader error: unknown policy name or version. */
export class PolicyNotFoundError extends Error {
  readonly code = "policy_not_found" as const;
  readonly detail: PolicyNotFoundDetail;

  constructor(requested: PolicyRef) {
    super(`policy_not_found: unknown policy "${requested.name}@${requested.version}"`);
    this.name = "PolicyNotFoundError";
    this.detail = { code: "policy_not_found", policy: { ...requested }, available: listPolicies() };
  }
}

/** Every registered {name, version} pair, sorted for stable output. */
export function listPolicies(): PolicyRef[] {
  return ALL.map((p) => ({ name: p.name, version: p.version })).sort((a, b) =>
    a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1,
  );
}

export interface LoadedPolicy {
  definition: PolicyDefinition;
  thresholds: PolicyThresholds;
}

/**
 * Load a policy by name+version. Throws PolicyNotFoundError when unknown.
 * Thresholds: explicit `opts.thresholds` win (pure/test path); otherwise
 * the shared v1 table with documented env overrides (load-time I/O only).
 */
export function getPolicy(name: string, version: string, opts?: { thresholds?: PolicyThresholds }): LoadedPolicy {
  const definition = REGISTRY.get(name)?.get(version);
  if (!definition) throw new PolicyNotFoundError({ name, version });
  return { definition, thresholds: opts?.thresholds ?? thresholdsFromEnv() };
}
