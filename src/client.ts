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

  async health(timeoutMs = 1000): Promise<HealthResult> {
    const ctrl = new AbortController();
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
