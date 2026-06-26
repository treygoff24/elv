#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { ConfigFileError, configDoctor, loadConfig } from "./core/config";
import { configFileError, emitAndExit, validationError } from "./core/errors";
import { success } from "./core/envelope";
import { ExitCode } from "./core/types";
import { handleCall } from "./commands/call";
import { handleHttp } from "./commands/http";
import {
  addCommonFlags,
  collect,
  mergedOptions,
  numberValue,
  OptionValueError,
  optionString,
  optionStrings,
} from "./commands/options";
import { handleWait } from "./commands/wait";
import { runWs } from "./commands/ws";
import { handleOpsGet, handleOpsSchema, handleOpsSearch } from "./commands/ops";
import { handleView } from "./commands/view";
import { registerAliases } from "./commands/aliases";
import { handleSpecUpdate } from "./commands/spec";
import { parseJson } from "./util/json";
import type { ConfigOverrides } from "./core/config";
import type { RunWsOptions, WsCommandInput } from "./commands/ws";
import type { Envelope } from "./core/types";
import type { CliOptionValues } from "./commands/options";

export async function main(argv = process.argv): Promise<void> {
  const version = packageVersion();
  const program = buildProgram(version);

  try {
    if (argv.length <= 2)
      emitAndExit(success({ cmd: "elv", data: topLevelHelpData(program) }), ExitCode.Success);
    await program.parseAsync(argv);
  } catch (error) {
    const { env, exitCode } = envelopeForError(error, argv, version, program);
    emitAndExit(env, exitCode);
  }
}

function buildProgram(version: string): Command {
  const program = new Command();
  program
    .name("elv")
    .description("Agent-first CLI for the ElevenLabs API")
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

  registerOpsCommands(program);

  const call = program
    .command("call <operation_id>")
    .description("Call an OpenAPI operation by id")
    .option("--json <json>", "JSON input")
    .option("--json-file <path>", "read JSON input from a file")
    .option("--stdin-json", "read JSON input from stdin")
    .option("--query <key=value>", "add query parameter", collect, [])
    .option("--path <key=value>", "add path parameter", collect, [])
    .option("--file <field=path>", "add file upload field", collect, [])
    .option("--allow-unknown", "route unknown flat keys to body")
    .option("--unpack", "unpack zip responses when supported")
    .option("--hash", "force sha256 hashing for large output files")
    .option("--all", "fetch and save all pages")
    .option("--limit <n>", "max items inlined in the envelope")
    .option("--save-json <path>", "write the full JSON result to a path")
    .action(async (id: string, _options: CliOptionValues, command: Command) => {
      const result = await handleCall(
        id,
        mergedOptions(command) as Parameters<typeof handleCall>[1],
      );
      emitAndExit(result.env, result.exitCode);
    });
  addCommonFlags(call);
  addCommonFlags(
    program
      .command("http <method> <path>")
      .description("Make a raw HTTP request to the API")
      .option("--query <key=value>", "add query parameter", collect, [])
      .option("--body-json <json>", "JSON request body")
      .option("--file <field=path>", "add file upload field", collect, [])
      .option("--all", "fetch and save all pages")
      .option("--limit <n>", "max items inlined in the envelope")
      .option("--save-json <path>", "write the full JSON result to a path")
      .action(async (method: string, path: string, _options: CliOptionValues, command: Command) => {
        const result = await handleHttp(method, path, httpOptions(command));
        emitAndExit(result.env, result.exitCode);
      }),
  );
  addCommonFlags(
    program
      .command("ws [target]")
      .description("Open a WebSocket session or list the catalog")
      .option("--list", "list the WebSocket catalog")
      .option("--query <key=value>", "add query parameter", collect, [])
      .option("--send <path>", "NDJSON send-script")
      .action(async (target: string | undefined, _options: CliOptionValues, command: Command) => {
        const input = wsInput(target, command);
        if (!input.ok)
          emitAndExit(validationError("elv ws", input.error), ExitCode.InputValidation);
        const result = await runWs(input.value, wsRunOptions(command));
        emitAndExit(result.env, result.exitCode);
      }),
  );
  addCommonFlags(
    program
      .command("wait")
      .description("Poll an operation until a status condition is met")
      .option("--operation <id>", "operation to poll")
      .option("--json <json>", "JSON input for operation polling")
      .option("--status-path <path>", "dotted status path, e.g. $.data.status")
      .option("--success <csv>", "success status values (comma-separated)")
      .option("--failure <csv>", "failure status values (comma-separated)")
      .option("--interval-ms <ms>", "poll interval in milliseconds")
      .option("--timeout-ms <ms>", "overall timeout in milliseconds")
      .option("--cmd <json>", "JSON array command to poll instead of an operation")
      .action(async (_options: CliOptionValues, command: Command) => {
        const result = await handleWait(waitOptions(command));
        emitAndExit(result.env, result.exitCode);
      }),
  );
  addCommonFlags(
    program
      .command("view <path>")
      .description("Inspect a spilled JSON/NDJSON result file without loading it into context")
      .option("--path <dotted>", "drill into a JSON path, e.g. data.voices.0.name or voices[].name")
      .option("--limit <n>", "max array items to show")
      .action((path: string, options: CliOptionValues) =>
        handleView(path, { path: optionString(options.path), limit: optionString(options.limit) }),
      ),
  );

  registerConfigCommands(program);
  registerSpecCommands(program);

  registerAliases(program, addCommonFlags);

  return program;
}

