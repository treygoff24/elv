import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileSpec } from "./compile-spec";
import { rawSpecCachePath, vendoredSpecPath, writeRegistryCache } from "./registry";
import { parseJson } from "../util/json";
import type { RegistryOptions } from "./registry";

const LIVE_SPEC_URL = "https://api.elevenlabs.io/openapi.json";

export interface UpdateSpecOptions extends RegistryOptions {
  from?: string;
  offline?: boolean;
}

interface SpecUpdateResult {
  operations: number;
  totalOperations: number;
  skippedOperations: number;
  cachePath: string;
  specCachePath: string;
}

interface SpecDocument {
  document: unknown;
  source: "offline" | "file" | "url";
  label: string;
}

export class SpecInputError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "SpecInputError";
  }
}

export class SpecProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecProviderError";
  }
}

export async function updateSpecCache(options: UpdateSpecOptions = {}): Promise<SpecUpdateResult> {
  const { document, source, label } = await documentForUpdate(options);
  const specPath = rawSpecCachePath(options);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, `${JSON.stringify(document)}\n`);

  let compiled: Awaited<ReturnType<typeof compileSpec>>;
  try {
    compiled = await compileSpec({ document });
  } catch (error) {
    if (source !== "url")
      throw new SpecInputError(
        `Invalid OpenAPI spec from ${label}: ${error instanceof Error ? error.message : String(error)}`,
        { source: label },
      );
    throw error;
  }
  const cachePath = writeRegistryCache(compiled, options);
  return {
    operations: compiled.operations.length,
    totalOperations: compiled.totalOperations,
    skippedOperations: compiled.skippedOperations,
    cachePath,
    specCachePath: specPath,
  };
}

async function documentForUpdate(options: UpdateSpecOptions): Promise<SpecDocument> {
  if (options.offline) {
    const path = vendoredSpecPath();
    return { document: readSpecJson(path), source: "offline", label: path };
  }
  if (!options.from)
    return { document: await fetchSpec(LIVE_SPEC_URL), source: "url", label: LIVE_SPEC_URL };
  if (/^https?:\/\//iu.test(options.from))
    return { document: await fetchSpec(options.from), source: "url", label: options.from };
  const path = resolve(options.from);
  return { document: readSpecJson(path), source: "file", label: path };
}

function readSpecJson(path: string): unknown {
  try {
    return parseJson(readFileSync(path, "utf8"), path);
  } catch (error) {
    throw new SpecInputError(
      `Invalid JSON in OpenAPI spec ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { path },
    );
  }
}

async function fetchSpec(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok)
    throw new SpecProviderError(`Failed to fetch OpenAPI spec: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new SpecProviderError(
      `Failed to parse fetched OpenAPI spec from ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
