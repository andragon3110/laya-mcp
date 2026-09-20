/**
 * Thin HTTP client for the optional `gliner-server` sidecar process.
 *
 * Same contract as LayaClient: every call has an explicit timeout and
 * failures surface as BackendUnavailableError so tool handlers can
 * degrade gracefully (regex fallback for extract, clear error for pii).
 */
import { BackendUnavailableError } from "./client.js";

export interface GlinerSpan {
  text: string;
  start: number;
  end: number;
  confidence: number;
  type: string;
}

export interface GlinerHealth {
  ready: boolean;
  model?: string;
  device?: string;
  error?: string;
}

export class GlinerClient {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string = process.env.GLINER_URL ?? "http://127.0.0.1:8766") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.defaultTimeoutMs = Number(process.env.GLINER_TIMEOUT_MS ?? 10000);
  }

  async health(timeoutMs = 1000): Promise<GlinerHealth> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: ctrl.signal });
      if (!res.ok) {
        throw new BackendUnavailableError(
          `gliner-server /health returned HTTP ${res.status}`,
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
        error: typeof body.error === "string" ? body.error : undefined,
      };
    } catch (err) {
      if (err instanceof BackendUnavailableError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new BackendUnavailableError(
          `gliner-server /health timed out after ${timeoutMs}ms`,
          "timeout",
        );
      }
      throw new BackendUnavailableError(
        `gliner-server unreachable at ${this.baseUrl}`,
        "unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async post<T>(path: string, payload: unknown, timeoutMs?: number): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? this.defaultTimeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new BackendUnavailableError(
          `gliner-server ${path} returned HTTP ${res.status}: ${text.slice(0, 200)}`,
          "http_error",
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof BackendUnavailableError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new BackendUnavailableError(
          `gliner-server ${path} timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`,
          "timeout",
        );
      }
      throw new BackendUnavailableError(
        `gliner-server unreachable at ${this.baseUrl}`,
        "unreachable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async extractEntities(
    text: string,
    labels: string[] | Record<string, string>,
  ): Promise<{ spansByType: Record<string, GlinerSpan[]>; latencyMs: number }> {
    const body = await this.post<{
      entities: Record<string, Array<{ text: string; start: number; end: number; confidence: number }>>;
      latency_ms: number;
    }>("/extract_entities", { text, labels });
    const spansByType: Record<string, GlinerSpan[]> = {};
    for (const [type, spans] of Object.entries(body.entities ?? {})) {
      spansByType[type] = (spans ?? []).map((s) => ({ ...s, type }));
    }
    return { spansByType, latencyMs: Number(body.latency_ms ?? 0) };
  }

  async piiScan(
    text: string,
    extraTypes: string[] = [],
  ): Promise<{ findings: GlinerSpan[]; counts: Record<string, number>; latencyMs: number }> {
    const body = await this.post<{
      findings: GlinerSpan[];
      counts: Record<string, number>;
      latency_ms: number;
    }>("/pii_scan", { text, extra_types: extraTypes });
    return {
      findings: body.findings ?? [],
      counts: body.counts ?? {},
      latencyMs: Number(body.latency_ms ?? 0),
    };
  }

  async classify(text: string, tasks: Record<string, unknown>): Promise<{ result: unknown; latencyMs: number }> {
    const body = await this.post<{ result: unknown; latency_ms: number }>("/classify", { text, tasks });
    return { result: body.result, latencyMs: Number(body.latency_ms ?? 0) };
  }
}
