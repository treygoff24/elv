import { failure, success } from "../core/envelope";
import { ExitCode } from "../core/types";
import {
  diffSpec,
  specStatus,
  SpecInputError,
  SpecProviderError,
  updateSpecCache,
} from "../openapi/fetch-spec";
import type { CommandResult } from "../core/types";
import type { SpecUpdateResult, UpdateSpecOptions } from "../openapi/fetch-spec";

interface SpecUpdateOptions extends UpdateSpecOptions {
  cmd?: string;
}

export async function handleSpecUpdate(options: SpecUpdateOptions = {}): Promise<CommandResult> {
  const cmd = options.cmd ?? "elv spec update";
  try {
    const result = await updateSpecCache(options);
    return {
      env: success({ cmd, data: specResultData(result) }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    return specUpdateFailure(cmd, error);
  }
}

export async function handleSpecDiff(options: SpecUpdateOptions = {}): Promise<CommandResult> {
  const cmd = options.cmd ?? "elv spec diff";
  try {
    const result = await diffSpec(options);
    return {
      env: success({ cmd, data: specResultData(result) }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    return specUpdateFailure(cmd, error);
  }
}

function specResultData(result: SpecUpdateResult): Record<string, unknown> {
  return {
    operations: result.operations,
    total_operations: result.totalOperations,
    skipped_operations: result.skippedOperations,
    cache_path: result.cachePath,
    written: result.written,
    provenance: result.provenance,
    diff: result.diff,
  };
}

export async function handleSpecStatus(
  options: Pick<UpdateSpecOptions, "cacheDir" | "version"> & { cmd?: string } = {},
): Promise<CommandResult> {
  const cmd = options.cmd ?? "elv spec status";
  try {
    return {
      env: success({ cmd, data: await specStatus(options) }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    return specUpdateFailure(cmd, error);
  }
}

function specUpdateFailure(cmd: string, error: unknown): CommandResult {
  if (error instanceof SpecInputError) return specInputFailure(cmd, error);
  return specProviderFailure(cmd, error);
}

function specInputFailure(cmd: string, error: SpecInputError): CommandResult {
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

function specProviderFailure(cmd: string, error: unknown): CommandResult {
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
