import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { parseJsonRecord } from "../../util/json";
import {
  addPaginationFlags,
  compact,
  compactInput,
  required,
  runListAlias,
  type BuiltOperation,
} from "./shared";

export interface AgentsFlags {
  agentId?: string;
  json?: string;
  jsonFile?: string;
  text?: string;
  search?: string;
}

export function buildAgentsListInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "get_agents_route",
    input: compactInput({ query: compact({ search: flags.search }) }),
  };
}

export function buildAgentsGetInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "get_agent_route",
    input: { path: { agent_id: required(flags.agentId, "--agent-id") } },
  };
}

export function buildAgentsCreateInput(flags: AgentsFlags): BuiltOperation {
  return { operationId: "create_agent_route", input: { body: readJson(flags) } };
}

export function buildAgentsUpdateInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "patch_agent_settings_route",
    input: { path: { agent_id: required(flags.agentId, "--agent-id") }, body: readJson(flags) },
  };
}

export function buildAgentsSimulateInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "run_conversation_simulation_route",
    input: {
      path: { agent_id: required(flags.agentId, "--agent-id") },
      body:
        flags.json || flags.jsonFile
          ? readJson(flags)
          : { simulation_specification: { first_message: required(flags.text, "--text") } },
    },
  };
}

export function registerAgentsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const agents = program.command("agents").description("Conversational AI agents");
  addCommonFlags(
    addPaginationFlags(agents.command("list"))
      .description("List conversational agents")
      .option("--search <query>", "filter agents by search query")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentsListInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    agents
      .command("get")
      .description("Get an agent by id")
      .option("--agent-id <id>", "conversational agent id")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentsGetInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    agents
      .command("create")
      .description("Create an agent from a JSON config")
      .option("--json <json>", "agent configuration JSON")
      .option("--json-file <path>", "agent configuration JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentsCreateInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    agents
      .command("update")
      .description("Update an agent's settings")
      .option("--agent-id <id>", "conversational agent id")
      .option("--json <json>", "partial agent settings JSON")
      .option("--json-file <path>", "partial agent settings JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentsUpdateInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    agents
      .command("simulate")
      .description("Run a conversation simulation")
      .option("--agent-id <id>", "conversational agent id")
      .option("--text <text>", "first user message for a simple simulation")
      .option("--json <json>", "full simulation specification JSON")
      .option("--json-file <path>", "full simulation specification JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentsSimulateInput, options, command, { mergeOptions: true }),
      ),
  );
}

function readJson(flags: AgentsFlags): Record<string, unknown> {
  if (flags.json !== undefined && flags.jsonFile !== undefined)
    throw new Error("Use --json or --json-file, not both");
  const raw = flags.jsonFile !== undefined ? readFileSync(flags.jsonFile, "utf8") : flags.json;
  if (raw === undefined) throw new Error("--json or --json-file is required");
  return parseJsonRecord(raw, "JSON", "JSON must be an object");
}
