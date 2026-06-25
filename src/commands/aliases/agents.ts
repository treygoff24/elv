import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { runOperation } from "../../core/client";
import { emitAndExit, exitCodeForError, validationError } from "../../core/errors";
import { ExitCode } from "../../core/types";
import type { AgentInput, Envelope, RunOpts } from "../../core/types";

export interface AgentsFlags {
  agentId?: string;
  json?: string;
  jsonFile?: string;
  text?: string;
  limit?: string | number;
  search?: string;
}

export function buildAgentsListInput(flags: AgentsFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_agents_route", input: compactInput({ query: compact({ page_size: numberValue(flags.limit), search: flags.search }) }) };
}

export function buildAgentsGetInput(flags: AgentsFlags): { operationId: string; input: AgentInput } {
  return { operationId: "get_agent_route", input: { path: { agent_id: required(flags.agentId, "--agent-id") } } };
}

export function buildAgentsCreateInput(flags: AgentsFlags): { operationId: string; input: AgentInput } {
  return { operationId: "create_agent_route", input: { body: readJson(flags) } };
}

export function buildAgentsUpdateInput(flags: AgentsFlags): { operationId: string; input: AgentInput } {
  return { operationId: "patch_agent_settings_route", input: { path: { agent_id: required(flags.agentId, "--agent-id") }, body: readJson(flags) } };
}

export function buildAgentsSimulateInput(flags: AgentsFlags): { operationId: string; input: AgentInput } {
  return {
    operationId: "run_conversation_simulation_route",
    input: { path: { agent_id: required(flags.agentId, "--agent-id") }, body: flags.json || flags.jsonFile ? readJson(flags) : { simulation_specification: { first_message: required(flags.text, "--text") } } },
  };
}

export function registerAgentsCommand(program: Command, addCommonFlags: (command: Command) => Command): void {
  const agents = program.command("agents").description("Conversational AI agents");
  addCommonFlags(agents.command("list").option("--limit <n>").option("--search <query>").action((options: AgentsFlags, command: Command) => runBuilt(buildAgentsListInput, options, command)));
  addCommonFlags(agents.command("get").option("--agent-id <id>").action((options: AgentsFlags, command: Command) => runBuilt(buildAgentsGetInput, options, command)));
  addCommonFlags(agents.command("create").option("--json-file <path>").action((options: AgentsFlags, command: Command) => runBuilt(buildAgentsCreateInput, options, command)));
  addCommonFlags(agents.command("update").option("--agent-id <id>").option("--json-file <path>").action((options: AgentsFlags, command: Command) => runBuilt(buildAgentsUpdateInput, options, command)));
  addCommonFlags(agents.command("simulate").option("--agent-id <id>").option("--text <text>").option("--json-file <path>").action((options: AgentsFlags, command: Command) => runBuilt(buildAgentsSimulateInput, options, command)));
}

async function runBuilt<T>(builder: (flags: T) => { operationId: string; input: AgentInput }, flags: T, command: Command): Promise<never> {
  try {
    const built = builder({ ...(mergedOptions(command) as T), ...flags });
    const env = await runOperation(built.operationId, built.input, runOpts(command));
    emit(env);
  } catch (error) {
    emitAndExit(validationError(commandName(command), message(error)), ExitCode.InputValidation);
  }
}

function readJson(flags: AgentsFlags): Record<string, unknown> {
  if (flags.json !== undefined && flags.jsonFile !== undefined) throw new Error("Use --json or --json-file, not both");
  const raw = flags.jsonFile !== undefined ? readFileSync(flags.jsonFile, "utf8") : flags.json;
  if (raw === undefined) throw new Error("--json or --json-file is required");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON must be an object");
  return parsed as Record<string, unknown>;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected number, got ${value}`);
  return parsed;
}

function compact(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function compactInput(input: AgentInput): AgentInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as AgentInput;
}

function runOpts(command: Command): RunOpts {
  const opts = mergedOptions(command);
  return {
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    retryPost: Boolean(opts.retryPost),
    hash: Boolean(opts.hash),
    out: optionString(opts.out),
    baseUrl: optionString(opts.baseUrl),
    profile: optionString(opts.profile),
    maxCredits: numberValue(optionString(opts.maxCredits)),
  };
}

function mergedOptions(command: Command): Record<string, unknown> {
  const chain: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent) chain.unshift(current);
  return Object.assign({}, ...chain.map((current) => current.opts()));
}

function optionString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function commandName(command: Command): string {
  return `elv ${command.name()}`;
}

function emit(env: Envelope): never {
  emitAndExit(env, env.ok ? ExitCode.Success : exitCodeForError(env.error, env.http?.status ?? undefined));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
