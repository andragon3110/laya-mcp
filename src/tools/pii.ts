import type { LayaClient } from "../client.js";
import type { ToolContext } from "../index.js";
import { piiEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluate } from "../policy/engine.js";
import { getPolicy } from "../policy/loader.js";
import { type ToolDefinition, READONLY_TOOL_ANNOTATIONS, decisionSchema, evidenceSchema, abstentionSchema, envelopeMetadataProperties } from "../tool.js";

export const piiTool: ToolDefinition = {
  name: "laya_pii",
  description:
    "Scan text for PII and secrets (emails, phone numbers, API keys, tokens, passwords, person names) " +
    "using the GLiNER sidecar. Returns pipeline EVIDENCE (candidate spans with entity_type + span offsets + " +
    "detector_score, plus a null laya_signal: v1 applies no Laya risk cut -- the count-based policy is " +
    "preserved) plus the deterministic ALLOW/REVIEW/DENY/ESCALATE `decision` from the versioned pii@1.0.0 " +
    "policy. GLiNER proposes, Laya disposes -- every finding is a candidate, never a confirmed label. " +
    "Requires the gliner-server sidecar " +
    "(install.sh --with-gliner); fails clearly when it is down. " +
    "Text at most 50,000 chars, at most 32 extra types per call (larger inputs are rejected with input_too_large).",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", maxLength: LIMITS.maxGlinerTextChars, description: "Text to scan (max 50,000 chars)." },
      extra_types: {
        type: "array",
        maxItems: LIMITS.maxExtraTypes,
        items: { type: "string" },
        description: "Extra zero-shot entity types to look for alongside the PII set (max 32).",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      ...envelopeMetadataProperties(),
      pipeline: {
        type: "object",
        properties: {
          stages: { type: "array", items: { type: "string" } },
          gliner_spans: { type: "integer" },
          laya_judged: { type: "boolean" },
          laya_note: { type: "string" },
          policy: {
            type: "object",
            properties: { name: { type: "string" }, version: { type: "string" } },
            required: ["name", "version"],
          },
        },
        required: ["stages", "gliner_spans", "laya_judged", "laya_note", "policy"],
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            start: { type: "integer" },
            end: { type: "integer" },
            type: { type: "string" },
            entity_type: { type: "string" },
            span: {
              type: "object",
              properties: { start: { type: "integer" }, end: { type: "integer" } },
              required: ["start", "end"],
            },
            detector_score: { type: ["number", "null"] },
            laya_signal: { type: "null", description: "Null in v1: no Laya risk cut is applied." },
            category: {
              type: "string",
              enum: ["secret", "credential", "pii", "identifier", "unknown"],
            },
            finding_status: { type: "string", enum: ["candidate"] },
          },
          required: [
            "text",
            "start",
            "end",
            "type",
            "entity_type",
            "span",
            "detector_score",
            "laya_signal",
            "category",
            "finding_status",
          ],
        },
      },
      counts: { type: "object" },
      secrets_found: { type: "integer" },
      decision: decisionSchema(["ALLOW", "REVIEW", "DENY", "ESCALATE"]),
      latency_ms: { type: "number" },
      recommendation: { type: "string" },
      evidence: evidenceSchema("PII evidence bundle (candidate spans + weak-type report)."),
      abstention: abstentionSchema(),
    },
    required: [
      "pipeline",
      "findings",
      "counts",
      "secrets_found",
      "decision",
      "latency_ms",
      "recommendation",
      "evidence",
      "abstention",
    ],
  },
  annotations: READONLY_TOOL_ANNOTATIONS,
  buildQuestions: (args) => {
    // No Laya call: GLiNER spans are the whole answer. Still validate early
    // with the same vocabulary so oversized scans fail before any HTTP call
    // (the sidecar answers the identical 413 shape as the authority).
    assertLength(
      String(args.text ?? ""),
      LIMITS.maxGlinerTextChars,
      "text",
      `text exceeds ${LIMITS.maxGlinerTextChars} chars; scan per chunk instead`,
    );
    assertCount(
      Array.isArray(args.extra_types) ? args.extra_types.length : 0,
      LIMITS.maxExtraTypes,
      "extra_types",
      `at most ${LIMITS.maxExtraTypes} extra types per call`,
    );
    return {};
  },
};

/**
 * v1 finding category. The POLICY still branches only on secret membership
 * (preserved count-based cut from the shared table); `category` is an
 * honest display label so PII/credential/secret/identifier/unknown stay
 * distinguishable in evidence. `false-positive` is RESERVED for a future
 * confirming judge -- v1 never emits it: every finding ships with
 * finding_status "candidate" (GLiNER proposes, never confirms; doubting a
 * candidate is the human reviewer's job via REVIEW/ESCALATE).
 */
