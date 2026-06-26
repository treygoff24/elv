import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRegistry, registryCachePath } from "../../src/openapi/registry";

let cacheDir: string;

afterEach(() => {
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe("OpenAPI registry cache", () => {
  it("cold-starts from the vendored snapshot and writes a version-stamped cache", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const registry = await loadRegistry({ cacheDir });
    const cachePath = registryCachePath({ cacheDir });
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      version: string;
      operations: unknown[];
      bundledSpec: unknown;
    };

    expect(registry.size).toBe(319);
    expect(registry.get("text_to_speech_full")?.risk).toBe("generate");
    expect(existsSync(cachePath)).toBe(true);
    expect(cached.version).toBe("0.1.0");
    expect(cached.operations).toHaveLength(319);
    expect(() => JSON.stringify(cached.bundledSpec)).not.toThrow();
  });

  it("recompiles instead of using a stale version cache", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const cachePath = registryCachePath({ cacheDir });
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ version: "stale", operations: [{ operationId: "wrong" }] }),
    );

    const registry = await loadRegistry({ cacheDir });

    expect(registry.has("wrong")).toBe(false);
    expect(registry.has("text_to_speech_full")).toBe(true);
  });

  it("recompiles instead of crashing on malformed cache JSON", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const cachePath = registryCachePath({ cacheDir });
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{broken");

    const registry = await loadRegistry({ cacheDir });

    expect(registry.has("text_to_speech_full")).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({ version: "0.1.0" });
  });
});
