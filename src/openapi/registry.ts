import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileSpec, curationInputs } from "./compile-spec";
import { parseJson } from "../util/json";
import type { CompileSpecResult, OpenApiDocument } from "./compile-spec";
import type { OperationCard } from "./types";

export interface RegistryOptions {
  cacheDir?: string;
  version?: string;
  forceRecompile?: boolean;
  specPath?: string;
  specDocument?: unknown;
  /** Test seam for proving the authoritative cache survives an interrupted write. */
  beforeCacheRename?: (temporaryPath: string, targetPath: string) => void;
}

export interface SpecCounts {
  paths: number;
  total_operations: number;
  callable_operations: number;
  skipped_operations: number;
  schemas: number;
}

export interface SpecProvenance extends SpecCounts {
  source: string;
  retrieved_at: string;
  sha256: string;
}

export interface RegistryCache {
  schema: "elv.openapi.cache.v3";
  version: string;
  fingerprint: string;
  generated_at: string;
  totalOperations: number;
  skippedOperations: number;
  operations: OperationCard[];
  bundledSpec?: OpenApiDocument;
  provenance?: SpecProvenance;
}

export async function loadRegistry(
  options: RegistryOptions = {},
): Promise<Map<string, OperationCard>> {
  if (!options.forceRecompile) {
    const cached = readRegistryCache(options);
    if (cached) return mapOperations(cached.operations);
  }

  const sourcePath =
    options.specPath ??
    (existsSync(rawSpecCachePath(options)) ? rawSpecCachePath(options) : vendoredSpecPath());
  const sourceText =
    options.specDocument === undefined
      ? readFileSync(sourcePath, "utf8")
      : JSON.stringify(options.specDocument);
  const compiled = await compileSpec(
    options.specDocument === undefined ? { sourcePath } : { document: options.specDocument },
  );
  writeRegistryCache(
    compiled,
    specProvenance(
      compiled,
      sourceText,
      options.specDocument === undefined ? sourcePath : "memory",
    ),
    options,
  );
  return mapOperations(compiled.operations);
}

export function readRegistryCache(options: RegistryOptions = {}): RegistryCache | null {
  const path = registryCachePath(options);
  if (!existsSync(path)) return null;
  let parsed: Partial<RegistryCache>;
  try {
    parsed = parseJson(readFileSync(path, "utf8"), path) as Partial<RegistryCache>;
  } catch {
    return null;
  }
  if (parsed.schema !== "elv.openapi.cache.v3") return null;
  if (parsed.version !== packageVersion(options.version)) return null;
  if (!Array.isArray(parsed.operations)) return null;
  const sourceSha256 = cacheSourceSha256(options, parsed);
  if (!sourceSha256 || parsed.fingerprint !== registryFingerprint(sourceSha256)) return null;
  return parsed as RegistryCache;
}