export function piiCategoryFor(entityType: string, secretTypes: Set<string>): string {
  if (secretTypes.has(entityType)) return "secret";
  const lower = entityType.toLowerCase();
  if (
    lower.includes("credential") ||
    lower.includes("private_key") ||
    lower.includes("privatekey") ||
    lower === "token" ||
    lower.endsWith("_token") ||
    lower.endsWith("_key") ||
    lower === "secret"
  ) {
    return "credential";
  }
  if (
    ["passport", "passport_number", "ssn", "social_security", "dni", "nie", "national_id", "id_number", "driver_license", "ip", "ip_address"].includes(
      lower,
    )
  ) {
    return "identifier";
  }
  if (
    [
      "email",
      "phone",
      "phone_number",
      "person",
      "person_name",
      "name",
      "given_name",
      "surname",
      "address",
      "street_address",
      "location",
      "date_of_birth",
      "dob",
      "birthdate",
      "credit_card",
      "credit_card_number",
      "bank_account",
      "iban",
      "api_key",
      "token_secreto",
      "password",
    ].includes(lower)
  ) {
    return "pii";
  }
  return "unknown";
}

/**
 * P1-T6 (breaking): `laya_pii` reports the GLiNER -> candidate-spans ->
 * Laya-risk -> Policy pipeline explicitly plus the engine decision. The
 * legacy `action` (block/review/pass) is gone -- the decision is
 * `{decision, reason_codes, policy}` from pii@1.0.0 over the shared
 * secret-type table (no local SECRET_TYPES literal; env overrides apply).
 * Each finding now carries `entity_type` + `span` + `detector_score`
 * (renamed from the sidecar `confidence`, uncalibrated) + `laya_signal`
 * (null in v1: no Laya risk judge runs -- the count-based policy is
 * preserved, so the null is explicit instead of hidden) + `category`
 * (secret/credential/pii/identifier/unknown; false-positive reserved, v1
 * never emits it) + `finding_status: "candidate"`. The sidecar-verbatim
 * `type` alias is kept so span round-trip consumers keep working. Secret
 * membership still decides DENY; any non-secret finding still REVIEWs at
 * the policy level, while all-weak-type scans still abstain to ESCALATE
 * via the global rule (ambiguous detector judgment, preserved from T3).
 */
export async function handlePii(
  _client: LayaClient,
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  if (!ctx || !ctx.glinerReady()) {
    throw new Error(
      "laya_pii needs the gliner-server sidecar, which is not reachable. " +
        "Start it with $HOME/laya-mcp/start_gliner.sh (installed via install.sh --with-gliner). " +
        "The agent continues without PII scanning.",
    );
  }
  // Early size check with the shared vocabulary (the sidecar 413s as the
  // authority; this just fails before the HTTP round trip).
  piiTool.buildQuestions(args);
  const text = String(args.text ?? "");
  const extra = Array.isArray(args.extra_types) ? (args.extra_types as string[]) : [];
  const { findings, counts, latencyMs } = await ctx.gliner.piiScan(text, extra);
  // P1-T6: secret membership resolves from the shared table (env overrides
  // preserved); no local literal remains in this handler.
  const { thresholds } = getPolicy("pii", "1.0.0");
  const secretSet = new Set(thresholds.secretTypes);
  const secrets = findings.filter((f) => secretSet.has(f.type));
  const { evidence, abstention } = piiEvidence({
    findings: findings.map((f) => ({
      text: f.text,
      start: f.start,
      end: f.end,
      type: f.type,
      detectorScore: typeof f.confidence === "number" ? f.confidence : null,
      weak_type: !secretSet.has(f.type),
    })),
    weakTypes: findings.filter((f) => !secretSet.has(f.type)).map((f) => f.type),
  });
  const decision = evaluate(
    {
      evidence,
      abstention,
      context: { finding_count: findings.length, secret_count: secrets.length },
      risk: "normal",
      policy: { name: "pii", version: "1.0.0" },
    },
    { thresholds },
  );
  const enriched = findings.map((f) => ({
    text: f.text,
    start: f.start,
    end: f.end,
    type: f.type,
    entity_type: f.type,
    span: { start: f.start, end: f.end },
    detector_score: typeof f.confidence === "number" ? f.confidence : null,
    laya_signal: null,
    category: piiCategoryFor(f.type, secretSet),
    finding_status: "candidate",
  }));
  return JSON.stringify(
    {
      pipeline: {
        stages: ["gliner", "laya_risk", "policy"],
        gliner_spans: findings.length,
        laya_judged: false,
        laya_note:
          "v1 applies no Laya risk cut: laya_signal is null for every finding and the " +
          "pii@1.0.0 count-based policy decides from GLiNER candidate spans alone (preserved behavior).",
        policy: { name: "pii", version: "1.0.0" },
      },
      findings: enriched,
      counts,
      secrets_found: secrets.length,
      decision,
      latency_ms: latencyMs,
      recommendation:
        decision.decision === "DENY"
          ? "Secrets detected. Redact before the text enters any model context or leaves the machine."
          : decision.decision === "ALLOW"
            ? "No PII or secrets detected."
            : "PII detected. Review whether each finding may enter context.",
      evidence,
      abstention,
    },
    null,
    2,
  );
}
