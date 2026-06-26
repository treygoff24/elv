import { readFileSync } from "node:fs";
import { exitCodeForError, validationError } from "../core/errors";
import { runOperation } from "../core/client";
import { ExitCode } from "../core/types";
import { parseJsonRecord } from "../util/json";
import type { AgentInput, Envelope, RunOpts } from "../core/types";
import type { PaginationOptions } from "../core/pagination";
import { addFiles, addPairs } from "./input";
import { paginationOptionsFromOptions, runOptsFromOptions } from "./options";
import type { PaginationOptionValues, RunOptionValues } from "./options";

interface CallOptions
  extends RunOptionValues, PaginationOptionValues, Pick<RunOpts, "allowUnknown" | "unpack"> {
  json?: string;
  jsonFile?: string;
  stdinJson?: boolean;
  query?: string[];
  path?: string[];
  file?: string[];
}

export async function handleCall(
  operationId: string,
  options: CallOptions,
): Promise<{ env: Envelope; exitCode: ExitCode }> {
  const cmd = `elv call ${operationId}`;
  const parsed = parseCallInput(operationId, options);
  if (!parsed.ok) return { env: parsed.env, exitCode: ExitCode.InputValidation };

  let opts: RunOpts & PaginationOptions;
  try {
    opts = callRunOpts(options);
  } catch (error) {
    return {
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
      exitCode: ExitCode.InputValidation,
    };
  }
  const env = await runOperation(operationId, parsed.input, opts);
  return {
    env,
    exitCode: env.ok ? ExitCode.Success : exitCodeForError(env.error, env.http?.status),
  };
}

function parseCallInput(
  operationId: string,
  options: CallOptions,
):
  | { ok: true; input: AgentInput | Record<string, unknown> }
  | { ok: false; env: ReturnType<typeof validationError> } {
  const cmd = `elv call ${operationId}`;
  const jsonSources = [
    options.json,
    options.jsonFile,
    options.stdinJson ? "stdin" : undefined,
  ].filter(Boolean);
  if (jsonSources.length > 1) {
    return {
      ok: false,
      env: validationError(cmd, "Use only one of --json, --json-file, or --stdin-json"),
    };
  }

  let input: Record<string, unknown> = {};
  try {
    if (options.json !== undefined) input = parseJsonObject(options.json);
    else if (options.jsonFile !== undefined)
      input = parseJsonObject(readFileSync(options.jsonFile, "utf8"));
    else if (options.stdinJson) input = parseJsonObject(readFileSync(0, "utf8"));
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }

  try {
    addPairs(input, "query", options.query);
    addPairs(input, "path", options.path);
    addFiles(input, options.file);
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }
  return { ok: true, input };
}

function callRunOpts(options: CallOptions): RunOpts & PaginationOptions {
  return {
    ...runOptsFromOptions(options),
    allowUnknown: options.allowUnknown,
    unpack: options.unpack,
    ...paginationOptionsFromOptions(options),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  return parseJsonRecord(raw, "JSON input", "JSON input must be an object");
}
