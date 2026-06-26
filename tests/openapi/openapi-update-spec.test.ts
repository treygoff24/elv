import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSpecCache } from "../../src/openapi/fetch-spec";

let cacheDir: string;

afterEach(() => {
  vi.unstubAllGlobals();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe("spec update", () => {
  it("recompiles from the vendored snapshot offline", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));

    const result = await updateSpecCache({ offline: true, cacheDir });

    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);
    if (!result.env.ok) throw new Error("expected success");
    const data = result.env.data as Record<string, unknown>;
    expect(data.operations).toBe(319);
    expect(existsSync(String(data.cache_path))).toBe(true);
    expect(existsSync(String(data.spec_cache_path))).toBe(true);
  });

  it("updates from a local spec file", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));

    const result = await updateSpecCache({ from: "fixtures/fake-openapi.json", cacheDir });

    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);
    if (!result.env.ok) throw new Error("expected success");
    expect((result.env.data as Record<string, unknown>).operations).toBe(4);
  });

  it("returns provider errors for failed remote fetches", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 503 })));

    const result = await updateSpecCache({ from: "https://example.test/openapi.json", cacheDir });

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected failure");
    expect(result.env.error).toMatchObject({ type: "provider_error", code: "spec_fetch_failed" });
  });

  it("returns validation errors for malformed local specs", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const specPath = join(cacheDir, "bad.json");
    writeFileSync(specPath, "{broken");

    const result = await updateSpecCache({ from: specPath, cacheDir });

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected failure");
    expect(result.env.error).toMatchObject({ type: "validation_error", code: "validation_error" });
    expect(result.env.error.message).toContain(specPath);
  });
});
