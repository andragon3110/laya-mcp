/**
 * `laya_escalations` -- the abstention sink (first non-readonly tool).
 *
 * The 12 judgment tools can say ESCALATE/abstain, but abstentions used to
 * evaporate. This tool closes the loop: `log` records an escalation,
 * `list` triages the queue, `ack` files the human verdict. Acked records
 * are future training data (see odd/tasks/phase2-data-templates.md).
 *
 * Store: append-only JSONL, one event per line (`logged`/`acknowledged`;
 * no read-modify-write, so concurrent appends never corrupt state).
 * Location: `LAYA_ESCALATIONS_FILE` env, else `<repo>/var/escalations.jsonl`
 * (`/var/` is gitignored -- queue state is runtime, never committed).
 * IDs `esc-NNNN` come from the logged-count (the stdio server serves calls
 * sequentially). Unknown action/id/field rejects with `invalid_argument`
 * (isError over the wire -- same precedent as capabilities' timeout_ms).
 *
 * Needs NO backend: log/list/ack are local file operations, so this tool
 * shares the capabilities list exemption (advertised even with every
 * backend down). Annotations say so honestly: readOnlyHint false,
 * destructiveHint false (append/ack only), idempotentHint false.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ToolDefinition,
  envelopeMetadataProperties,
} from "../tool.js";

export const ESCALATIONS_ACTIONS = ["log", "list", "ack"] as const;
export const ESCALATION_PRIMITIVES = ["noul", "choice", "score", "spans"] as const;
export const ESCALATION_STATUS = ["open", "acked", "all"] as const;

export interface EscalationRecord {
  id: string;
  ts: string;
  primitive: string;
  tool: string;
  decision: string;
  reason: string;
  case_id: string | null;
  context: unknown;
  status: "open" | "acked";
  verdict: string | null;
  reviewer: string | null;
  ack_ts: string | null;
  ack_note: string | null;
}

interface StoreEvent {
  type: "logged" | "acknowledged";
  [k: string]: unknown;
}

/** Store file: explicit env wins, else the repo-local runtime dir. */
export function resolveStoreFile(): string {
  const env = (process.env.LAYA_ESCALATIONS_FILE ?? "").trim();
  if (env !== "") return env;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(repoRoot, "var", "escalations.jsonl");
}

function readEvents(file: string): StoreEvent[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
  const events: StoreEvent[] = [];
  for (const [i, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as StoreEvent);
    } catch {
      throw new Error(`escalations store unreadable: ${file} line ${i + 1} is not JSON`);
    }
  }
  return events;
}

function appendEvent(file: string, event: StoreEvent): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Fold events into records; latest ack wins, history preserved in the file. */
export function foldRecords(events: StoreEvent[]): EscalationRecord[] {
  const byId = new Map<string, EscalationRecord>();
  for (const e of events) {
    if (e.type === "logged" && typeof e.id === "string") {
      byId.set(e.id, {
        id: e.id,
        ts: typeof e.ts === "string" ? e.ts : "",
        primitive: typeof e.primitive === "string" ? e.primitive : "",
        tool: typeof e.tool === "string" ? e.tool : "",
        decision: typeof e.decision === "string" ? e.decision : "",
        reason: typeof e.reason === "string" ? e.reason : "",
        case_id: typeof e.case_id === "string" ? e.case_id : null,
        context: "context" in e ? e.context : null,
        status: "open",
        verdict: null,
        reviewer: null,
        ack_ts: null,
        ack_note: null,
      });
    } else if (e.type === "acknowledged" && typeof e.id === "string") {
      const rec = byId.get(e.id);
      if (rec) {
        rec.status = "acked";
        rec.verdict = typeof e.verdict === "string" ? e.verdict : null;
        rec.reviewer = typeof e.reviewer === "string" ? e.reviewer : null;
        rec.ack_ts = typeof e.ts === "string" ? e.ts : null;
        rec.ack_note = typeof e.note === "string" ? e.note : null;
      }
    }
  }
  return [...byId.values()];
}

