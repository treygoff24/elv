import { failure, success } from "../core/envelope";
import { ExitCode } from "../core/types";
import { SpecInputError, SpecProviderError, updateSpecCache } from "../openapi/fetch-spec";
import type { Envelope } from "../core/types";
import type { UpdateSpecOptions } from "../openapi/fetch-spec";

interface SpecUpdateOptions extends UpdateSpecOptions {
  cmd?: string;
}

export async function handleSpecUpdate(
  options: SpecUpdateOptions = {},
): Promise<{ env: Envelope; exitCode: ExitCode }> {
  const cmd = options.cmd ?? "elv spec update";
  try {
    const result = await updateSpecCache(options);
    return {
      env: success({
        cmd,
        data: {
          operations: result.operations,
          total_operations: result.totalOperations,
          skipped_operations: result.skippedOperations,
          cache_path: result.cachePath,
          spec_cache_path: result.specCachePath,
        },
      }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    return specUpdateFailure(cmd, error);
  }
}

function specUpdateFailure(cmd: string, error: unknown): { env: Envelope; exitCode: ExitCode } {
  if (error instanceof SpecInputError) return specInputFailure(cmd, error);
  return specProviderFailure(cmd, error);
}

function specInputFailure(
  cmd: string,
  error: SpecInputError,
): { env: Envelope; exitCode: ExitCode } {
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

function specProviderFailure(cmd: string, error: unknown): { env: Envelope; exitCode: ExitCode } {
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
