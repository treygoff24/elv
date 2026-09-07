import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { loadRegistrySnapshot } from "../../src/openapi/registry";
import { waitForOperation } from "../../src/core/wait-operation";

it("cancels an unresponsive first HTTP poll while the caller process stays alive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elv-wait-http-"));
  const config = join(dir, "config.json");
  writeFileSync(config, "{}");
  vi.stubEnv("ELV_CONFIG", config);
  vi.stubEnv("ELV_CACHE_DIR", dir);
  vi.stubEnv("ELEVENLABS_API_KEY", "fixture-only");
  let requests = 0;
  let cancelled = false;
  const server = createServer((_req, res) => {
    requests += 1;
    // Finite fallback solely for a failing regression. No headers/body are sent.
    const fallback = setTimeout(() => res.destroy(), 5000);
    res.on("close", () => {
      clearTimeout(fallback);
      cancelled = true;
    });
  });
  try {
    await loadRegistrySnapshot();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing fixture address");
    const result = await waitForOperation({
      operation: "get_voices",
      baseUrl: `http://127.0.0.1:${address.port}`,
      statusPath: "data.status",
      success: "done",
      timeoutMs: 300,
    });
    expect(result.env).toMatchObject({
      ok: false,
      error: { code: "wait_timeout", raw: { status: null } },
    });
    expect(requests).toBe(1);
    const deadline = Date.now() + 500;
    while (!cancelled && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    // Before server cleanup or process exit: the AbortSignal must close this request.
    expect(cancelled).toBe(true);
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
