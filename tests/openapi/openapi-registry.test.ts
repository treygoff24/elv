import { createHash } from "node:crypto";
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
import { compilerSemanticsInputs, curationInputs } from "../../src/openapi/compile-spec";

const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
  .version;

let cacheDir: string;

function registryFingerprintWithCompiler(
  sourceSha256: string,
  sourceSelector: string,
  compiler: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        source_sha256: sourceSha256,
        source_selector: sourceSelector,
        curation: curationInputs(),
        compiler,
      }),
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
    expect(cached.version).toBe(packageVersion);
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
    await loadRegistry({ cacheDir });
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, unknown>;
    cache.version = "stale";
    cache.operations = [{ operationId: "wrong" }];
    writeFileSync(cachePath, JSON.stringify(cache));

    const registry = await loadRegistry({ cacheDir });

    expect(registry.has("wrong")).toBe(false);
    expect(registry.has("text_to_speech_full")).toBe(true);
  });

  it("recompiles when curation changes without a schema or package version change", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const cachePath = registryCachePath({ cacheDir });
    await loadRegistry({ cacheDir });
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      schema: string;
      version: string;
      fingerprint: string;
      operations: { operationId: string; risk?: string }[];
    };
    const rag = cache.operations.find(
      (operation) => operation.operationId === "query_agent_knowledge_base_rag_route",
    );
    if (!rag) throw new Error("expected RAG operation in compiled cache");
    rag.risk = "mutate";
    cache.fingerprint = "stale-curation-fingerprint";
    writeFileSync(cachePath, JSON.stringify(cache));

    expect(cache.schema).toBe("elv.openapi.cache.v3");
    expect(cache.version).toBe(packageVersion);
    const registry = await loadRegistry({ cacheDir });

    expect(registry.get("query_agent_knowledge_base_rag_route")?.risk).toBe("read");
    expect(JSON.parse(readFileSync(cachePath, "utf8")).fingerprint).not.toBe(
      "stale-curation-fingerprint",
    );
  });

  it("recompiles when the serialized risk classifier changes", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const options = { cacheDir, specPath: "fixtures/fake-openapi.json" };
    const cachePath = registryCachePath(options);
    await loadRegistry(options);
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      fingerprint: string;
      sourceSelector: string;
      provenance: { sha256: string };
      operations: { operationId: string; risk?: string }[];
    };
    const item = cache.operations.find((operation) => operation.operationId === "create_item");
    if (!item) throw new Error("expected create_item in compiled cache");
    item.risk = "destructive";
    const compiler = compilerSemanticsInputs() as { risk: Record<string, string> };
    expect(compiler.risk.classifyRisk).toEqual(expect.any(String));
    compiler.risk.classifyRisk = `${compiler.risk.classifyRisk}\n// previous classifier`;
    cache.fingerprint = registryFingerprintWithCompiler(
      cache.provenance.sha256,
      cache.sourceSelector,
      compiler,
    );
    writeFileSync(cachePath, JSON.stringify(cache));

    expect(readRegistryCache(options)).toBeNull();
    const registry = await loadRegistry(options);

    expect(registry.get("create_item")?.risk).toBe("mutate");
  });

  it("recompiles when an explicit spec path differs from the cached source", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const sourceA = join(cacheDir, "source-a.json");
    const sourceB = join(cacheDir, "source-b.json");
    writeFileSync(sourceA, readFileSync("fixtures/fake-openapi.json"));
    writeFileSync(
      sourceB,
      readFileSync("fixtures/fake-openapi.json", "utf8").replace(
        '"list_voices"',
        '"list_voices_from_b"',
      ),
    );

    const fromA = await loadRegistry({ cacheDir, specPath: sourceA });
    const fromB = await loadRegistry({ cacheDir, specPath: sourceB });

    expect(fromA.has("list_voices")).toBe(true);
    expect(fromB.has("list_voices")).toBe(false);
    expect(fromB.has("list_voices_from_b")).toBe(true);
  });

  it("rejects fingerprint-valid caches with malformed provenance counts", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const options = { cacheDir, specPath: "fixtures/fake-openapi.json" };
    const cachePath = registryCachePath(options);
    await loadRegistry(options);
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as {
      provenance: { paths: unknown };
    };
    cache.provenance.paths = "corrupt";
    writeFileSync(cachePath, JSON.stringify(cache));

    expect(readRegistryCache(options)).toBeNull();
    await loadRegistry(options);

    expect(typeof readRegistryCache(options)?.provenance?.paths).toBe("number");
  });

  it("recompiles instead of crashing on malformed cache JSON", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-cache-"));
    const cachePath = registryCachePath({ cacheDir });
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, "{broken");

    const registry = await loadRegistry({ cacheDir });

    expect(registry.has("text_to_speech_full")).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({ version: packageVersion });
  });
});
