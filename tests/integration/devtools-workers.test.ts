import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_WORKERS,
  MAX_WORKERS_ENV,
  resolveMaxWorkers,
} from "../../scripts/vitest-workers";

// The worker ceiling exists so a test run on the shared devbox cannot claim all
// 24 cores. Two mistakes would silently give the cores back: a typo'd override
// falling through to "unbounded", and an override larger than the machine.

describe("resolveMaxWorkers", () => {
  it("defaults to the conservative ceiling when no override is set", () => {
    expect(resolveMaxWorkers(undefined, 24)).toBe(DEFAULT_MAX_WORKERS);
    expect(resolveMaxWorkers("", 24)).toBe(DEFAULT_MAX_WORKERS);
    expect(resolveMaxWorkers("   ", 24)).toBe(DEFAULT_MAX_WORKERS);
  });

  it("honours a valid override", () => {
    expect(resolveMaxWorkers("1", 24)).toBe(1);
    expect(resolveMaxWorkers("8", 24)).toBe(8);
    expect(resolveMaxWorkers(" 6 ", 24)).toBe(6);
  });

  it("caps the default and any override at actual parallelism", () => {
    expect(resolveMaxWorkers(undefined, 1)).toBe(1);
    expect(resolveMaxWorkers("64", 4)).toBe(4);
    // availableParallelism() can report 0 on constrained containers.
    expect(resolveMaxWorkers("4", 0)).toBe(1);
    expect(resolveMaxWorkers(undefined, 0)).toBe(1);
  });

  it("rejects an override that is not a positive integer", () => {
    for (const bad of ["0", "-2", "2.5", "two", "4x", "1e3", "Infinity", "NaN"]) {
      expect(() => resolveMaxWorkers(bad, 24), `expected ${bad} to be rejected`).toThrow(
        MAX_WORKERS_ENV,
      );
    }
  });
});
