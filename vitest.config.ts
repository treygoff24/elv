import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many tests spawn the real CLI or local HTTP servers; the 5s default
    // flakes under loaded runners (CI, parallel local suites). Assertions are
    // the real guard — the timeout only needs to catch true hangs.
    testTimeout: 20_000,
  },
});
