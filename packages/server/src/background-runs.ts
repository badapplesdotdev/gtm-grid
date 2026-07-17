import { randomUUID } from "node:crypto";

export type BackgroundRunStatus = "running" | "succeeded" | "failed";

export interface BackgroundRunSnapshot<T> {
  readonly runId: string;
  readonly status: BackgroundRunStatus;
  readonly createdAt: number;
  readonly finishedAt?: number;
  readonly result?: T;
  readonly error?: string;
}

interface BackgroundRunRecord<T> extends BackgroundRunSnapshot<T> {
  listeners: Set<() => void>;
}

/** In-memory jobs owned by the persistent sidecar, not the disposable MCP child. */
export class BackgroundRunRegistry<T> {
  private readonly runs = new Map<string, BackgroundRunRecord<T>>();

  constructor(
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => number = Date.now,
    private readonly retentionMs = 60 * 60_000,
  ) {}

  start(task: () => Promise<T>): BackgroundRunSnapshot<T> {
    this.prune();
    const runId = this.makeId();
    const record: BackgroundRunRecord<T> = {
      runId,
      status: "running",
      createdAt: this.now(),
      listeners: new Set(),
    };
    this.runs.set(runId, record);
    void Promise.resolve().then(task).then(
      (result) => this.finish(record, { status: "succeeded", result }),
      (error) => this.finish(record, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return this.snapshot(record);
  }

  get(runId: string): BackgroundRunSnapshot<T> | undefined {
    this.prune();
    const record = this.runs.get(runId);
    return record ? this.snapshot(record) : undefined;
  }

  async wait(runId: string, waitMs: number): Promise<BackgroundRunSnapshot<T> | undefined> {
    const record = this.runs.get(runId);
    if (!record || record.status !== "running" || waitMs <= 0) return this.get(runId);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        record.listeners.delete(done);
        resolve();
      }, waitMs);
      const done = () => {
        clearTimeout(timer);
        record.listeners.delete(done);
        resolve();
      };
      record.listeners.add(done);
    });
    return this.get(runId);
  }

  private finish(
    record: BackgroundRunRecord<T>,
    outcome: { status: "succeeded"; result: T } | { status: "failed"; error: string },
  ): void {
    Object.assign(record, outcome, { finishedAt: this.now() });
    for (const listener of record.listeners) listener();
    record.listeners.clear();
  }

  private snapshot(record: BackgroundRunRecord<T>): BackgroundRunSnapshot<T> {
    const { listeners: _listeners, ...snapshot } = record;
    return snapshot;
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, run] of this.runs) {
      if (run.finishedAt !== undefined && run.finishedAt < cutoff) this.runs.delete(id);
    }
  }
}
