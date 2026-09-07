// Worker ceiling for the vitest pool.
//
// The devbox is a shared 24-core machine with no cgroup CPU quota, so an
// unbounded pool lets one test run claim every core from whatever else is
// running. The ceiling buys a predictable resource budget; measurements below
// explain the default.
//
// Override per run with ELV_TEST_MAX_WORKERS=<n>. A value above the machine's
// actual parallelism is capped rather than honoured, and anything that is not a
// positive integer is a hard error — a silently ignored typo would quietly
// restore the unbounded behaviour this exists to prevent.

export const MAX_WORKERS_ENV = "ELV_TEST_MAX_WORKERS";

// Measured on the devbox (24 cores, Node 26.5.0) before this default was set.
// tests/core, 3 runs each: 2 workers 6.80/6.82/7.26 s, 4 workers 6.65/6.83/6.90 s.
// tests/commands, 2 runs each: 2 workers 20.7/21.2 s, 4 workers 20.5/23.8 s.
// The suite is bound by child-process latency inside each file rather than by
// worker count, so 4 buys no wall-clock and 2 halves the footprint.
export const DEFAULT_MAX_WORKERS = 2;

export function resolveMaxWorkers(raw: string | undefined, available: number): number {
  const ceiling = Math.max(1, Math.floor(available));
  const requested = raw?.trim();
  if (!requested) return Math.min(DEFAULT_MAX_WORKERS, ceiling);

  // Plain decimal digits only. Number() would happily accept "1e3" and "0x10",
  // which are far more likely to be a typo than an intent.
  const parsed = /^[0-9]+$/.test(requested) ? Number(requested) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `${MAX_WORKERS_ENV} must be a positive integer, got ${JSON.stringify(raw)}. ` +
        `Unset it to use the default of ${DEFAULT_MAX_WORKERS}.`,
    );
  }
  return Math.min(parsed, ceiling);
}
