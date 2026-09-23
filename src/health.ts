/**
 * Background liveness watcher.
 *
 * - Polls `laya-server /health` every `checkIntervalMs`.
 * - Exposes the latest status synchronously for tool listing.
 * - Logs every transition but never blocks the MCP request loop.
 *
 * T3 note: still polls /health (warming) intentionally; migration to the
 * non-warming /live + /ready probes lands in T4. No behaviour change here.
 */
import type { HealthResult, LayaClient } from "./client.js";
import type { GlinerClient, GlinerHealth } from "./gliner.js";

type WatchedClient = Pick<LayaClient | GlinerClient, "health">;
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
    try {
      const next = await this.client.health(2000);
      const changed = JSON.stringify(next) !== JSON.stringify(this.status);
      this.status = next;
      if (changed) {
        const tag = next.ready ? "READY" : "DOWN";
        console.error(
          `[laya-mcp] ${this.label} ${tag}${next.error ? `: ${next.error}` : ""}`,
        );
        for (const fn of this.listeners) fn(next);
      }
    } catch (err) {
      this.status = { ready: false, error: (err as Error).message };
    }
  }
}
