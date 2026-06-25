import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compileSpec } from "./compile-spec";
import {
  rawSpecCachePath,
  vendoredSpecPath,
  writeRegistryCache,
} from "./registry";
import { failure, success } from "../core/envelope";
import { ExitCode } from "../core/types";
import type { RegistryOptions } from "./registry";
import type { Envelope } from "../core/types";

const LIVE_SPEC_URL = "https://api.elevenlabs.io/openapi.json";

export interface LoadSpecOptions extends RegistryOptions {
  offline?: boolean;
}

export interface UpdateSpecOptions extends RegistryOptions {
  from?: string;
  offline?: boolean;
  cmd?: string;
}

export async function loadSpecDocument(options: LoadSpecOptions = {}): Promise<unknown> {
  const cached = rawSpecCachePath(options);
  if (!options.offline) {
    try {
      return JSON.parse(readFileSync(cached, "utf8")) as unknown;
    } catch {
      // fall through to vendored snapshot
    }
  }
  return JSON.parse(readFileSync(vendoredSpecPath(), "utf8")) as unknown;
}

export async function updateSpecCache(
  options: UpdateSpecOptions = {},
): Promise<{ env: Envelope; exitCode: ExitCode }> {
  const cmd = options.cmd ?? "elv spec update";
  try {
    const document = await documentForUpdate(options);
    const specPath = rawSpecCachePath(options);
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, `${JSON.stringify(document)}\n`);

    const compiled = await compileSpec({ document });
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
    return {
      env: failure({
        cmd,
        error: {
          type: "provider_error",
          code: "spec_update_failed",
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

async function documentForUpdate(options: UpdateSpecOptions): Promise<unknown> {
  if (options.offline) return JSON.parse(readFileSync(vendoredSpecPath(), "utf8")) as unknown;
  if (!options.from) return fetchSpec(LIVE_SPEC_URL);
  if (/^https?:\/\//iu.test(options.from)) return fetchSpec(options.from);
  return JSON.parse(readFileSync(resolve(options.from), "utf8")) as unknown;
}

async function fetchSpec(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch OpenAPI spec: HTTP ${response.status}`);
  return response.json();
}
