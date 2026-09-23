/**
 * Thin HTTP client for the Python `laya-server` process.
 *
 * Every call has an explicit timeout. If the server is unreachable or slow,
 * callers receive a structured `LayaUnavailableError` so tool handlers can
 * return an MCP `isError: true` response rather than hanging the agent.
 */
export interface PredictResult {
  answers: Record<string, unknown>;
  confidence: Record<string, number>;
  routing: Record<string, unknown>;
  model: string;
  latencyMs: number;
  usage: Record<string, number>;
}

export interface HealthResult {
  ready: boolean;
  model?: string;
  device?: string;
  language?: string;
  error?: string;
}

/**
 * T4: typed views over the k8s-style probes (GET /live, /ready, /models).
 * The background HealthWatch polls /live (liveness) + /ready (readiness)
 * since T4; /health remains only as a legacy warming endpoint.
 */
export interface LiveResult {
  alive: boolean;
  service?: string;
  version?: string;
  uptimeSeconds?: number;
}

export interface ReadyFailedEntry {
  name: string;
  repo?: string;
  error?: string;
}

export interface ReadyResult {
  ready: boolean;
  reason?: string | null;
  loaded?: string[];
  failed?: ReadyFailedEntry[];
  device?: string;
  versions?: Record<string, string>;
  uptimeSeconds?: number;
  /** Load circuit-breaker state (T4): "closed" | "open" | "half-open". */
  circuit?: string;
}

export interface BackendModelInfo {
  name: string;
  repo?: string;
  loaded: boolean;
  /** Null when the pin is not resolvable offline (revision_source explains why). */
  revision: string | null;
  revision_source?: string;
  device?: string;
  /** Load circuit-breaker state (T4): "closed" | "open" | "half-open". */
  circuit?: string;
}

export class BackendUnavailableError extends Error {
  public readonly code: "timeout" | "unreachable" | "http_error" | "invalid_json";
  public readonly status?: number;

  constructor(
    message: string,
    code: "timeout" | "unreachable" | "http_error" | "invalid_json",
    status?: number,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
    this.code = code;
    this.status = status;
  }
}

/** Backwards-compatible alias. New code should use BackendUnavailableError. */
export const LayaUnavailableError = BackendUnavailableError;
export type LayaUnavailableError = BackendUnavailableError;

export interface PredictOpts {
  /** Force a Router checkpoint: "english" | "multilingual" | "typed-decisions". */
  model?: string;
  /** Force a task family (with auto_task_detection). */
  task?: string;
  /** Force a language hint (e.g. "es"). */
  lang?: string;
  /** Per-call timeout override. */
  timeoutMs?: number;
}

export class LayaClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string = process.env.LAYA_URL ?? "http://127.0.0.1:8765") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultTimeoutMs = Number(process.env.LAYA_TIMEOUT_MS ?? 5000);
  }

  async health(timeoutMs = 1000): Promise<HealthResult> {    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      if (!res.ok) {
        throw new LayaUnavailableError(
          `laya-server /health returned HTTP ${res.status}`,
          "http_error",
          res.status,
        );
      }
      const body = (await res.json()) as Record<string, unknown>;
      const ready = body.status === "ok" && body.ready !== false;
      return {
        ready,
        model: typeof body.model === "string" ? body.model : undefined,
        device: typeof body.device === "string" ? body.device : undefined,
        language: typeof body.language === "string" ? body.language : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      };
    } catch (err) {
      if (err instanceof LayaUnavailableError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new LayaUnavailableError(
          `laya-server /health timed out after ${timeoutMs}ms`,
          "timeout",
        );
      }
      throw new LayaUnavailableError(
        `laya-server unreachable at ${this.baseUrl}`,
        "unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
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
        throw new LayaUnavailableError(
          `laya-server ${path} timed out after ${timeoutMs}ms`,
          "timeout",
        );
      }
      throw new LayaUnavailableError(
        `laya-server unreachable at ${this.baseUrl}`,
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
      throw new LayaUnavailableError(
        `laya-server /live returned HTTP ${status}`,
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
   * the structured body; rejects only on timeout/unreachable/invalid JSON.
   */
  async ready(timeoutMs = 1000): Promise<ReadyResult> {
    const { status, body } = await this.get("/ready", timeoutMs);
    if (status !== 200 && status !== 503) {
      throw new LayaUnavailableError(
        `laya-server /ready returned HTTP ${status}`,
        "http_error",
        status,
      );
    }
    return {
      ready: body.ready === true,
      reason: typeof body.reason === "string" ? body.reason : null,
      loaded: Array.isArray(body.loaded) ? (body.loaded as string[]) : [],
      failed: Array.isArray(body.failed) ? (body.failed as ReadyFailedEntry[]) : [],
      device: typeof body.device === "string" ? body.device : undefined,
      versions: (body.versions as Record<string, string>) ?? undefined,
      uptimeSeconds: typeof body.uptime_seconds === "number" ? body.uptime_seconds : undefined,
      circuit: typeof body.circuit === "string" ? body.circuit : undefined,
    };
  }

  /** Model inventory: always 200, never triggers a load server-side. */
  async models(timeoutMs = 1000): Promise<BackendModelInfo[]> {
    const { status, body } = await this.get("/models", timeoutMs);
    if (status !== 200 || !Array.isArray(body.models)) {
      throw new LayaUnavailableError(
        `laya-server /models returned HTTP ${status}`,
        "http_error",
        status,
      );
    }
    return body.models as BackendModelInfo[];
  }

  async predict(
    state: unknown,
    questions: Record<string, unknown>,
    timeoutMs?: number,
    opts?: PredictOpts,
  ): Promise<PredictResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.defaultTimeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          state,
          questions,
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.task ? { task: opts.task } : {}),
          ...(opts?.lang ? { lang: opts.lang } : {}),
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new LayaUnavailableError(
          `laya-server /predict returned HTTP ${res.status}: ${text.slice(0, 200)}`,
          "http_error",
          res.status,
        );
      }
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.answers !== "object" || body.answers === null) {
        throw new LayaUnavailableError(
          "laya-server returned invalid payload (missing answers)",
          "invalid_json",
        );
      }
      return {
        answers: body.answers as Record<string, unknown>,
        confidence: (body.confidence as Record<string, number>) ?? {},
        routing: (body.routing as Record<string, unknown>) ?? {},
        model: (body.model as string) ?? "laya",
        latencyMs: Number(body.latency_ms ?? 0),
        usage: (body.usage as Record<string, number>) ?? {},
      };
    } catch (err) {
      if (err instanceof LayaUnavailableError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new LayaUnavailableError(
          `laya-server /predict timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`,
          "timeout",
        );
      }
      throw new LayaUnavailableError(
        `laya-server unreachable at ${this.baseUrl}`,
        "unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