export const escalationsTool: ToolDefinition = {
  name: "laya_escalations",
  description:
    "File human-reviewable escalations the judgment tools emit (ESCALATE/abstain) instead of guessing. " +
    "Actions: log records one escalation and returns its id (esc-NNNN); list triages the queue " +
    "(status open|acked|all, default open); ack files the human verdict on one id (later acks supersede, " +
    "history stays in the file). Acked records are future training data. Append-only local JSONL store " +
    "at LAYA_ESCALATIONS_FILE else <repo>/var/escalations.jsonl (runtime state, never committed). " +
    "Needs no backend: advertised and callable even with every sidecar down.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...ESCALATIONS_ACTIONS],
        description: "log records one escalation; list triages the queue; ack files a human verdict.",
      },
      primitive: {
        type: "string",
        enum: [...ESCALATION_PRIMITIVES],
        description: "Judgment signal kind of the escalating call (log only).",
      },
      tool: {
        type: "string",
        description: "Escalating tool name, e.g. laya_gate (log only).",
      },
      decision: {
        type: "string",
        description: "The abstaining decision, e.g. ESCALATE or REVIEW (log only).",
      },
      reason: {
        type: "string",
        description: "Why it abstained, one line (log only).",
      },
      case_id: {
        type: "string",
        description: "Corpus/eval case id when the escalation comes from a measured run (log only).",
      },
      context: {
        description: "Small caller context (ids, not content) stored verbatim (log only).",
      },
      status: {
        type: "string",
        enum: [...ESCALATION_STATUS],
        description: "list filter (default open).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "list cap (default 100).",
      },
      escalation_id: {
        type: "string",
        description: "Target id for ack, e.g. esc-0001 (ack only).",
      },
      verdict: {
        type: "string",
        description: "Human verdict filed on ack, e.g. ABSTAIN (ack only).",
      },
      reviewer: {
        type: "string",
        description: "Who acked (ack only).",
      },
      note: {
        type: "string",
        description: "Reviewer note (ack only).",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ESCALATIONS_ACTIONS] },
      ok: { type: "boolean" },
      escalation_id: { type: "string" },
      escalation: { type: "object" },
      escalations: { type: "array", items: { type: "object" } },
      status: { type: "string" },
      open: { type: "integer" },
      acked: { type: "integer" },
      store: { type: "string" },
      ...envelopeMetadataProperties(),
    },
    required: ["action", "ok"],
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
  // No backend call: the questions builder is a no-op satisfying ToolDefinition.
  buildQuestions: () => ({}),
};

function invalidArg(detail: string): Error {
  return new Error(`invalid_argument: laya_escalations ${detail}`);
}

/**
 * log/list/ack over the local JSONL store. Throws ( -> isError, no
 * structuredContent) on invalid arguments or an unreadable store.
 */
export async function handleEscalations(
  _client: unknown,
  args: Record<string, unknown>,
  _ctx: unknown,
): Promise<string> {
  const action = args.action;
  if (action !== "log" && action !== "list" && action !== "ack") {
    throw invalidArg(`action must be one of log|list|ack (got ${JSON.stringify(action) ?? "undefined"})`);
  }
  const file = resolveStoreFile();
  if (action === "log") {
    const { primitive, tool, decision, reason } = args;
    if (!nonEmptyString(primitive) || !(ESCALATION_PRIMITIVES as readonly string[]).includes(primitive)) {
      throw invalidArg(`log needs primitive one of ${(ESCALATION_PRIMITIVES as readonly string[]).join("|")}`);
    }
    if (!nonEmptyString(tool)) throw invalidArg("log needs a non-empty tool name");
    if (!nonEmptyString(decision)) throw invalidArg("log needs a non-empty decision");
    if (!nonEmptyString(reason)) throw invalidArg("log needs a non-empty reason");
    const events = readEvents(file);
    const logged = events.filter((e) => e.type === "logged").length;
    const id = `esc-${String(logged + 1).padStart(4, "0")}`;
    const event: StoreEvent = {
      type: "logged",
      id,
      ts: new Date().toISOString(),
      primitive,
      tool,
      decision,
      reason,
      case_id: typeof args.case_id === "string" ? args.case_id : null,
      context: "context" in args ? args.context : null,
    };
    appendEvent(file, event);
    const [record] = foldRecords([...events, event]).filter((r) => r.id === id);
    return JSON.stringify({ action, ok: true, escalation_id: id, escalation: record, store: file }, null, 2);
  }
  if (action === "list") {
    const status = args.status ?? "open";
    if (status !== "open" && status !== "acked" && status !== "all") {
      throw invalidArg("list status must be one of open|acked|all");
    }
    const limit = args.limit ?? 100;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw invalidArg("list limit must be an integer in [1, 500]");
    }
    const records = foldRecords(readEvents(file));
    const open = records.filter((r) => r.status === "open").length;
    const filtered = (status === "all" ? records : records.filter((r) => r.status === status)).slice(0, limit);
    return JSON.stringify(
      { action, ok: true, status, open, acked: records.length - open, escalations: filtered, store: file },
      null,
      2,
    );
  }
  const { escalation_id, verdict } = args;
  if (!nonEmptyString(escalation_id)) throw invalidArg("ack needs a non-empty escalation_id");
  if (!nonEmptyString(verdict)) throw invalidArg("ack needs a non-empty verdict");
  const events = readEvents(file);
  const records = foldRecords(events);
  const target = records.find((r) => r.id === escalation_id);
  if (!target) throw invalidArg(`unknown escalation_id ${JSON.stringify(escalation_id)}`);
  const event: StoreEvent = {
    type: "acknowledged",
    id: escalation_id,
    ts: new Date().toISOString(),
    verdict,
    reviewer: typeof args.reviewer === "string" ? args.reviewer : null,
    note: typeof args.note === "string" ? args.note : null,
  };
  appendEvent(file, event);
  const [updated] = foldRecords([...events, event]).filter((r) => r.id === escalation_id);
  return JSON.stringify({ action, ok: true, escalation_id, escalation: updated, store: file }, null, 2);
}
