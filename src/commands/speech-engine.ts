import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { ConfigFileError, getApiKey, loadConfig } from "../core/config";
import { failure, success } from "../core/envelope";
import {
  configFileError,
  confirmationRequired,
  emitAndExit,
  validationError,
} from "../core/errors";
import { ExitCode, type CommandResult, type RunOpts } from "../core/types";
import { errorMessage } from "../util/error";
import {
  startSpeechEngineServer,
  validateServerOptions,
  type SpeechEngineServer,
} from "../speech-engine/server";
import { collect, numberValue, runOptsFromCommand } from "./options";

interface ServeFlags {
  handlerJson?: string;
  handlerEnv?: string[];
  host?: string;
  port?: string;
  path?: string;
  timeoutMs?: string;
  turnTimeoutMs?: string;
  idleTimeoutMs?: string;
  maxSessions?: string;
  maxPayloadBytes?: string;
  maxOutputBytes?: string;
  readyFile?: string;
}

const CMD = "elv speech-engine serve";

function handlerArguments(raw: string | undefined): string[] {
  let args: unknown;
  try {
    args = JSON.parse(raw ?? "null");
  } catch {
    throw new Error("--handler-json must contain a JSON argv array, not a shell command");
  }
  if (!Array.isArray(args) || !args.length || !args.every((arg) => typeof arg === "string"))
    throw new Error("--handler-json must be a nonempty argv array of strings");
  return args;
}

function handlerEnvironment(names: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", ...names]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error("--handler-env accepts environment variable names, not assignments");
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export async function runSpeechEngineServe(
  flags: ServeFlags,
  options: RunOpts = {},
): Promise<CommandResult> {
  let running: SpeechEngineServer | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    const config = loadConfig({ profile: options.profile, maxCredits: options.maxCredits });
    if (
      config.maxCredits !== undefined &&
      (!Number.isFinite(config.maxCredits) || config.maxCredits < 0)
    )
      throw new Error("--max-credits must be a non-negative number");
    const serverOptions = validateServerOptions({
      apiKey: options.apiKey ?? getApiKey({ profile: options.profile }) ?? "",
      handler: handlerArguments(flags.handlerJson),
      env: handlerEnvironment(flags.handlerEnv),
      host: flags.host,
      port: numberValue(flags.port),
      path: flags.path,
      timeoutMs: numberValue(flags.timeoutMs),
      turnTimeoutMs: numberValue(flags.turnTimeoutMs),
      idleTimeoutMs: numberValue(flags.idleTimeoutMs),
      maxSessions: numberValue(flags.maxSessions),
      maxPayloadBytes: numberValue(flags.maxPayloadBytes),
      maxOutputBytes: numberValue(flags.maxOutputBytes),
      signal: controller.signal,
    });
    const readyFile = flags.readyFile === undefined ? undefined : resolve(flags.readyFile);
    if (readyFile && existsSync(readyFile))
      throw new Error("--ready-file already exists; choose a new path");
    if (options.dryRun)
      return {
        env: success({
          cmd: CMD,
          data: {
            dry_run: true,
            host: serverOptions.host,
            port: serverOptions.port,
            path: serverOptions.path,
            handler_arguments: serverOptions.handler.length,
            handler_env: flags.handlerEnv ?? [],
            timeout_ms: serverOptions.timeoutMs,
            authentication: "HS256",
            api_key_present: Boolean(serverOptions.apiKey.trim()),
            would_require_yes: true,
            would_exceed_budget: config.maxCredits !== undefined,
          },
        }),
        exitCode: ExitCode.Success,
      };
    if (!options.yes)
      return {
        env: confirmationRequired(
          CMD,
          "Accepting Speech Engine sessions and invoking a handler require --yes",
        ),
        exitCode: ExitCode.ConfirmationRequired,
      };
    if (config.maxCredits !== undefined)
      return {
        env: failure({
          cmd: CMD,
          error: {
            type: "budget_exceeded",
            code: "budget_estimate_unavailable",
            message:
              "Cannot bound credits for inbound Speech Engine sessions; serving is blocked while a credit ceiling is configured",
          },
        }),
        exitCode: ExitCode.BudgetCeiling,
      };
    if (!serverOptions.apiKey.trim())
      return {
        env: failure({
          cmd: CMD,
          error: {
            type: "authentication_error",
            code: "missing_api_key",
            message: "An API key is required to verify incoming Speech Engine sessions",
          },
        }),
        exitCode: ExitCode.AuthPermission,
      };
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    running = await startSpeechEngineServer(serverOptions);
    const readiness = {
      v: 1,
      ok: true,
      event: "listening",
      host: running.host,
      port: running.port,
      path: running.path,
      url: running.url,
      pid: process.pid,
      authentication: "HS256",
    };
    if (readyFile)
      writeFileSync(readyFile, `${JSON.stringify(readiness)}\n`, { flag: "wx", mode: 0o600 });
    process.stderr.write(`${JSON.stringify(readiness)}\n`);
    const result = await running.done;
    if (result.reason === "cleanup_incomplete")
      return {
        env: failure({
          cmd: CMD,
          error: {
            type: "server_error",
            code: "speech_engine_cleanup_incomplete",
            message:
              "Could not verify that every owned handler process group exited before the cleanup deadline",
            raw: result,
          },
        }),
        exitCode: ExitCode.ProviderError,
      };
    return {
      env:
        result.reason === "server_error"
          ? failure({
              cmd: CMD,
              error: {
                type: "server_error",
                code: "speech_engine_server_failed",
                message: "Speech Engine listener failed",
              },
            })
          : success({ cmd: CMD, data: result }),
      exitCode: result.reason === "server_error" ? ExitCode.ProviderError : ExitCode.Success,
    };
  } catch (error) {
    await running?.stop();
    return {
      env:
        error instanceof ConfigFileError
          ? configFileError(CMD, error.message)
          : validationError(CMD, errorMessage(error)),
      exitCode: ExitCode.InputValidation,
    };
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

export function registerSpeechEngineCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const speechEngine = program
    .command("speech-engine")
    .description("Host the authenticated Speech Engine upstream protocol");
  addCommonFlags(
    speechEngine
      .command("serve")
      .description("Serve locally and stream a subprocess handler's responses (requires --yes)")
      .option(
        "--handler-json <argv>",
        "JSON argv array; receives one transcript JSON on stdin, emits NDJSON {text:string}",
      )
      .option(
        "--handler-env <name>",
        "pass an additional environment variable to the handler (repeatable)",
        collect,
        [],
      )
      .option(
        "--host <ip>",
        "bind address (default 127.0.0.1; non-loopback requires intentional exposure)",
      )
      .option("--port <port>", "listen port (default 3001; 0 selects an available port)")
      .option("--path <path>", "WebSocket path (default /ws)")
      .option("--ready-file <path>", "write private readiness JSON to a new file")
      .option("--timeout-ms <ms>", "server lifetime (default 600000)")
      .option("--turn-timeout-ms <ms>", "handler deadline per turn (default 30000)")
      .option("--idle-timeout-ms <ms>", "client inactivity deadline (default 60000)")
      .option("--max-sessions <n>", "maximum concurrent sessions (default 4)")
      .option("--max-payload-bytes <n>", "maximum incoming message size (default 1048576)")
      .option("--max-output-bytes <n>", "maximum handler output per turn (default 1048576)")
      .action(async (flags: ServeFlags, command: Command) => {
        const result = await runSpeechEngineServe(flags, runOptsFromCommand(command));
        emitAndExit(result.env, result.exitCode);
      }),
  );
}
