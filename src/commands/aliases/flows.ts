import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { numberValue } from "../options";
import type { CliOptionValues } from "../options";
import {
  addPaginationFlags,
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
  validateWaitOptions,
  type BuiltOperation,
  type JsonBodyFlags,
} from "./shared";

type FlowKind = "image" | "video" | "speech";

interface FlowSpec {
  create: string;
  get: string;
  list: string;
  label: string;
}

interface FlowFlags extends JsonBodyFlags, Pick<CliOptionValues, "timeoutMs"> {
  id?: string;
  status?: string;
  modelId?: string;
  cursor?: string;
  wait?: boolean;
}

const FLOWS: Record<FlowKind, FlowSpec> = {
  image: {
    create: "create_image_generation",
    get: "get_image_generation",
    list: "list_image_generations",
    label: "image",
  },
  video: {
    create: "create_video_generation",
    get: "get_video_generation",
    list: "list_video_generations",
    label: "video",
  },
  speech: {
    create: "create_text_to_speech_generation",
    get: "get_text_to_speech_generation",
    list: "list_text_to_speech_generations",
    label: "text-to-speech",
  },
};

export function buildFlowCreateInput(kind: FlowKind, flags: FlowFlags): BuiltOperation {
  return { operationId: FLOWS[kind].create, input: { body: readJsonBody(flags) } };
}

export function buildFlowGetInput(kind: FlowKind, flags: FlowFlags): BuiltOperation {
  return {
    operationId: FLOWS[kind].get,
    input: { path: { generation_id: required(flags.id, "--id") } },
  };
}

export function buildFlowListInput(kind: FlowKind, flags: FlowFlags): BuiltOperation {
  return {
    operationId: FLOWS[kind].list,
    input: compactInput({
      query: compact({
        status: flags.status,
        model_id: flags.modelId,
        cursor: flags.cursor,
      }),
    }),
  };
}

export function registerFlowsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const flows = program.command("flows").description("Asynchronous media generation flows");
  registerFlowFamily(flows, addCommonFlags, "image");
  registerFlowFamily(flows, addCommonFlags, "video");
  registerFlowFamily(flows, addCommonFlags, "speech");
}

function registerFlowFamily(
  parent: Command,
  addCommonFlags: (command: Command) => Command,
  kind: FlowKind,
): void {
  const spec = FLOWS[kind];
  const family = parent.command(kind).description(`${spec.label} generation flows`);
  addCommonFlags(
    family
      .command("create")
      .description(`Create an asynchronous ${spec.label} generation`)
      .option("--json <json>", "generation request JSON")
      .option("--json-file <path>", "generation request JSON file")
      .option("--wait", "poll until the generation completes")
      .option("--timeout-ms <ms>", "maximum wait time when --wait is set")
      .action(async (options: FlowFlags, command: Command) => {
        const opts = validationOrExit(command, () => aliasRunOpts(command));
        const timeoutMs = validationOrExit(command, () => numberValue(options.timeoutMs));
        validationOrExit(command, () => validateWaitOptions(options, timeoutMs));
        const built = validationOrExit(command, () => buildFlowCreateInput(kind, options));
        const env = await runOperation(built.operationId, built.input, opts);
        if (!options.wait || !env.ok) emit(env);
        await waitAfterCreate(env, opts, {
          commandName: `elv flows ${kind} create`,
          idKeys: ["id"],
          missingIdMessage: "--wait could not find a generation id in the response",
          operation: spec.get,
          pathKey: "generation_id",
          statusPath: "$.data.status",
          success: "completed",
          failure: "failed",
          timeoutMs,
        });
      }),
  );
  addCommonFlags(
    family
      .command("get")
      .description(`Get an asynchronous ${spec.label} generation`)
      .option("--id <id>", "generation id")
      .action((options: FlowFlags, command: Command) =>
        runAlias((flags) => buildFlowGetInput(kind, flags), options, command),
      ),
  );
  addCommonFlags(
    addPaginationFlags(family.command("list"))
      .description(`List asynchronous ${spec.label} generations`)
      .option("--status <status>", "filter by lifecycle status")
      .option("--model-id <id>", "filter by generation model id")
      .option("--cursor <cursor>", "pagination cursor from a previous response")
      .action((options: FlowFlags, command: Command) =>
        runListAlias((flags) => buildFlowListInput(kind, flags), options, command, {
          mergeOptions: true,
        }),
      ),
  );
}
