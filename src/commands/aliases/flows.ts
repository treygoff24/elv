import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { numberValue } from "../options";
import {
  addPaginationFlags,
  addWaitFlags,
  aliasRunOpts,
  compact,
  compactInput,
  emit,
  readJsonBody,
  required,
  runAlias,
  runListAlias,
  validationOrExit,
  waitAfterCreate,
  waitTiming,
  type BuiltOperation,
  type JsonBodyFlags,
  type WaitFlags,
} from "./shared";

type FlowKind = "image" | "video" | "speech";

interface FlowFlags extends JsonBodyFlags, WaitFlags {
  model?: string;
  prompt?: string;
  text?: string;
  textFile?: string;
  voiceId?: string;
  format?: string;
  generationId?: string;
  cursor?: string;
  pageSize?: string | number;
  status?: string;
}

const operationKinds = { image: "image", video: "video", speech: "text_to_speech" } as const;

export function buildFlowCreateInput(kind: FlowKind, flags: FlowFlags): BuiltOperation {
  if (flags.text !== undefined && flags.textFile !== undefined)
    throw new Error("Use --text or --text-file, not both");
  const body = readJsonBody(flags, false);
  const text = flags.textFile === undefined ? flags.text : readFileSync(flags.textFile, "utf8");
  return {
    operationId: `create_${operationKinds[kind]}_generation`,
    input: {
      body: {
        ...body,
        ...compact({
          model_id: flags.model,
          prompt: flags.prompt,
          text,
          voice: flags.voiceId,
          output_format: flags.format,
        }),
      },
    },
  };
}

export function buildFlowListInput(kind: FlowKind, flags: FlowFlags): BuiltOperation {
  const pageSize = numberValue(flags.pageSize);
  return {
    operationId: `list_${operationKinds[kind]}_generations`,
    input: compactInput({
      query: compact({
        cursor: flags.cursor,
        page_size: pageSize,
        status: flags.status,
        model_id: flags.model,
      }),
    }),
  };
}

export function buildFlowGetInput(kind: FlowKind, flags: FlowFlags): BuiltOperation {
  return {
    operationId: `get_${operationKinds[kind]}_generation`,
    input: { path: { generation_id: required(flags.generationId, "--generation-id") } },
  };
}

export function registerFlowsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const flows = program
    .command("flows")
    .description("Asynchronous image, video, and speech generation");
  for (const kind of ["image", "video", "speech"] as const) {
    const family = flows.command(kind).description(`Flows ${kind} generations`);
    const create = family
      .command("create")
      .description("Start a generation; use get with the returned id to check its status")
      .option("--model <id>", "generation model id (or model_id in JSON)")
      .option("--json <json>", "request body JSON; explicit flags override matching fields")
      .option("--json-file <path>", "request body JSON file");
    addWaitFlags(create, "poll until the generation completes or fails");
    if (kind === "speech") {
      create
        .option("--text <text>", "text to synthesize")
        .option("--text-file <path>", "read text from a UTF-8 file")
        .option("--voice-id <id>", "voice id")
        .option("--format <format>", "audio output format");
    } else {
      create.option("--prompt <text>", "generation prompt");
    }
    addCommonFlags(create).action(async (options: FlowFlags, command: Command) => {
      // Poll bounds are validated before the request: a bad --timeout-ms must not
      // reject a generation that has already been submitted and charged.
      const { built, opts, timing } = validationOrExit(command, () => ({
        built: buildFlowCreateInput(kind, options),
        opts: aliasRunOpts(command),
        timing: waitTiming(options),
      }));
      const env = await runOperation(built.operationId, built.input, opts);
      if (!options.wait || opts.dryRun || !env.ok) emit(env);
      await waitAfterCreate(env, opts, {
        commandName: `elv flows ${kind} create`,
        idKeys: ["id"],
        missingIdMessage: "--wait could not find a generation id in the response",
        operation: `get_${operationKinds[kind]}_generation`,
        pathKey: "generation_id",
        statusPath: "$.data.status",
        success: "completed",
        failure: "failed",
        timing,
        repollCommand: (id) => `elv flows ${kind} get --generation-id ${id}`,
      });
    });
    addCommonFlags(
      addPaginationFlags(family.command("list"))
        .description("List generations, newest first")
        .option("--cursor <cursor>", "resume from a previous next_cursor")
        .option("--page-size <n>", "page size (1-100)")
        .option("--status <status>", "pending, generating, completed, or failed")
        .option("--model <id>", "filter by model id"),
    ).action((options: FlowFlags, command: Command) =>
      runListAlias((flags: FlowFlags) => buildFlowListInput(kind, flags), options, command),
    );
    addCommonFlags(
      family
        .command("get")
        .description("Get generation status and its result when complete")
        .option("--generation-id <id>", "generation id returned by create or list"),
    ).action((options: FlowFlags, command: Command) =>
      runAlias((flags: FlowFlags) => buildFlowGetInput(kind, flags), options, command),
    );
  }
}
