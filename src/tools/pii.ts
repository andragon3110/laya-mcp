import { BackendUnavailableError, type LayaClient } from "../client.js";
import type { GlinerSpan } from "../gliner.js";
import type { ToolContext } from "../index.js";
import { piiEvidence } from "../evidence.js";
import { LIMITS, assertCount, assertLength } from "../limits.js";
import { evaluateForTool } from "../policy/mode.js";
import { getPolicy } from "../policy/loader.js";
import type { RiskTier } from "../policy/types.js";
import { type ToolDefinition, READONLY_TOOL_ANNOTATIONS, TOOL_TIMEOUT_MS, decisionSchema, evidenceSchema, abstentionSchema, shadowSchema, envelopeMetadataProperties } from "../tool.js";

const RISKS: readonly RiskTier[] = ["low", "normal", "high"];

function normalizeRisk(v: unknown): RiskTier {
  if (v === undefined) return "normal";
  if (typeof v === "string" && (RISKS as readonly string[]).includes(v)) return v as RiskTier;
  throw new Error(`laya_pii: risk must be one of ${RISKS.join("|")} (got ${JSON.stringify(v)})`);
}

export const piiTool: ToolDefinition = {
  name: "laya_pii",
  description:
    "Scan text for PII and secrets (emails, phone numbers, API keys, tokens, passwords, person names) " +
    "using the GLiNER sidecar, then ask Laya to judge every candidate span (one noul confirmation " +
    "per span: is this span really {entity-type}?). Returns pipeline EVIDENCE (candidate spans with " +
    "entity_type + span offsets + detector_score, plus the per-finding Laya `laya_signal`) plus the " +
    "deterministic ALLOW/REVIEW/DENY/ESCALATE `decision` from the versioned pii@1.0.0 policy " +
    "(count-based over GLiNER candidate spans; the optional risk tier moves the non-secret branch). " +
    "GLiNER proposes, Laya judges each span, the Policy decides -- every finding stays a candidate, " +
    "never a confirmed label. " +
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
      risk: {
        type: "string",
        enum: ["low", "normal", "high"],
        description: "Optional risk tier forwarded to the policy engine (default normal; moves the non-secret branch).",
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
            laya_signal: {
              type: ["number", "null"],
              description:
                "Laya judge noul per span (raw, uncalibrated): high supports the span, low doubts it, " +
                "null abstains (judge unreachable or span unjudged -- see pipeline.laya_note). " +
                "Informational only: the policy still decides from GLiNER candidate counts.",
            },
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
      shadow: shadowSchema(),
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
 * T2 Laya-judge over GLiNER candidate spans. Returns one `laya_signal` per
 * finding (raw noul, uncalibrated; null = the judge abstained on that span)
 * plus the batch `judged` flag (true iff every finding carries a signal --
 * vacuously true with zero findings, when no Laya call is made at all), an
 * honest `note`, and the judge `latencyMs` (0 when uncalled).
 *
 * Failure contract: only a BackendUnavailableError (unreachable / timeout /
 * /predict HTTP error / invalid payload) degrades to all-null + judged:false
 * + the backend reason in the note. Any other throw (programming error, GLiNER
 * failure upstream) propagates -- a broken judge call must never masquerade
 * as a backend outage, and a backend outage must never fail the scan.
 */
export interface PiiJudgeResult {
  signals: Array<number | null>;
  judged: boolean;
  note: string;
  latencyMs: number;
}

export function piiJudgeQuestions(
  findings: GlinerSpan[],
): { questions: Record<string, unknown>; judgedCount: number } {
  const judgedCount = Math.min(findings.length, LIMITS.maxQuestions);
  const questions: Record<string, unknown> = {};
  for (let i = 0; i < judgedCount; i++) {
    const f = findings[i];
    questions[`pii_judge_${i}`] = {
      type: "noul",
      instructions:
        `Is this detected span really '${f.type}'? Span text: '${f.text}' ` +
        `(chars ${f.start}-${f.end}). Judge the span only, not the surrounding text.`,
      criteria: {
        true: `The span really is ${f.type}.`,
        false: `The span is not ${f.type} (false positive or wrong entity type).`,
      },
    };
  }
  return { questions, judgedCount };
}

export async function judgePiiSpans(
  client: LayaClient,
  text: string,
  findings: GlinerSpan[],
): Promise<PiiJudgeResult> {
  if (findings.length === 0) {
    return {
      signals: [],
      judged: true,
      note: "no GLiNER spans to judge; Laya judge not called (vacuous cover).",
      latencyMs: 0,
    };
  }
  const { questions, judgedCount } = piiJudgeQuestions(findings);
  const truncated = findings.length - judgedCount;
  try {
    const raw = await client.predict({ text }, questions, TOOL_TIMEOUT_MS);
    const signals: Array<number | null> = findings.map((_, i) => {
      if (i >= judgedCount) return null;
      const ans = (raw.answers ?? {})[`pii_judge_${i}`] as { noul?: unknown } | undefined;
      return typeof ans?.noul === "number" ? ans.noul : null;
    });
    const answered = signals.filter((s) => typeof s === "number").length;
    const judged = answered === findings.length;
    const parts = [
      `Laya judged ${answered}/${findings.length} GLiNER span(s) in one additional /predict call (noul per span); ` +
        `laya_signal carries the raw signal per finding (high supports, low doubts, null abstains).`,
    ];
    if (truncated > 0) {
      parts.push(
        `${truncated} span(s) beyond the ${LIMITS.maxQuestions}-question budget were not sent and carry null.`,
      );
    }
    if (!judged && truncated === 0) {
      parts.push("Unjudged spans carry null: the backend gave no noul answer for their question.");
    }
    return { signals, judged, note: parts.join(" "), latencyMs: Number(raw.latencyMs ?? 0) };
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        signals: findings.map(() => null),
        judged: false,
        note:
          `Laya judge unavailable (${reason}); every laya_signal is null ` +
          `(GLiNER-only degrade, no signal invented). No span text is echoed here.`,
        latencyMs: 0,
      };
    }
    throw err;
  }
}

