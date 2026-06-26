import { readFileSync } from "node:fs";
import type { Command } from "commander";
import type { AgentInput } from "../../core/types";
import { addPaginationFlags, compact, compactInput, required, runListAlias } from "./shared";

export interface AgentsFlags {
  agentId?: string;
  json?: string;
  jsonFile?: string;
  text?: string;
  search?: string;
}

export function buildAgentsListInput(flags: AgentsFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "get_agents_route",
    input: compactInput({ query: compact({ search: flags.search }) }),
  };
}

export function buildAgentsGetInput(flags: AgentsFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "get_agent_route",
    input: { path: { agent_id: required(flags.agentId, "--agent-id") } },
  };
}

export function buildAgentsCreateInput(flags: AgentsFlags): {
  operationId: string;
  input: AgentInput;
} {
  return { operationId: "create_agent_route", input: { body: readJson(flags) } };
}

export function buildAgentsUpdateInput(flags: AgentsFlags): {
  operationId: string;
  input: AgentInput;
} {
  return {
    operationId: "patch_agent_settings_route",
    input: { path: { agent_id: required(flags.agentId, "--agent-id") }, body: readJson(flags) },
  };
}

export function buildAgentsSimulateInput(flags: AgentsFlags): {
  operationId: string;
  input: AgentInput;
} {
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
        runBuilt(buildAgentsListInput, options, command),
      ),
  );
  addCommonFlags(
    agents
      .command("get")
      .description("Get an agent by id")
      .option("--agent-id <id>", "conversational agent id")
      .action((options: AgentsFlags, command: Command) =>
        runBuilt(buildAgentsGetInput, options, command),
      ),
  );
  addCommonFlags(
    agents
      .command("create")
      .description("Create an agent from a JSON config")
      .option("--json <json>", "agent configuration JSON")
      .option("--json-file <path>", "agent configuration JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runBuilt(buildAgentsCreateInput, options, command),
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
        runBuilt(buildAgentsUpdateInput, options, command),
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
        runBuilt(buildAgentsSimulateInput, options, command),
      ),
  );
}

async function runBuilt<T>(
  builder: (flags: T) => { operationId: string; input: AgentInput },
  flags: T,
  command: Command,
): Promise<never> {
  return runListAlias(builder, flags, command, { mergeOptions: true });
}

function readJson(flags: AgentsFlags): Record<string, unknown> {
  if (flags.json !== undefined && flags.jsonFile !== undefined)
    throw new Error("Use --json or --json-file, not both");
  const raw = flags.jsonFile !== undefined ? readFileSync(flags.jsonFile, "utf8") : flags.json;
  if (raw === undefined) throw new Error("--json or --json-file is required");
  const parsed = JSON.parse(raw) as unknown;
  if (isRecord(parsed)) return parsed;
  throw new Error("JSON must be an object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
