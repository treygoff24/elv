#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { configDoctor, loadConfig } from "./core/config";
import { emitAndExit, notImplemented, validationError } from "./core/errors";
import { success } from "./core/envelope";
import { ExitCode } from "./core/types";
import { handleOpsGet, handleOpsSchema, handleOpsSearch } from "./commands/ops";
import { updateSpecCache } from "./openapi/fetch-spec";
import type { ConfigOverrides } from "./core/config";
import type { Envelope } from "./core/types";

const ALIASES = [
  "tts",
  "stt",
  "music",
  "sfx",
  "voice-change",
  "voice-isolate",
  "dubbing",
  "voices",
  "models",
  "agents",
  "history",
  "usage",
] as const;

export async function main(argv = process.argv): Promise<void> {
  const version = packageVersion();
  const program = buildProgram(version);

  try {
    if (argv.length <= 2)
      emitAndExit(validationError("elv", "Missing command"), ExitCode.InputValidation);
    await program.parseAsync(argv);
  } catch (error) {
    const { env, exitCode } = envelopeForError(error, argv, version);
    emitAndExit(env, exitCode);
  }
}

function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("elv")
    .version(version)
    .exitOverride()
    .showSuggestionAfterError(false)
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: () => undefined,
      writeErr: () => undefined,
      outputError: () => undefined,
    });
  addCommonFlags(program);

  const ops = program
    .command("ops")
    .description("OpenAPI operation discovery")
    .action(() => notImplExit("elv ops"));
  addCommonFlags(
    ops
      .command("search <query>")
      .option("--limit <n>", "maximum results", "10")
      .action((query: string, options: Record<string, unknown>) =>
        handleOpsSearch(query, { limit: optionString(options.limit) }),
      ),
  );
  addCommonFlags(
    ops.command("get <operation_id>").action((id: string) => handleOpsGet(id)),
  );
  addCommonFlags(
    ops
      .command("schema <operation_id>")
      .option("--raw")
      .option("--example")
      .action((id: string, options: Record<string, unknown>) =>
        handleOpsSchema(id, { raw: Boolean(options.raw), example: Boolean(options.example) }),
      ),
  );

  addCommonFlags(
    program.command("call <operation_id>").action((id: string) => notImplExit(`elv call ${id}`)),
  );
  addCommonFlags(
    program
      .command("http <method> <path>")
      .action((method: string, path: string) => notImplExit(`elv http ${method} ${path}`)),
  );
  addCommonFlags(
    program
      .command("ws [target]")
      .action((target: string | undefined) => notImplExit(`elv ws${target ? ` ${target}` : ""}`)),
  );
  addCommonFlags(program.command("wait").action(() => notImplExit("elv wait")));
  addCommonFlags(
    program.command("view <path>").action((path: string) => notImplExit(`elv view ${path}`)),
  );

  const config = program
    .command("config")
    .description("Configuration")
    .action(() => notImplExit("elv config"));
  addCommonFlags(
    config.command("get").action((...args: unknown[]) => {
      const command = lastCommand(args);
      const configData = loadConfig(configOverrides(command));
      emitAndExit(success({ cmd: "elv config get", data: configData }), ExitCode.Success);
    }),
  );
  addCommonFlags(
    config.command("doctor").action(async (...args: unknown[]) => {
      const command = lastCommand(args);
      const result = await configDoctor(configOverrides(command));
      emitAndExit(result.env, result.exitCode);
    }),
  );

  const spec = program
    .command("spec")
    .description("OpenAPI spec cache")
    .action(() => notImplExit("elv spec"));
  addCommonFlags(
    spec
      .command("update")
      .option("--from <file_or_url>")
      .option("--offline")
      .action(async (options: Record<string, unknown>) => {
        const result = await updateSpecCache({
          from: optionString(options.from),
          offline: Boolean(options.offline),
          cmd: "elv spec update",
        });
        emitAndExit(result.env, result.exitCode);
      }),
  );

  for (const alias of ALIASES) {
    addCommonFlags(
      program
        .command(alias)
        .allowUnknownOption()
        .allowExcessArguments()
        .action(() => notImplExit(`elv ${alias}`)),
    );
  }

  return program;
}

interface CommonOptions {
  baseUrl?: string;
  profile?: string;
  maxCredits?: string;
  debug?: boolean;
}

function addCommonFlags(command: Command): Command {
  return command
    .option("--dry-run", "preview without network")
    .option("--yes", "confirm gated operations")
    .option("--max-credits <credits>", "credit ceiling")
    .option("--out <path>", "output file or directory")
    .option("--base-url <url>", "override API base URL")
    .option("--profile <name>", "config profile")
    .option("--debug", "debug logs to stderr")
    .option("--retry-post", "retry POST requests")
    .option("--json <json>", "JSON input");
}

function configOverrides(command: Command): ConfigOverrides {
  const opts = mergedOptions(command) as CommonOptions;
  const parsedMaxCredits = opts.maxCredits === undefined ? undefined : Number(opts.maxCredits);
  return {
    profile: opts.profile,
    baseUrl: opts.baseUrl,
    maxCredits: Number.isFinite(parsedMaxCredits) ? parsedMaxCredits : undefined,
    debug: opts.debug,
  };
}

function lastCommand(args: unknown[]): Command {
  return args[args.length - 1] as Command;
}

function optionString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function mergedOptions(command: Command): Record<string, unknown> {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent)
    chain.unshift(current);
  return Object.assign({}, ...chain.map((current) => current.opts()));
}

function notImplExit(cmd: string): never {
  emitAndExit(notImplemented(cmd), ExitCode.ProviderError);
}

function envelopeForError(
  error: unknown,
  argv: string[],
  version: string,
): { env: Envelope; exitCode: ExitCode } {
  const cmd = argvToCmd(argv);
  if (error instanceof CommanderError) {
    if (error.code === "commander.version") {
      return { env: success({ cmd, data: { version } }), exitCode: ExitCode.Success };
    }
    if (error.code === "commander.helpDisplayed") {
      return {
        env: success({ cmd, data: { commands: commandNames() } }),
        exitCode: ExitCode.Success,
      };
    }
    if (error.code === "commander.unknownCommand") {
      return {
        env: {
          v: 1,
          ok: false,
          cmd,
          error: { type: "not_found_error", code: "unknown_command", message: error.message },
          retry: { recommended: false, after_ms: null },
        },
        exitCode: ExitCode.NotFound,
      };
    }
    return { env: validationError(cmd, error.message), exitCode: ExitCode.InputValidation };
  }

  return {
    env: {
      v: 1,
      ok: false,
      cmd,
      error: {
        type: "runtime_error",
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
        raw: error,
      },
      retry: { recommended: false, after_ms: null },
    },
    exitCode: ExitCode.ProviderError,
  };
}

function argvToCmd(argv: string[]): string {
  return ["elv", ...argv.slice(2)].join(" ").trim();
}

function commandNames(): string[] {
  return ["ops", "call", "http", "ws", "wait", "config", "spec", "view", ...ALIASES];
}

function packageVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  const json = JSON.parse(readFileSync(packageUrl, "utf8")) as { version?: string };
  return json.version ?? "0.0.0";
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  void main().catch((error: unknown) => {
    const { env, exitCode } = envelopeForError(error, process.argv, "0.0.0");
    emitAndExit(env, exitCode);
  });
}
