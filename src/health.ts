/**
 * Background liveness + readiness watcher.
 *
 * - Polls `GET /live` (cheap liveness, never loads models) every
 *   `checkIntervalMs` (default 10s, 2s per-probe timeout).
 * - When the process is alive, polls `GET /ready` (non-warming readiness
 *   snapshot) to decide tool announcement.
 * - Exposes the latest status synchronously for tool listing.
 * - Logs every transition but never blocks the MCP request loop.
 *
 * T4: migrated off the warming /health probe onto /live + /ready, using
 * the T3 live()/ready() client methods. CallTool is intentionally left
 * intact (it does NOT consult this watcher): handlers already fail fast
 * on their own via client timeouts returning isError, and gating calls on
 * a 10s-stale snapshot could wrongly reject calls right after the backend
 * recovers. A watcher DOWN gate would also duplicate the connection-error
 * logic that already lives in the clients, with no new signal.
 */
import type { HealthResult, LayaClient } from "./client.js";
import type { GlinerClient, GlinerHealth } from "./gliner.js";

type WatchedClient = Pick<LayaClient | GlinerClient, "live" | "ready">;
type WatchedStatus = HealthResult | GlinerHealth;

export class HealthWatch {
  private status: WatchedStatus = { ready: false, error: "not checked yet" };
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: WatchedStatus) => void> = [];

  constructor(
    private readonly client: WatchedClient,
    private readonly checkIntervalMs = Number(process.env.LAYA_HEALTH_INTERVAL_MS ?? 10000),
    private readonly label = "laya-server",
  ) {}

  start(): void {
    if (this.timer !== null) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  current(): WatchedStatus {
    return this.status;
  }

  onChange(listener: (s: WatchedStatus) => void): void {
    this.listeners.push(listener);
  }

  private async poll(): Promise<void> {
    // Liveness first: cheap, never warms models. A throw here means the
    // process is down or unreachable (connection error) -- not a 4xx.
    try {
      await this.client.live(2000);
    } catch (err) {
      this.settle({ ready: false, error: (err as Error).message });
      return;
    }
    // Process alive: readiness decides announcement. /ready resolves on
    // both 200 (ready) and 503 (not ready); a throw is transport-level.
    try {
      const r = await this.client.ready(2000);
      this.settle(
        r.ready ? { ready: true } : { ready: false, error: r.reason ?? "not ready" },
      );
    } catch (err) {
      this.settle({ ready: false, error: (err as Error).message });
    }
  }

  private settle(next: WatchedStatus): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.status);
    this.status = next;
    if (changed) {
      const tag = next.ready ? "READY" : "DOWN";
      console.error(
        `[laya-mcp] ${this.label} ${tag}${next.error ? `: ${next.error}` : ""}`,
      );
      for (const fn of this.listeners) fn(next);
    }
  }
}
