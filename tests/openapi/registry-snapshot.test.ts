import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";
import { handleCapabilities } from "../../src/commands/capabilities";
import { handleOpsSchema } from "../../src/commands/ops";
import { runOperation } from "../../src/core/client";
import * as registry from "../../src/openapi/registry";

// Reading the compiled cache costs a ~3 MB parse plus a source fingerprint. Commands
// that need both the operation map and the bundled spec used to pay for it twice, once
// through loadRegistry and again through readRegistryCache. These cases pin the single
// read: a command that reaches for readRegistryCache after the snapshot is a regression.

let warmCacheDir: string;
const previousCacheDir = process.env.ELV_CACHE_DIR;
const temporaryDirs: string[] = [];

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  warmCacheDir = temporaryDir("elv-snapshot-warm-");
  process.env.ELV_CACHE_DIR = warmCacheDir;
  // Every command case below must read a compiled cache, not compile one itself.
  await registry.loadRegistry();
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (previousCacheDir === undefined) delete process.env.ELV_CACHE_DIR;
  else process.env.ELV_CACHE_DIR = previousCacheDir;
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("registry snapshot", () => {
  it("returns the operation map and the compiled cache together", async () => {
    const snapshot = await registry.loadRegistrySnapshot();

    expect(snapshot.operations.get("text_to_speech_full")?.risk).toBe("generate");
    expect(snapshot.cache?.schema).toBe("elv.openapi.cache.v3");
    expect(snapshot.cache?.bundledSpec?.components?.schemas).toBeDefined();
    expect(snapshot.cache?.provenance.callable_operations).toBe(snapshot.operations.size);
  });

  it("hands back the cache it just wrote on a cold start", async () => {
    const cacheDir = temporaryDir("elv-snapshot-cold-");
    const options = { cacheDir, specPath: "fixtures/fake-openapi.json" };

    const snapshot = await registry.loadRegistrySnapshot(options);
    const fromDisk = registry.readRegistryCache(options);

    expect(snapshot.operations.size).toBe(4);
    expect(snapshot.cache).not.toBeNull();
    expect(fromDisk).not.toBeNull();
    expect(snapshot.cache).toMatchObject({
      schema: fromDisk!.schema,
      version: fromDisk!.version,
      fingerprint: fromDisk!.fingerprint,
      sourceSelector: fromDisk!.sourceSelector,
      generated_at: fromDisk!.generated_at,
      provenance: fromDisk!.provenance,
    });
  });

  it.each([false, true])("recompiles changed source (forced=%s)", async (forceRecompile) => {
    const cacheDir = temporaryDir("elv-snapshot-force-");
    const specPath = join(cacheDir, "source.json");
    const spec = JSON.parse(readFileSync("fixtures/fake-openapi.json", "utf8"));
    writeFileSync(specPath, JSON.stringify(spec));
    const first = await registry.loadRegistrySnapshot({ cacheDir, specPath });
    const operation = Object.values(spec.paths)[0] as { get: { operationId: string } };
    operation.get.operationId = "changed_operation";
    writeFileSync(specPath, JSON.stringify(spec));
    const changed = await registry.loadRegistrySnapshot({ cacheDir, specPath, forceRecompile });
    expect(changed.cache?.fingerprint).not.toBe(first.cache?.fingerprint);
    expect(changed.operations.has("changed_operation")).toBe(true);
  });

  it("raw HTTP reuses the schema snapshot", async () => {
    const readCache = vi.spyOn(registry, "readRegistryCache");
    const snapshot = vi.spyOn(registry, "loadRegistrySnapshot");
    const env = await runHttp("GET", "/v1/voices", { dryRun: true });
    expect(env.ok).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(readCache).not.toHaveBeenCalled();
  });

  it("serves ops schema without a second registry read", async () => {
    const readCache = vi.spyOn(registry, "readRegistryCache");

    const result = await handleOpsSchema("text_to_speech_full");

    expect(result.exitCode).toBe(0);
    expect(readCache).not.toHaveBeenCalled();
  });

  it("serves capabilities without a second registry read", async () => {
    const readCache = vi.spyOn(registry, "readRegistryCache");

    const result = await handleCapabilities({ version: "9.8.7" });

    expect(result.exitCode).toBe(0);
    expect(readCache).not.toHaveBeenCalled();
  });

  it("resolves a call operation without a second registry read", async () => {
    const readCache = vi.spyOn(registry, "readRegistryCache");

    const env = await runOperation("definitely_not_an_operation", {});

    expect(env.ok).toBe(false);
    expect(readCache).not.toHaveBeenCalled();
  });
});
