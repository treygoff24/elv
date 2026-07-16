import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSpecDiff, handleSpecStatus, handleSpecUpdate } from "../../src/commands/spec";
import { diffSpec, updateSpecCache } from "../../src/openapi/fetch-spec";
import { rawSpecCachePath, registryCachePath } from "../../src/openapi/registry";

let cacheDir: string;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe("spec update", () => {
  it("recompiles from the vendored snapshot into one authoritative cache", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));

    const result = await updateSpecCache({ offline: true, cacheDir });
    const cache = JSON.parse(readFileSync(result.cachePath, "utf8")) as {
      schema: string;
      operations: unknown[];
      provenance: { sha256: string; schemas: number };
    };

    expect(result.operations).toBe(338);
    expect(result.totalOperations).toBe(339);
    expect(result.skippedOperations).toBe(1);
    expect(cache.schema).toBe("elv.openapi.cache.v2");
    expect(cache.operations).toHaveLength(338);
    expect(cache.provenance).toMatchObject({
      sha256: "de0476611805f3ee4e6a6c76dcdd6cc9686b8daee5757e6465d2974094c844ce",
      schemas: 1345,
    });
    expect(existsSync(rawSpecCachePath({ cacheDir }))).toBe(false);
  });

  it("updates from a local spec file", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));

    const result = await handleSpecUpdate({ from: "fixtures/fake-openapi.json", cacheDir });

    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);
    if (!result.env.ok) throw new Error("expected success");
    expect((result.env.data as Record<string, unknown>).operations).toBe(4);
  });

  it("honors ELV_SPEC_URL when --from is absent", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const source = readFileSync("fixtures/fake-openapi.json", "utf8");
    const fetchMock = vi.fn().mockResolvedValue(new Response(source));
    vi.stubEnv("ELV_SPEC_URL", "https://spec.example.test/custom.json");
    vi.stubGlobal("fetch", fetchMock);

    const result = await updateSpecCache({ cacheDir, dryRun: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://spec.example.test/custom.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.provenance.source).toBe("https://spec.example.test/custom.json");
  });

  it("returns provider errors for failed remote fetches", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("missing", { status: 503 })));

    const result = await handleSpecUpdate({ from: "https://example.test/openapi.json", cacheDir });

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected failure");
    expect(result.env.error).toMatchObject({ type: "provider_error", code: "spec_fetch_failed" });
  });

  it("rejects oversized remote specs before reading the body", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { headers: { "content-length": "20000001" } })),
    );

    const result = await handleSpecUpdate({ from: "https://example.test/openapi.json", cacheDir });

    expect(result.exitCode).toBe(8);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected failure");
    expect(result.env.error.message).toContain("download limit");
  });

  it("returns validation errors for malformed local specs", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const specPath = join(cacheDir, "bad.json");
    writeFileSync(specPath, "{broken");

    const result = await handleSpecUpdate({ from: specPath, cacheDir });

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
    if (result.env.ok) throw new Error("expected failure");
    expect(result.env.error).toMatchObject({ type: "validation_error", code: "validation_error" });
    expect(result.env.error.message).toContain(specPath);
  });

  it("rejects mutually exclusive source options", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));

    const result = await handleSpecUpdate({
      from: "fixtures/fake-openapi.json",
      offline: true,
      cacheDir,
    });

    expect(result.exitCode).toBe(2);
    expect(result.env.ok).toBe(false);
  });

  it("does not write a cache during diff or dry-run", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const cachePath = registryCachePath({ cacheDir });

    const dryRun = await updateSpecCache({ offline: true, dryRun: true, cacheDir });
    const diff = await handleSpecDiff({ offline: true, cacheDir });
    const dryRunCommand = await handleSpecUpdate({ offline: true, dryRun: true, cacheDir });

    expect(dryRun.written).toBe(false);
    expect(diff.exitCode).toBe(0);
    expect(dryRunCommand.exitCode).toBe(0);
    if (!diff.env.ok || !dryRunCommand.env.ok) throw new Error("expected success");
    expect(dryRunCommand.env.data).toEqual(diff.env.data);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("preserves the good cache when candidate parsing fails", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const good = await updateSpecCache({ offline: true, cacheDir });
    const before = readFileSync(good.cachePath, "utf8");
    const badPath = join(cacheDir, "bad.json");
    writeFileSync(badPath, "{broken");

    await expect(updateSpecCache({ from: badPath, cacheDir })).rejects.toThrow();

    expect(readFileSync(good.cachePath, "utf8")).toBe(before);
  });

  it("preserves the good cache when interrupted before atomic rename", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const good = await updateSpecCache({ offline: true, cacheDir });
    const before = readFileSync(good.cachePath, "utf8");

    await expect(
      updateSpecCache({
        from: "fixtures/fake-openapi.json",
        cacheDir,
        beforeCacheRename: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).rejects.toThrow("simulated interruption");

    expect(readFileSync(good.cachePath, "utf8")).toBe(before);
  });

  it("reports stable operation, deprecation, and schema diffs", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    await updateSpecCache({ from: "fixtures/fake-openapi.json", cacheDir });
    const candidate = JSON.parse(readFileSync("fixtures/fake-openapi.json", "utf8")) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      components: { schemas: Record<string, unknown> };
    };
    candidate.paths["/v1/voices"]!.get!.deprecated = true;
    candidate.paths["/v1/z"] = { get: operation("z_new") };
    candidate.paths["/v1/a"] = { get: operation("a_new") };
    candidate.components.schemas.Zed = { type: "string" };
    candidate.components.schemas.Alpha = { type: "string" };
    candidate.components.schemas.Voice = { type: "object", description: "changed" };
    const candidatePath = join(cacheDir, "candidate.json");
    writeFileSync(candidatePath, JSON.stringify(candidate));

    const result = await diffSpec({ from: candidatePath, cacheDir });

    expect(result.diff.added_operations).toEqual(["a_new", "z_new"]);
    expect(result.diff.newly_deprecated_operations).toEqual(["list_voices"]);
    expect(result.diff.added_schemas).toEqual(["Alpha", "Zed"]);
    expect(result.diff.changed_schemas).toBe(1);
    expect(result.written).toBe(false);
  });

  it("reports vendored and active provenance offline", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    await updateSpecCache({ offline: true, cacheDir });

    const result = await handleSpecStatus({ cacheDir });

    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);
    if (!result.env.ok) throw new Error("expected success");
    expect(result.env.data).toMatchObject({
      active: { present: true },
      active_differs_from_vendored: false,
    });
  });

  it("reports unknown provenance for a legacy cache envelope", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-update-"));
    const updated = await updateSpecCache({ from: "fixtures/fake-openapi.json", cacheDir });
    const legacy = JSON.parse(readFileSync(updated.cachePath, "utf8")) as {
      schema?: string;
      provenance?: unknown;
    };
    delete legacy.schema;
    delete legacy.provenance;
    writeFileSync(updated.cachePath, JSON.stringify(legacy));

    const result = await handleSpecStatus({ cacheDir });

    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);
    if (!result.env.ok) throw new Error("expected success");
    expect(result.env.data).toMatchObject({
      active: { present: true, provenance: "unknown" },
      active_differs_from_vendored: null,
    });
  });
});

function operation(operationId: string): Record<string, unknown> {
  return { operationId, responses: { "200": { description: "ok" } } };
}
