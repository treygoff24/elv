import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { failure, success } from "../core/envelope";
import { emitAndExit, validationError } from "../core/errors";
import { SMALL_JSON_LIMIT, summarizeData } from "../core/response-normalizer";
import { ExitCode } from "../core/types";
import type { Envelope, Hint } from "../core/types";
import { readPath } from "../util/jsonpath";
import { shellArg } from "../util/shell";

export interface ViewOptions {
  path?: string;
  limit?: string | number;
}

export async function handleView(path: string, options: ViewOptions = {}): Promise<never> {
  const { env, exitCode } = buildViewResult(path, options);
  emitAndExit(env, exitCode);
}

export function buildViewResult(
  path: string,
  options: ViewOptions = {},
): { env: Envelope; exitCode: ExitCode } {
  const cmd = `elv view ${path}`;
  const resolved = resolve(path);

  let parsed: unknown;
  try {
    const text = readFileSync(resolved, "utf8");
    parsed = parseFileContent(text, resolved);
  } catch (error) {
    if (isNodeError(error) && NOT_FOUND_FS_CODES.has(error.code ?? "")) {
      return {
        env: failure({
          cmd,
          error: { type: "not_found_error", code: "not_found", message: `File not found: ${resolved}` },
          retry: { recommended: false, after_ms: null },
          hints: [{ cmd: "elv <prior-cmd>", why: "Check files[].path from the prior command's envelope." }],
        }),
        exitCode: ExitCode.NotFound,
      };
    }
    const message =
      error instanceof SyntaxError
        ? `File is not valid JSON: ${resolved}. Use cat to inspect raw contents.`
        : error instanceof Error
          ? error.message
          : String(error);
    return { env: validationError(cmd, message), exitCode: ExitCode.InputValidation };
  }

  let value = parsed;
  if (options.path) {
    try {
      value = readPath(parsed, options.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { env: validationError(cmd, message), exitCode: ExitCode.InputValidation };
    }
    if (value === undefined) {
      return {
        env: validationError(cmd, `path "${options.path}" not found in ${resolved}`),
        exitCode: ExitCode.InputValidation,
      };
    }
  }

  const limit = parseLimit(options.limit);
  if (limit === null) {
    return {
      env: validationError(cmd, "--limit must be a positive integer"),
      exitCode: ExitCode.InputValidation,
    };
  }

  let truncated = false;
  if (Array.isArray(value) && limit !== undefined) {
    if (value.length > limit) truncated = true;
    value = value.slice(0, limit);
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) < SMALL_JSON_LIMIT) {
    return {
      env: success({
        cmd,
        data: value,
        ...(truncated ? { truncated: true } : {}),
      }),
      exitCode: ExitCode.Success,
    };
  }

  return {
    env: success({
      cmd,
      data_summary: summarizeData(value),
      truncated: true,
      hints: [narrowHint(resolved, value, options.path)],
    }),
    exitCode: ExitCode.Success,
  };
}

// Filesystem errors that mean "no readable file at this path" — mapped to exit 9
// (not_found) rather than letting a raw ENOTDIR/ELOOP surface as a provider error.
const NOT_FOUND_FS_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseFileContent(text: string, filePath: string): unknown {
  if (filePath.endsWith(".ndjson")) {
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as unknown);
  }
  return JSON.parse(text) as unknown;
}

function parseLimit(value: string | number | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function narrowHint(filePath: string, value: unknown, jsonPath?: string): Hint {
  if (Array.isArray(value)) {
    // Drilling into the first element always shrinks the payload, so the hint converges;
    // suggesting `--limit` here would loop when individual items are themselves large.
    const nextPath = jsonPath ? `${jsonPath}.0` : "0";
    return {
      cmd: `elv view ${shellArg(filePath)} --path ${shellArg(nextPath)}`,
      why: "Inspect the first array item.",
    };
  }
  if (isRecord(value)) {
    const key = Object.keys(value)[0];
    if (key) {
      const nextPath = jsonPath ? `${jsonPath}.${key}` : key;
      return {
        cmd: `elv view ${shellArg(filePath)} --path ${shellArg(nextPath)}`,
        why: "Drill into a nested field.",
      };
    }
  }
  return {
    cmd: `elv view ${shellArg(filePath)}`,
    why: "Inspect spilled JSON without loading it into context.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
