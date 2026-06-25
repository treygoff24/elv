/**
 * In-process semaphore for future fan-out (--all/wait/multi-file). It does not
 * coordinate across separate elv processes; provider 429s remain the cross-process backstop.
 */
export class AsyncSemaphore {
  #limit: number;
  #active = 0;
  #queue: Array<() => void> = [];
  #drainers: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = Math.max(1, Math.floor(limit));
  }

  setLimit(limit: number): void {
    this.#limit = Math.max(1, Math.floor(limit));
    this.#pump();
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve) => this.#queue.push(resolve));
    return () => this.#release();
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async drain(): Promise<void> {
    if (this.#active === 0) return;
    await new Promise<void>((resolve) => this.#drainers.push(resolve));
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#pump();
    if (this.#active === 0) {
      const drainers = this.#drainers.splice(0);
      for (const resolve of drainers) resolve();
    }
  }

  #pump(): void {
    while (this.#active < this.#limit) {
      const next = this.#queue.shift();
      if (!next) return;
      this.#active += 1;
      next();
    }
  }
}

export const invocationSemaphore = new AsyncSemaphore(4);
