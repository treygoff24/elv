import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileSpec } from "./compile-spec";
import { rawSpecCachePath, vendoredSpecPath, writeRegistryCache } from "./registry";
import { failure, success } from "../core/envelope";
import { ExitCode } from "../core/types";
import { parseJson } from "../util/json";
import type { RegistryOptions } from "./registry";
import type { Envelope } from "../core/types";

const LIVE_SPEC_URL = "https://api.elevenlabs.io/openapi.json";

export interface UpdateSpecOptions extends RegistryOptions {
  from?: string;
  offline?: boolean;
  cmd?: string;
}

interface SpecDocument {
  document: unknown;
  source: "offline" | "file" | "url";
  label: string;
}

class SpecInputError extends Error {
  constructor(
    message: string,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "SpecInputError";
  }
}

class SpecProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecProviderError";
  }
}

export async function updateSpecCache(
  options: UpdateSpecOptions = {},
): Promise<{ env: Envelope; exitCode: ExitCode }> {
  const cmd = options.cmd ?? "elv spec update";
  try {
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
      env: success({
        cmd,
        data: {
          operations: compiled.operations.length,
          total_operations: compiled.totalOperations,
          skipped_operations: compiled.skippedOperations,
          cache_path: cachePath,
          spec_cache_path: specPath,
        },
      }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    if (error instanceof SpecInputError) {
      return {
        env: failure({
          cmd,
          error: {
            type: "validation_error",
            code: "validation_error",
            message: error.message,
            raw: error.raw,
          },
          retry: { recommended: false, after_ms: null },
        }),
        exitCode: ExitCode.InputValidation,
      };
    }
    return {
      env: failure({
        cmd,
        error: {
          type: "provider_error",
          code: error instanceof SpecProviderError ? "spec_fetch_failed" : "spec_update_failed",
          message: error instanceof Error ? error.message : String(error),
          raw: error,
        },
        retry: { recommended: false, after_ms: null },
        hints: [{ cmd: "elv spec update --offline", why: "Recompile from the vendored snapshot." }],
      }),
      exitCode: ExitCode.ProviderError,
    };
  }
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