function registerOpsCommands(program: Command): void {
  const ops = parentCommand(program, "ops", "OpenAPI operation discovery");
  addCommonFlags(
    ops
      .command("search <query>")
      .description("Search operations by keyword")
      .option("--limit <n>", "maximum results", "10")
      .action((query: string, options: CliOptionValues) =>
        handleOpsSearch(query, { limit: optionString(options.limit) }),
      ),
  );
  addCommonFlags(
    ops
      .command("get <operation_id>")
      .description("Show an operation card: params, risk, examples")
      .action((id: string) => handleOpsGet(id)),
  );
  addCommonFlags(
    ops
      .command("schema <operation_id>")
      .description("Show the input schema or a runnable example")
      .option("--raw", "return raw JSON Schema for operation input")
      .option("--example", "return a runnable elv call example command")
      .action((id: string, options: CliOptionValues) =>
        handleOpsSchema(id, { raw: Boolean(options.raw), example: Boolean(options.example) }),
      ),
  );
}

function registerConfigCommands(program: Command): void {
  const config = parentCommand(program, "config", "Configuration");
  addCommonFlags(
    config
      .command("get")
      .description("Print resolved configuration")
      .action((...args: unknown[]) => {
        const command = lastCommand(args);
        const configData = loadConfig(configOverrides(command));
        emitAndExit(success({ cmd: "elv config get", data: configData }), ExitCode.Success);
      }),
  );
  addCommonFlags(
    config
      .command("doctor")
      .description("Check auth, connectivity, and credits")
      .action(async (...args: unknown[]) => {
        const command = lastCommand(args);
        const result = await configDoctor(configOverrides(command));
        emitAndExit(result.env, result.exitCode);
      }),
  );
}

function registerSpecCommands(program: Command): void {
  const spec = parentCommand(program, "spec", "OpenAPI spec cache");
  addCommonFlags(
    spec
      .command("update")
      .description("Refresh the cached OpenAPI spec")
      .option("--from <file_or_url>", "OpenAPI spec file path or URL to fetch")
      .option("--offline", "recompile from the vendored spec snapshot")
      .action(async (options: CliOptionValues) => {
        const result = await handleSpecUpdate({
          from: optionString(options.from),
          offline: Boolean(options.offline),
          cmd: "elv spec update",
        });
        emitAndExit(result.env, result.exitCode);
      }),
  );
}

function parentCommand(program: Command, name: string, description: string): Command {
  return program
    .command(name)
    .description(description)
    .action((_options: CliOptionValues, command: Command) =>
      emitAndExit(
        success({ cmd: `elv ${command.name()}`, data: commandHelpData(command) }),
        ExitCode.Success,
      ),
    );
}

function httpOptions(command: Command): Parameters<typeof handleHttp>[2] {
  const opts = mergedOptions(command);
  return {
    query: optionStrings(opts.query),
    bodyJson: optionString(opts.bodyJson),
    file: optionStrings(opts.file),
    out: optionString(opts.out),
    saveJson: optionString(opts.saveJson),
    all: Boolean(opts.all),
    limit: optionString(opts.limit),
    dryRun: Boolean(opts.dryRun),
    retryPost: Boolean(opts.retryPost),
    hash: Boolean(opts.hash),
    baseUrl: optionString(opts.baseUrl),
    profile: optionString(opts.profile),
    maxCredits: optionString(opts.maxCredits),
    yes: Boolean(opts.yes),
  };
}

function wsInput(
  target: string | undefined,
  command: Command,
): { ok: true; value: WsCommandInput } | { ok: false; error: string } {
  const opts = mergedOptions(command);
  const query = wsQuery(optionStrings(opts.query));
  if (!query.ok) return query;
  const send = optionString(opts.send);
  return {
    ok: true,
    value: {
      target,
      list: Boolean(opts.list),
      query: query.value,
      send: send === undefined ? undefined : resolve(send),
      out: optionString(opts.out),
    },
  };
}

function wsQuery(
  pairs: string[] | undefined,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  const query: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const index = pair.indexOf("=");
    if (index <= 0) return { ok: false, error: `Expected key=value, got "${pair}"` };
    query[pair.slice(0, index)] = pair.slice(index + 1);
  }
  return { ok: true, value: query };
}

