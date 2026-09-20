/**
 * Background liveness watcher.
 *
 * - Polls `laya-server /health` every `checkIntervalMs`.
 * - Exposes the latest status synchronously for tool listing.
 * - Logs every transition but never blocks the MCP request loop.
 */
import type { HealthResult, LayaClient } from "./client.js";

export class HealthWatch {
  private status: HealthResult = { ready: false, error: "not checked yet" };
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(s: HealthResult) => void> = [];

  constructor(
    private readonly client: LayaClient,
    private readonly checkIntervalMs = Number(process.env.LAYA_HEALTH_INTERVAL_MS ?? 10000),
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

  current(): HealthResult {
    return this.status;
  }

  onChange(listener: (s: HealthResult) => void): void {
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
          `[laya-mcp] laya-server ${tag}${next.error ? `: ${next.error}` : ""}`,
        );
        for (const fn of this.listeners) fn(next);
      }
    } catch (err) {
      this.status = { ready: false, error: (err as Error).message };
    }
  }
}