/**
 * fut-b-semantica T2: `laya_pii` runs GLiNER -> Laya-judge -> Policy.
 * GLiNER proposes candidate spans; Laya judges EACH span with one `noul`
 * confirmation question per span in an ADDITIONAL /predict call (it cannot
 * share a call with anything: the spans are only known after GLiNER
 * answers); the pii@1.0.0 policy decides from GLiNER candidate counts, with
 * the optional `risk` tier moving only the non-secret branch. Authority is
 * unchanged: the judge signal (high = supports, low = doubts, null =
 * abstains) is informational per finding -- `finding_status` stays
 * "candidate" and the decision still comes from the engine. A judge failure
 * (backend unreachable/timeout/http/invalid) degrades to explicit nulls
 * with an honest note -- it never fails the scan (the GLiNER evidence
 * survives) and never invents signals.
 *
 * `laya_judged` is true iff every finding carries a non-null `laya_signal`
 * (vacuously true when GLiNER reports zero spans: nothing to judge, no Laya
 * call is made). At most LIMITS.maxQuestions spans are judged per call (one
 * question per span fits the 64-question server budget); extras keep null
 * with the truncation named in the note.
 */
export async function handlePii(
  client: LayaClient,
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
  const risk = normalizeRisk(args.risk);
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
  // T2 judge: one noul confirmation per GLiNER span ("is this span really
  // {entity-type}?"). Evidence/abstention above stay GLiNER-only (the judge
  // informs the reviewer, never the policy input); the decision below still
  // counts GLiNER candidates.
  const judged = await judgePiiSpans(client, text, findings);
  const { decision, shadow } = evaluateForTool(
    "laya_pii",
    {
      evidence,
      abstention,
      context: { finding_count: findings.length, secret_count: secrets.length },
      risk,
      policy: { name: "pii", version: "1.0.0" },
    },
    { thresholds },
  );
  const enriched = findings.map((f, i) => ({
    text: f.text,
    start: f.start,
    end: f.end,
    type: f.type,
    entity_type: f.type,
    span: { start: f.start, end: f.end },
    detector_score: typeof f.confidence === "number" ? f.confidence : null,
    laya_signal: judged.signals[i] ?? null,
    category: piiCategoryFor(f.type, secretSet),
    finding_status: "candidate",
  }));
  return JSON.stringify(
    {
      pipeline: {
        stages: ["gliner", "laya_risk", "policy"],
        gliner_spans: findings.length,
        laya_judged: judged.judged,
        laya_note: judged.note,
        policy: { name: "pii", version: "1.0.0" },
      },
      findings: enriched,
      counts,
      secrets_found: secrets.length,
      decision,
      ...(shadow ? { shadow } : {}),
      latency_ms: latencyMs + judged.latencyMs,
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
