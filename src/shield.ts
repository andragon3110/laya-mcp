/**
 * S5 (spike-guards wiring): thin HTTP client for the `shield-server`
 * sidecar process (ZeroLeaks/shield-small pre-filter, :8777).
 *
 * Mirrors the GlinerClient shape (same contract style): every call has an
 * explicit timeout, liveness/readiness/inventory probes are typed views
 * over GET /live, /ready, /models, and failures surface as a structured
 * `ShieldUnreachableError` -- never a raw throw, never a bare Error --
 * so the screen handler can degrade best-effort to the untouched judge
 * path (unreachable shield is noted in evidence metadata, never silent,
 * never a failure).
 *
 * Honesty vocabulary: the sidecar score is P(INJECTION) within-call only
 * (see py/shield_server.py); it travels here as `score` on the result
 * object and lands in evidence as `detector_score` (evidence.ts
 * `shieldSignal`), never as confidence or probability. The firm
 * INJECTION cut (0.99, measured-on-20) lives in the screen@1.1.0 policy
 * file, not here: this client applies no threshold.
 */
import type { BackendModelInfo, LiveResult, ReadyResult } from "./client.js";

/** Sidecar verdict label (contract: model BENIGN maps to SAFE). */
export type ShieldLabel = "SAFE" | "INJECTION";

/** POST /screen (alias of /predict) result: label + within-call score. */
export interface ShieldScreenResult {
  label: ShieldLabel;
  /** Raw sidecar score, P(INJECTION), within-call only (never calibrated). */
  score: number;
  scores: Record<string, number>;
  latencyMs: number;
  model: string;
}

export interface ShieldHealth {
  ready: boolean;
  model?: string;
  device?: string;
  error?: string;
}

/** Structured shield failure: code + optional HTTP status, never raw. */
export class ShieldUnreachableError extends Error {
  public readonly code: "timeout" | "unreachable" | "http_error" | "invalid_json";
  public readonly status?: number;

  constructor(
    message: string,
    code: "timeout" | "unreachable" | "http_error" | "invalid_json",
    status?: number,
  ) {
    super(message);
    this.name = "ShieldUnreachableError";
    this.code = code;
    this.status = status;
  }
}

export class ShieldClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string = process.env.SHIELD_URL ?? "http://127.0.0.1:8777") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const t = Number(process.env.SHIELD_TIMEOUT_MS ?? 2000);
    this.defaultTimeoutMs = Number.isFinite(t) ? t : 2000;
  }

  private async get(path: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { signal: ctrl.signal });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new ShieldUnreachableError(
          `shield-server ${path} timed out after ${timeoutMs}ms`,
          "timeout",
        );
      }
      throw new ShieldUnreachableError(
        `shield-server unreachable at ${this.baseUrl}`,
        "unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness probe: 200 with {alive:true} whenever the process is up. */
  async live(timeoutMs = 1000): Promise<LiveResult> {
    const { status, body } = await this.get("/live", timeoutMs);
    if (status !== 200 || body.alive !== true) {
      throw new ShieldUnreachableError(
        `shield-server /live returned HTTP ${status}`,
        "http_error",
        status,
      );
    }
    return {
      alive: true,
      service: typeof body.service === "string" ? body.service : undefined,
      version: typeof body.version === "string" ? body.version : undefined,
      uptimeSeconds: typeof body.uptime_seconds === "number" ? body.uptime_seconds : undefined,
    };
  }

  /**
   * Readiness probe: resolves on both 200 (ready) and 503 (not ready) with
   * the structured body; rejects only on timeout/unreachable/invalid shape.
   */
  async ready(timeoutMs = 1000): Promise<ReadyResult> {
    const { status, body } = await this.get("/ready", timeoutMs);
    if (status !== 200 && status !== 503) {
      throw new ShieldUnreachableError(
        `shield-server /ready returned HTTP ${status}`,
        "http_error",
        status,
      );
    }
    return {
      ready: body.ready === true,
      reason: typeof body.reason === "string" ? body.reason : null,
      loaded: Array.isArray(body.loaded) ? (body.loaded as string[]) : [],
      failed: Array.isArray(body.failed) ? (body.failed as ReadyResult["failed"]) : [],
      device: typeof body.device === "string" ? body.device : undefined,
      versions: (body.versions as Record<string, string>) ?? undefined,
      uptimeSeconds: typeof body.uptime_seconds === "number" ? body.uptime_seconds : undefined,
    };
  }

  /** Model inventory: always 200, never triggers a load server-side. */
  async models(timeoutMs = 1000): Promise<BackendModelInfo[]> {
    const { status, body } = await this.get("/models", timeoutMs);
    if (status !== 200 || !Array.isArray(body.models)) {
      throw new ShieldUnreachableError(
        `shield-server /models returned HTTP ${status}`,
        "http_error",
        status,
      );
    }
    return body.models as BackendModelInfo[];
  }

  /**
   * Score text with the shield-small pre-filter (POST /screen {text}).
   * Applies no threshold here: the caller (screen@1.1.0 / handleScreen)
   * owns the firm cut. Any transport or shape failure throws
   * ShieldUnreachableError (including HTTP 413 over the sidecar text cap
   * and 503 model-not-ready: both mean "no score", never a verdict).
   */
  async screen(text: string, timeoutMs?: number): Promise<ShieldScreenResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.defaultTimeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/screen`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ShieldUnreachableError(
          `shield-server /screen returned HTTP ${res.status}: ${body.slice(0, 200)}`,
          "http_error",
          res.status,
        );
      }
      const parsed = (await res.json()) as Record<string, unknown>;
      const label = parsed.label;
      const score = parsed.score;
      if ((label !== "SAFE" && label !== "INJECTION") || typeof score !== "number" || !Number.isFinite(score)) {
        throw new ShieldUnreachableError(
          "shield-server /screen returned an invalid payload (expected {label: SAFE|INJECTION, score: finite number})",
          "invalid_json",
          res.status,
        );
      }
      const scores = parsed.scores;
      return {
        label,
        score,
        scores:
          scores !== null && typeof scores === "object" && !Array.isArray(scores)
            ? (scores as Record<string, number>)
            : {},
        latencyMs: Number(parsed.latency_ms ?? 0),
        model: typeof parsed.model === "string" ? parsed.model : "shield-small",
      };
    } catch (err) {
      if (err instanceof ShieldUnreachableError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new ShieldUnreachableError(
          `shield-server /screen timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`,
          "timeout",
        );
      }
      throw new ShieldUnreachableError(
        `shield-server unreachable at ${this.baseUrl}`,
        "unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
