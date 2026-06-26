import { spawn } from "node:child_process";
import { emitAndExit, exitCodeForError, validationError } from "../core/errors";
import { failure } from "../core/envelope";
import { runOperation } from "../core/client";
import { readPath } from "../util/jsonpath";
import { ExitCode } from "../core/types";
import type { AgentInput, Envelope } from "../core/types";

export interface WaitOptions {
  operation?: string;
  json?: string;
  statusPath?: string;
  success?: string;
  failure?: string;
  intervalMs?: string | number;
  timeoutMs?: string | number;
  cmd?: string;
}

export interface WaitResult {
  env: Envelope;
  exitCode: ExitCode;
}

export interface WaitDeps {
  runOperation?: (operationId: string, input: AgentInput | Record<string, unknown>) => Promise<Envelope>;
  runCommand?: (argv: string[]) => Promise<Envelope>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export async function handleWait(options: WaitOptions): Promise<never> {
  const result = await waitForOperation(options);
  emitAndExit(result.env, result.exitCode);
}

export async function waitForOperation(
  options: WaitOptions,
  deps: WaitDeps = {},
): Promise<WaitResult> {
  const parsed = parseOptions(options);
  if (!parsed.ok) return { env: parsed.env, exitCode: ExitCode.InputValidation };

  const run = parsed.cmd
    ? () => (deps.runCommand ?? runCommand)(parsed.cmd)
    : () => (deps.runOperation ?? runOperation)(parsed.operation, parsed.input);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + parsed.timeoutMs;

  for (;;) {
    const env = await run();
    if (!env.ok)
      return {
        env,
        exitCode: exitCodeForError(env.error, env.http?.status ?? undefined),
      };

    let status: unknown;
    try {
      status = readPath(env, parsed.statusPath);
    } catch (error) {
      return {
        env: validationError("elv wait", error instanceof Error ? error.message : String(error)),
        exitCode: ExitCode.InputValidation,
      };
    }

    if (isScalar(status)) {
      const value = String(status);
      if (parsed.success.has(value)) return { env, exitCode: ExitCode.Success };
      if (parsed.failure.has(value)) return waitFailure(value, env);
    }

    if (now() >= deadline) return waitTimeout(parsed.statusPath, status, env);
    await sleep(parsed.intervalMs);
  }
}

function parseOptions(options: WaitOptions):
  | {
      ok: true;
      operation: string;
      input: AgentInput | Record<string, unknown>;
      cmd?: undefined;
      statusPath: string;
      success: Set<string>;
      failure: Set<string>;
      intervalMs: number;
      timeoutMs: number;
    }
  | {
      ok: true;
      operation: string;
      input: AgentInput | Record<string, unknown>;
      cmd: string[];
      statusPath: string;
      success: Set<string>;
      failure: Set<string>;
      intervalMs: number;
      timeoutMs: number;
    }
  | { ok: false; env: ReturnType<typeof validationError> } {
  const cmd = "elv wait";
  const statusPath = options.statusPath;
  if (!statusPath) return { ok: false, env: validationError(cmd, "--status-path is required") };
  if (!options.success) return { ok: false, env: validationError(cmd, "--success is required") };

  try {
    // Validate unsupported path syntax before the first poll.
    readPath({}, statusPath);
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }

  const common = {
    statusPath,
    success: csvSet(options.success),
    failure: csvSet(options.failure ?? ""),
    intervalMs: positiveMs(options.intervalMs, DEFAULT_INTERVAL_MS, "--interval-ms"),
    timeoutMs: positiveMs(options.timeoutMs, DEFAULT_TIMEOUT_MS, "--timeout-ms"),
  };

  if (options.cmd) {
    try {
      const parsed = JSON.parse(options.cmd) as unknown;
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
        throw new Error("--cmd must be a JSON string array");
      }
      return { ok: true, operation: "cmd", input: {}, cmd: parsed as string[], ...common };
    } catch (error) {
      return {
        ok: false,
        env: validationError(cmd, error instanceof Error ? error.message : String(error)),
      };
    }
  }

  if (!options.operation) return { ok: false, env: validationError(cmd, "--operation is required") };
  try {
    const input = options.json === undefined ? {} : parseJsonObject(options.json);
    return { ok: true, operation: options.operation, input, ...common };
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }
}

function waitFailure(status: string, env: Envelope): WaitResult {
  return {
    env: failure({
      cmd: "elv wait",
      operation_id: env.operation_id,
      error: {
        type: "wait_failure",
        code: "wait_failure",
        message: `Operation reached failure status: ${status}`,
        raw: { status, envelope: env },
      },
      retry: { recommended: false, after_ms: null },
    }),
    exitCode: ExitCode.ProviderError,
  };
}

function waitTimeout(path: string, status: unknown, env: Envelope): WaitResult {
  return {
    env: failure({
      cmd: "elv wait",
      operation_id: env.operation_id,
      error: {
        type: "wait_timeout",
        code: "wait_timeout",
        message: `Timed out waiting for ${path}`,
        raw: { status, envelope: env },
      },
      retry: { recommended: true, after_ms: null },
    }),
    exitCode: ExitCode.TransientExhausted,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--json must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function csvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function positiveMs(value: string | number | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return Math.trunc(parsed);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function runCommand(argv: string[]): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (!command) {
      reject(new Error("--cmd must not be empty"));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim()) as Envelope);
      } catch {
        reject(new Error(`Command did not emit a JSON envelope: ${stderr.trim()}`));
      }
    });
  });
}
