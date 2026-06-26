import { resolve } from "node:path";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, validationError } from "../../core/errors";
import { waitForOperation } from "../wait";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";
import {
  addPaginationFlags,
  commandName,
  compact,
  compactInput,
  emit,
  message,
  projectFields,
  required,
  resolveListOpts,
  runOpts,
} from "./shared";

export interface DubbingCreateFlags {
  file?: string;
  source?: string;
  target?: string;
  name?: string;
  wait?: boolean;
}

export interface DubbingIdFlags {
  id?: string;
  language?: string;
}

export function buildDubbingCreateInput(flags: DubbingCreateFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "create_dubbing",
    input: compactInput({
      files: flags.file ? { file: resolve(flags.file) } : undefined,
      body: compact({ name: flags.name, source_lang: flags.source, target_lang: flags.target }),
    }),
  };
}

export function buildDubbingGetInput(flags: DubbingIdFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "get_dubbed_metadata",
    input: { path: { dubbing_id: required(flags.id, "--id") } },
  };
}

export function buildDubbingAudioInput(flags: DubbingIdFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "get_dubbed_file",
    input: {
      path: {
        dubbing_id: required(flags.id, "--id"),
        language_code: required(flags.language, "--language"),
      },
    },
  };
}

export function buildDubbingListInput(_flags: DubbingIdFlags): {
  operationId: string;
  input: AgentInput;
} {
  return { operationId: "list_dubs", input: {} };
}

export function registerDubbingCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const dubbing = program.command("dubbing").description("Dubbing");
  addCommonFlags(
    dubbing
      .command("create")
      .description("Create a dubbing project")
      .option("--file <path>", "source video or audio file to dub")
      .option("--source <code>", "source language code")
      .option("--target <code>", "target language code")
      .option("--name <name>", "dubbing project name")
      .option("--wait", "poll until dubbing completes")
      .action(async (options: DubbingCreateFlags, command: Command) => {
        try {
          const opts = runOpts(command);
          const built = buildDubbingCreateInput(options);
          const env = await runOperation(built.operationId, built.input, opts);
          if (!options.wait || !env.ok) emit(env);
          await waitForDubbing(env, opts);
        } catch (error) {
          emitAndExit(
            validationError(commandName(command), message(error)),
            ExitCode.InputValidation,
          );
        }
      }),
  );
  addCommonFlags(
    dubbing
      .command("get")
      .description("Get dubbing project metadata")
      .option("--id <id>", "dubbing project id")
      .action((options: DubbingIdFlags, command: Command) =>
        runBuilt(buildDubbingGetInput, options, command),
      ),
  );
  addCommonFlags(
    dubbing
      .command("audio")
      .description("Download dubbed audio")
      .option("--id <id>", "dubbing project id")
      .option("--language <code>", "target language code for dubbed audio")
      .action((options: DubbingIdFlags, command: Command) =>
        runBuilt(buildDubbingAudioInput, options, command),
      ),
  );
  addCommonFlags(
    addPaginationFlags(dubbing.command("list"))
      .description("List dubbing projects")
      .action((options: DubbingIdFlags, command: Command) =>
        runBuilt(buildDubbingListInput, options, command),
      ),
  );
}

async function waitForDubbing(env: Envelope, opts: RunOpts): Promise<never> {
  const id = stringAt(env, ["dubbing_id", "id"]);
  if (!id)
    emitAndExit(
      validationError("elv dubbing create", "--wait could not find a dubbing id in the response"),
      ExitCode.InputValidation,
    );
  const result = await waitForOperation(
    {
      operation: "get_dubbed_metadata",
      json: JSON.stringify({ path: { dubbing_id: id } }),
      statusPath: "$.data.status",
      success: "dubbed",
      failure: "failed",
    },
    { runOperation: (operationId, input) => runOperation(operationId, input, opts) },
  );
  emitAndExit(result.env, result.exitCode);
}

async function runBuilt<T>(
  builder: (flags: T) => { operationId: string; input: AgentInput },
  flags: T,
  command: Command,
): Promise<never> {
  try {
    const built = builder(flags);
    const { fields, fetch } = resolveListOpts(command);
    const env = await runOperation(built.operationId, built.input, {
      ...runOpts(command),
      ...fetch,
    });
    emit(fields && env.ok ? projectFields(env, fields) : env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function stringAt(env: Envelope, keys: string[]): string | null {
  if (!env.ok || !env.data || typeof env.data !== "object") return null;
  const data = env.data as Record<string, unknown>;
  for (const key of keys) if (typeof data[key] === "string") return data[key];
  return null;
}
