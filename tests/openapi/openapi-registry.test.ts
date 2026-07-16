import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadRegistry,
  rawSpecCachePath,
  readRegistryCache,
  registryCachePath,
  vendoredSpecMetaPath,
  vendoredSpecPath,
} from "../../src/openapi/registry";

let cacheDir: string;

afterEach(() => {
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe("OpenAPI registry cache", () => {
  it("loads package-relative snapshots from an encoded install path outside the cwd", () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv package "));
    const packageRoot = join(cacheDir, "node_modules", "eleven-agent-cli");
    const specPath = join(packageRoot, "spec", "openapi.snapshot.json");
    const metaPath = join(packageRoot, "spec", "openapi.snapshot.meta.json");
    const moduleUrl = pathToFileURL(join(packageRoot, "dist", "cli.js"));
    const otherCwd = join(cacheDir, "other-cwd");
    mkdirSync(dirname(specPath), { recursive: true });
    mkdirSync(otherCwd);
    writeFileSync(specPath, '{"openapi":"3.1.0"}');
    writeFileSync(metaPath, '{"sha256":"test"}');

    const originalCwd = process.cwd();
    try {
      process.chdir(otherCwd);
      expect(JSON.parse(readFileSync(vendoredSpecPath(moduleUrl), "utf8"))).toEqual({
        openapi: "3.1.0",
      });
      expect(JSON.parse(readFileSync(vendoredSpecMetaPath(moduleUrl), "utf8"))).toEqual({
        sha256: "test",
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("cold-starts from the vendored snapshot and writes a version-stamped cache", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const registry = await loadRegistry({ cacheDir });
    const cachePath = registryCachePath({ cacheDir });
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
      version: string;
      operations: unknown[];
      bundledSpec: unknown;
    };

    expect(registry.size).toBe(338);
    expect(registry.get("text_to_speech_full")?.risk).toBe("generate");
    expect(existsSync(cachePath)).toBe(true);
    expect(cached.version).toBe("0.1.0");
    expect(cached.operations).toHaveLength(338);
    expect(() => JSON.stringify(cached.bundledSpec)).not.toThrow();
  });

  it("invalidates legacy cache envelopes when compiler metadata changes", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const cachePath = registryCachePath({ cacheDir });
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: "0.1.0",
        generated_at: "2026-01-01T00:00:00Z",
        totalOperations: 1,
        skippedOperations: 0,
        operations: [{ operationId: "legacy" }],
      }),
    );

    const cached = readRegistryCache({ cacheDir });
    const registry = await loadRegistry({ cacheDir });

    expect(cached).toBeNull();
    expect(registry.has("legacy")).toBe(false);
    expect(registry.get("compose_detailed_stream")).toMatchObject({
      streamKind: "sse_events",
      risk: "generate",
      costHint: "per_generation",
    });
  });

  it("migrates the legacy raw spec through the authoritative atomic writer", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const rawPath = rawSpecCachePath({ cacheDir });
    mkdirSync(dirname(rawPath), { recursive: true });
    writeFileSync(rawPath, readFileSync("fixtures/fake-openapi.json"));

    const registry = await loadRegistry({ cacheDir });

    expect(registry.size).toBe(4);
    expect(readRegistryCache({ cacheDir })?.schema).toBe("elv.openapi.cache.v3");
  });

  it("uses the atomic writer on cold start", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    let target = "";

    await expect(
      loadRegistry({
        cacheDir,
        beforeCacheRename: (_temporaryPath, targetPath) => {
          target = targetPath;
          throw new Error("stop before rename");
        },
      }),
    ).rejects.toThrow("stop before rename");

    expect(target).toBe(registryCachePath({ cacheDir }));
    expect(existsSync(target)).toBe(false);
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
