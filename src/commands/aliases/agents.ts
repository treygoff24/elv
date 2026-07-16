import type { Command } from "commander";
import {
  addPaginationFlags,
  compact,
  compactInput,
  readJsonBody,
  required,
  runAlias,
  runListAlias,
  type BuiltOperation,
} from "./shared";

interface AgentsFlags {
  agentId?: string;
  json?: string;
  jsonFile?: string;
  text?: string;
  search?: string;
  testId?: string;
  invocationId?: string;
  branchId?: string;
  query?: string;
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
  return { operationId: "create_agent_route", input: { body: readJsonBody(flags) } };
}

export function buildAgentsUpdateInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "patch_agent_settings_route",
    input: {
      path: { agent_id: required(flags.agentId, "--agent-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildAgentsSimulateInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "run_conversation_simulation_route",
    input: {
      path: { agent_id: required(flags.agentId, "--agent-id") },
      body:
        flags.json !== undefined || flags.jsonFile !== undefined
          ? readJsonBody(flags)
          : {
              simulation_specification: {
                simulated_user_config: { first_message: required(flags.text, "--text") },
              },
            },
    },
  };
}

export function buildAgentTestsListInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "list_chat_response_tests_route",
    input: compactInput({ query: compact({ search: flags.search }) }),
  };
}

export function buildAgentTestsGetInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "get_agent_response_test_route",
    input: { path: { test_id: required(flags.testId, "--test-id") } },
  };
}

export function buildAgentTestsCreateInput(flags: AgentsFlags): BuiltOperation {
  return { operationId: "create_agent_response_test_route", input: { body: readJsonBody(flags) } };
}

export function buildAgentTestsUpdateInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "update_agent_response_test_route",
    input: {
      path: { test_id: required(flags.testId, "--test-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildAgentTestsDeleteInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "delete_chat_response_test_route",
    input: { path: { test_id: required(flags.testId, "--test-id") } },
  };
}

export function buildAgentTestsRunInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "run_agent_test_suite_route",
    input: {
      path: { agent_id: required(flags.agentId, "--agent-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildAgentTestRunsListInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "list_test_invocations_route",
    input: compactInput({ query: compact({ agent_id: flags.agentId }) }),
  };
}

export function buildAgentTestRunsGetInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "get_test_invocation_route",
    input: {
      path: { test_invocation_id: required(flags.invocationId, "--invocation-id") },
    },
  };
}

export function buildAgentTestRunsResubmitInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "resubmit_tests_route",
    input: {
      path: { test_invocation_id: required(flags.invocationId, "--invocation-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildAgentRagQueryInput(flags: AgentsFlags): BuiltOperation {
  return {
    operationId: "query_agent_knowledge_base_rag_route",
    input: compactInput({
      path: { agent_id: required(flags.agentId, "--agent-id") },
      query: compact({ branch_id: flags.branchId }),
      body: { query: required(flags.query, "--query") },
    }),
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
  const tests = agents.command("tests").description("Agent response tests");
  addCommonFlags(
    addPaginationFlags(tests.command("list"))
      .description("List agent response tests")
      .option("--search <query>", "filter tests by name")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentTestsListInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    tests
      .command("get")
      .description("Get an agent response test")
      .option("--test-id <id>", "agent response test id")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestsGetInput, options, command),
      ),
  );
  addCommonFlags(
    tests
      .command("create")
      .description("Create an agent response test from JSON")
      .option("--json <json>", "test request JSON")
      .option("--json-file <path>", "test request JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestsCreateInput, options, command),
      ),
  );
  addCommonFlags(
    tests
      .command("update")
      .description("Update an agent response test from JSON")
      .option("--test-id <id>", "agent response test id")
      .option("--json <json>", "test update JSON")
      .option("--json-file <path>", "test update JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestsUpdateInput, options, command),
      ),
  );
  addCommonFlags(
    tests
      .command("delete")
      .description("Delete an agent response test")
      .option("--test-id <id>", "agent response test id")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestsDeleteInput, options, command),
      ),
  );
  addCommonFlags(
    tests
      .command("run")
      .description("Run selected tests on an agent")
      .option("--agent-id <id>", "conversational agent id")
      .option("--json <json>", "test-run request JSON")
      .option("--json-file <path>", "test-run request JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestsRunInput, options, command),
      ),
  );
  const testRuns = agents.command("test-runs").description("Agent test-suite invocations");
  addCommonFlags(
    addPaginationFlags(testRuns.command("list"))
      .description("List test-suite invocations")
      .option("--agent-id <id>", "filter by conversational agent id")
      .action((options: AgentsFlags, command: Command) =>
        runListAlias(buildAgentTestRunsListInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    testRuns
      .command("get")
      .description("Get a test-suite invocation")
      .option("--invocation-id <id>", "test invocation id")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestRunsGetInput, options, command),
      ),
  );
  addCommonFlags(
    testRuns
      .command("resubmit")
      .description("Resubmit selected runs from a test-suite invocation")
      .option("--invocation-id <id>", "test invocation id")
      .option("--json <json>", "resubmission request JSON")
      .option("--json-file <path>", "resubmission request JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentTestRunsResubmitInput, options, command),
      ),
  );
  addCommonFlags(
    agents
      .command("rag-query")
      .description("Run the agent's read-only RAG retrieval for an ad-hoc query")
      .option("--agent-id <id>", "conversational agent id")
      .option("--query <text>", "query to run against the knowledge base")
      .option("--branch-id <id>", "agent branch id")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentRagQueryInput, options, command),
      ),
  );
  addCommonFlags(
    agents
      .command("simulate")
      .description("Deprecated: run a conversation simulation; prefer agents tests create/run")
      .option("--agent-id <id>", "conversational agent id")
      .option("--text <text>", "first user message for a simple simulation")
      .option("--json <json>", "full simulation specification JSON")
      .option("--json-file <path>", "full simulation specification JSON file")
      .action((options: AgentsFlags, command: Command) =>
        runAlias(buildAgentsSimulateInput, options, command),
      ),
  );
}
