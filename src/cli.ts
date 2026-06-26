#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
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
  optionString,
  optionStrings,
} from "./commands/options";
import { handleWait } from "./commands/wait";
import { runWs } from "./commands/ws";
import { handleOpsGet, handleOpsSchema, handleOpsSearch } from "./commands/ops";
import { handleView } from "./commands/view";
import { registerAliases } from "./commands/aliases";
import { updateSpecCache } from "./openapi/fetch-spec";
import type { ConfigOverrides } from "./core/config";
import type { RunWsOptions, WsCommandInput } from "./commands/ws";
import type { Envelope } from "./core/types";

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
    .action((id: string, _options: Record<string, unknown>, command: Command) =>
      handleCall(id, mergedOptions(command) as Parameters<typeof handleCall>[1]),
    );
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
      .action((method: string, path: string, _options: Record<string, unknown>, command: Command) =>
        handleHttp(method, path, httpOptions(command)),
      ),
  );
  addCommonFlags(
    program
      .command("ws [target]")
      .description("Open a WebSocket session or list the catalog")
      .option("--list", "list the WebSocket catalog")
      .option("--query <key=value>", "add query parameter", collect, [])
      .option("--send <path>", "NDJSON send-script")
      .action(
        async (target: string | undefined, _options: Record<string, unknown>, command: Command) => {
          const input = wsInput(target, command);
          if (!input.ok)
            emitAndExit(validationError("elv ws", input.error), ExitCode.InputValidation);
          const result = await runWs(input.value, wsRunOptions(command));
          emitAndExit(result.env, result.exitCode);
        },
      ),
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
      .action((_options: Record<string, unknown>, command: Command) =>
        handleWait(waitOptions(command)),
      ),
  );
  addCommonFlags(
    program
      .command("view <path>")
      .description("Inspect a spilled JSON/NDJSON result file without loading it into context")
      .option("--path <dotted>", "drill into a JSON path, e.g. data.voices.0.name or voices[].name")
      .option("--limit <n>", "max array items to show")
      .action((path: string, options: Record<string, unknown>) =>
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
      .action((query: string, options: Record<string, unknown>) =>
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
      .action((id: string, options: Record<string, unknown>) =>
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
      .action(async (options: Record<string, unknown>) => {
        const result = await updateSpecCache({
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
    .action((_options: Record<string, unknown>, command: Command) =>
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
  const maxCredits = optionString(opts.maxCredits);
  const parsedMaxCredits = maxCredits === undefined ? undefined : Number(maxCredits);
  return {
    profile: optionString(opts.profile),
    baseUrl: optionString(opts.baseUrl),
    maxCredits: Number.isFinite(parsedMaxCredits) ? parsedMaxCredits : undefined,
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
  const json = JSON.parse(readFileSync(packageUrl, "utf8")) as { version?: string };
  return json.version ?? "0.0.0";
}

// Resolve symlinks on both sides: when installed via `npm link`/`-g`, argv[1] is
// the bin symlink (e.g. /opt/homebrew/bin/elv), not the real module path, so a
// plain resolve() comparison would never match and main() would silently skip.
function realEntry(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isDirectCliEntry(argv = process.argv): boolean {
  const entry = argv[1];
  return entry ? realEntry(fileURLToPath(import.meta.url)) === realEntry(entry) : false;
}

if (isDirectCliEntry()) {
  void main().catch((error: unknown) => {
    const { env, exitCode } = envelopeForError(error, process.argv, "0.0.0", buildProgram("0.0.0"));
    emitAndExit(env, exitCode);
  });
}
