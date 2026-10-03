type Entry<T> = { settle: (value: T) => void; timer?: NodeJS.Timeout };

export type PendingOptions = { clearAndUnref: boolean };

export class PendingDecisions<T> {
  private entries = new Map<string, Entry<T>>();

  constructor(private options: PendingOptions) {}

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  set(id: string, settle: (value: T) => void, timer?: NodeJS.Timeout): void {
    this.entries.set(id, { settle, timer });
  }

  wait(
    id: string,
    ttlMs: number,
    fallback: T,
    onTimeout: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.entries.delete(id)) return;
        onTimeout();
        resolve(fallback);
      }, ttlMs);
      if (this.options.clearAndUnref) timer.unref?.();
      this.set(id, resolve, timer);
    });
  }

  take(id: string): ((value: T) => void) | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (this.options.clearAndUnref) clearTimeout(entry.timer);
    this.entries.delete(id);
    return entry.settle;
  }

  settleAll(value: T): void {
    for (const entry of this.entries.values()) {
      if (this.options.clearAndUnref) clearTimeout(entry.timer);
      entry.settle(value);
    }
    this.entries.clear();
  }
}
