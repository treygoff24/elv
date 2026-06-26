import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { compileSpec } from "./compile-spec";
import { parseJson } from "../util/json";
import type { CompileSpecResult, OpenApiDocument } from "./compile-spec";
import type { OperationCard } from "./types";

export interface RegistryOptions {
  cacheDir?: string;
  version?: string;
  forceRecompile?: boolean;
  specPath?: string;
  specDocument?: unknown;
}

interface RegistryCache {
  version: string;
  generated_at: string;
  totalOperations: number;
  skippedOperations: number;
  operations: OperationCard[];
  bundledSpec?: OpenApiDocument;
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
  const compiled = await compileSpec(
    options.specDocument === undefined ? { sourcePath } : { document: options.specDocument },
  );
  writeRegistryCache(compiled, options);
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
  if (parsed.version !== packageVersion(options.version)) return null;
  if (!Array.isArray(parsed.operations)) return null;
  return parsed as RegistryCache;
}

export function writeRegistryCache(
  compiled: CompileSpecResult,
  options: RegistryOptions = {},
): string {
  const path = registryCachePath(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      version: packageVersion(options.version),
      generated_at: new Date().toISOString(),
      totalOperations: compiled.totalOperations,
      skippedOperations: compiled.skippedOperations,
      operations: compiled.operations,
      bundledSpec: compiled.bundledSpec,
    })}\n`,
  );
  return path;
}

export function registryCachePath(options: RegistryOptions = {}): string {
  return join(versionedCacheDir(options), "openapi.compact.json");
}

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

export function vendoredSpecPath(): string {
  for (const path of vendoredSpecCandidates()) if (existsSync(path)) return path;
  return resolve("spec/openapi.snapshot.json");
}

function mapOperations(operations: OperationCard[]): Map<string, OperationCard> {
  return new Map(operations.map((operation) => [operation.operationId, operation]));
}

function packageJsonCandidates(): string[] {
  return [
    resolve(new URL("../../package.json", import.meta.url).pathname),
    resolve(new URL("../package.json", import.meta.url).pathname),
    resolve("package.json"),
  ];
}

function vendoredSpecCandidates(): string[] {
  return [
    resolve(new URL("../../spec/openapi.snapshot.json", import.meta.url).pathname),
    resolve(new URL("../spec/openapi.snapshot.json", import.meta.url).pathname),
    resolve("spec/openapi.snapshot.json"),
  ];
}
