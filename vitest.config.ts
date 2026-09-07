import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { MAX_WORKERS_ENV, resolveMaxWorkers } from "./scripts/vitest-workers";

const maxWorkers = resolveMaxWorkers(process.env[MAX_WORKERS_ENV], availableParallelism());

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Many tests spawn the real CLI or local HTTP servers; the 5s default
    // flakes under loaded runners (CI, parallel local suites). Assertions are
    // the real guard — the timeout only needs to catch true hangs.
    testTimeout: 20_000,
    // Shared-machine courtesy, not a speed setting. scripts/vitest-workers.ts
    // owns the value and the ELV_TEST_MAX_WORKERS override.
    maxWorkers,
    minWorkers: 1,
  },
});