function wsRunOptions(command: Command): RunWsOptions {
  const opts = mergedOptions(command);
  return { baseUrl: optionString(opts.baseUrl), profile: optionString(opts.profile) };
}

function waitOptions(command: Command): Parameters<typeof handleWait>[0] {
  const opts = mergedOptions(command);
  return {
    operation: optionString(opts.operation),
    json: optionString(opts.json),
    statusPath: optionString(opts.statusPath),
    success: optionString(opts.success),
    failure: optionString(opts.failure),
    intervalMs: optionString(opts.intervalMs),
    timeoutMs: optionString(opts.timeoutMs),
    cmd: optionString(opts.cmd),
  };
}

function configOverrides(command: Command): ConfigOverrides {
  const opts = mergedOptions(command);
  return {
    profile: optionString(opts.profile),
    baseUrl: optionString(opts.baseUrl),
    maxCredits: numberValue(opts.maxCredits),
    debug: Boolean(opts.debug),
  };
}

function lastCommand(args: unknown[]): Command {
  return args[args.length - 1] as Command;
}

function commandHelpData(node: Command): Record<string, unknown> {
  return {
    command: node.name(),
    description: node.description(),
    usage: node.usage(),
    arguments: node.registeredArguments.map((a) => ({
      name: a.name(),
      required: a.required,
      description: a.description,
    })),
    options: node.options.map((o) => ({
      flags: o.flags,
      description: o.description,
      default: o.defaultValue,
    })),
    subcommands: node.commands.map((c) => c.name()).filter((n) => n !== "help"),
  };
}

function resolveCommandPath(program: Command, argv: string[]): Command {
  let current = program;
  for (const token of argv.slice(2)) {
    if (token.startsWith("-")) break;
    const next = current.commands.find(
      (sub) => sub.name() === token || sub.aliases().includes(token),
    );
    if (!next) break;
    current = next;
  }
  return current;
}

function envelopeForError(
  error: unknown,
  argv: string[],
  version: string,
  program: Command,
): { env: Envelope; exitCode: ExitCode } {
  const cmd = argvToCmd(argv);
  if (error instanceof CommanderError) {
    if (error.code === "commander.version") {
      return { env: success({ cmd, data: { version } }), exitCode: ExitCode.Success };
    }
    if (error.code === "commander.helpDisplayed") {
      const cmdNode = resolveCommandPath(program, argv);
      if (cmdNode === program) {
        return {
          env: success({ cmd, data: topLevelHelpData(program) }),
          exitCode: ExitCode.Success,
        };
      }
      return {
        env: success({
          cmd,
          data: commandHelpData(cmdNode),
        }),
        exitCode: ExitCode.Success,
      };
    }
    if (error.code === "commander.help") {
      const subcommands = resolveCommandPath(program, argv)
        .commands.map((sub) => sub.name())
        .filter((name) => name !== "help");
      const detail = subcommands.length ? ` (one of: ${subcommands.join(", ")})` : "";
      return {
        env: validationError(cmd, `missing subcommand${detail}`, { raw: { subcommands } }),
        exitCode: ExitCode.InputValidation,
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
  if (error instanceof ConfigFileError) {
    return {
      env: configFileError(cmd, error.message, { raw: { path: error.path } }),
      exitCode: ExitCode.InputValidation,
    };
  }
  if (error instanceof OptionValueError) {
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

function topLevelHelpData(program: Command): Record<string, unknown> {
  return {
    command: "elv",
    description: program.description(),
    commands: program.commands
      .filter((command) => command.name() !== "help")
      .map((command) => ({ name: command.name(), description: command.description() })),
  };
}

function packageVersion(): string {
  const packageUrl = new URL("../package.json", import.meta.url);
  try {
    const json = parseJson(readFileSync(packageUrl, "utf8"), "package.json") as {
      version?: string;
    };
    return json.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const DIRECT_ENTRY_NAMES = new Set(["cli.ts", "cli.js", "elv"]);

// Resolve symlinks only after cheap checks. When installed via `npm link`/`-g`,
// argv[1] is the bin symlink (e.g. /opt/homebrew/bin/elv), not the real module
// path; ordinary imports should not realpath ambient process.argv at all.
function realEntry(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectCliEntry(argv = process.argv): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  if (resolve(entry) === modulePath) return true;
  if (!DIRECT_ENTRY_NAMES.has(basename(entry))) return false;
  return realEntry(modulePath) === realEntry(entry);
}

if (isDirectCliEntry()) {
  void main().catch((error: unknown) => {
    const { env, exitCode } = envelopeForError(error, process.argv, "0.0.0", buildProgram("0.0.0"));
    emitAndExit(env, exitCode);
  });
}