/** Write the one authoritative cache artifact using a same-directory atomic rename. */
export function writeRegistryCache(
  compiled: CompileSpecResult,
  provenance: SpecProvenance,
  options: RegistryOptions = {},
): string {
  const path = registryCachePath(options);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({
      schema: "elv.openapi.cache.v3",
      version: packageVersion(options.version),
      fingerprint: registryFingerprint(provenance.sha256),
      generated_at: new Date().toISOString(),
      totalOperations: compiled.totalOperations,
      skippedOperations: compiled.skippedOperations,
      operations: compiled.operations,
      bundledSpec: compiled.bundledSpec,
      provenance,
    } satisfies RegistryCache)}\n`,
  );
  options.beforeCacheRename?.(temporaryPath, path);
  renameSync(temporaryPath, path);
  return path;
}

export function specProvenance(
  compiled: CompileSpecResult,
  sourceText: string,
  source: string,
  retrievedAt = new Date().toISOString(),
): SpecProvenance {
  return {
    source,
    retrieved_at: retrievedAt,
    sha256: createHash("sha256").update(sourceText).digest("hex"),
    ...specCounts(compiled),
  };
}

export function specCounts(compiled: CompileSpecResult): SpecCounts {
  return {
    paths: Object.keys(compiled.bundledSpec.paths ?? {}).length,
    total_operations: compiled.totalOperations,
    callable_operations: compiled.operations.length,
    skipped_operations: compiled.skippedOperations,
    schemas: Object.keys(compiled.bundledSpec.components?.schemas ?? {}).length,
  };
}

export function registryCachePath(options: RegistryOptions = {}): string {
  return join(versionedCacheDir(options), "openapi.compact.json");
}

/** Legacy pre-v2 raw cache path, read only for one-time migration. */
export function rawSpecCachePath(options: RegistryOptions = {}): string {
  return join(versionedCacheDir(options), "openapi.raw.json");
}

function versionedCacheDir(options: RegistryOptions = {}): string {
  return join(resolveCacheRoot(options.cacheDir), packageVersion(options.version));
}

function resolveCacheRoot(cacheDir?: string): string {
  return resolve(cacheDir ?? process.env.ELV_CACHE_DIR ?? join(homedir(), ".cache", "elv"));
}

function packageVersion(override?: string): string {
  if (override) return override;
  for (const path of packageJsonCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const json = parseJson(readFileSync(path, "utf8"), path) as { version?: string };
      if (json.version) return json.version;
    } catch {
      continue;
    }
  }
  return "0.0.0";
}

function cacheSourceSha256(options: RegistryOptions, cache: Partial<RegistryCache>): string | null {
  const cachedSourceSha256 = cache.provenance?.sha256;
  if (!cachedSourceSha256) return null;

  if (options.specDocument !== undefined) {
    return cache.provenance?.source === "memory"
      ? hashText(JSON.stringify(options.specDocument))
      : null;
  }
  if (cache.provenance?.source === "memory") return null;

  const sourcePath = registrySourcePath(options);
  if (cache.provenance?.source !== sourcePath) return cachedSourceSha256;
  try {
    return hashText(readFileSync(sourcePath));
  } catch {
    return null;
  }
}

function registrySourcePath(options: RegistryOptions): string {
  return (
    options.specPath ??
    (existsSync(rawSpecCachePath(options)) ? rawSpecCachePath(options) : vendoredSpecPath())
  );
}

function registryFingerprint(sourceSha256: string): string {
  return hashText(
    canonicalJson({
      source_sha256: sourceSha256,
      curation: curationInputs(),
    }),
  );
}

function hashText(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

export function vendoredSpecPath(moduleUrl: string | URL = import.meta.url): string {
  for (const path of vendoredSpecCandidates(moduleUrl)) if (existsSync(path)) return path;
  return resolve("spec/openapi.snapshot.json");
}

export function vendoredSpecMetaPath(moduleUrl: string | URL = import.meta.url): string {
  for (const path of vendoredSpecMetaCandidates(moduleUrl)) if (existsSync(path)) return path;
  return resolve("spec/openapi.snapshot.meta.json");
}

function mapOperations(operations: OperationCard[]): Map<string, OperationCard> {
  return new Map(operations.map((operation) => [operation.operationId, operation]));
}

function packageJsonCandidates(): string[] {
  return packageFileCandidates("package.json");
}

function vendoredSpecCandidates(moduleUrl: string | URL): string[] {
  return packageFileCandidates("spec/openapi.snapshot.json", moduleUrl);
}

function vendoredSpecMetaCandidates(moduleUrl: string | URL): string[] {
  return packageFileCandidates("spec/openapi.snapshot.meta.json", moduleUrl);
}

function packageFileCandidates(path: string, moduleUrl: string | URL = import.meta.url): string[] {
  return [
    fileURLToPath(new URL(`../../${path}`, moduleUrl)),
    fileURLToPath(new URL(`../${path}`, moduleUrl)),
    resolve(path),
  ];
}
