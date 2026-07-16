import type { Command } from "commander";
import {
  readJsonBody,
  required,
  runAlias,
  type BuiltOperation,
  type JsonBodyFlags,
} from "./shared";

interface ServiceAccountFlags extends JsonBodyFlags {
  name?: string;
}

export function buildWorkspaceMembersListInput(): BuiltOperation {
  return { operationId: "get_workspace_members", input: {} };
}

export function buildServiceAccountsListInput(): BuiltOperation {
  return { operationId: "get_workspace_service_accounts", input: {} };
}

export function buildServiceAccountCreateInput(flags: ServiceAccountFlags): BuiltOperation {
  return {
    operationId: "create_service_account",
    input: { body: { ...readJsonBody(flags, false), name: required(flags.name, "--name") } },
  };
}

export function registerWorkspaceCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const workspace = program.command("workspace").description("Workspace members and accounts");
  addCommonFlags(
    workspace
      .command("members")
      .description("Workspace members")
      .command("list")
      .description("List human workspace members")
      .action((_options: Record<string, never>, command: Command) =>
        runAlias(buildWorkspaceMembersListInput, {}, command),
      ),
  );

  const serviceAccounts = workspace
    .command("service-accounts")
    .description("Workspace service accounts");
  addCommonFlags(
    serviceAccounts
      .command("list")
      .description("List workspace service accounts")
      .action((_options: Record<string, never>, command: Command) =>
        runAlias(buildServiceAccountsListInput, {}, command),
      ),
  );
  addCommonFlags(
    serviceAccounts
      .command("create")
      .description("Create a service account (requires --yes)")
      .option("--name <name>", "service account name")
      .option("--json <json>", "additional service-account fields as JSON")
      .option("--json-file <path>", "additional service-account fields JSON file")
      .action((options: ServiceAccountFlags, command: Command) =>
        runAlias(buildServiceAccountCreateInput, options, command),
      ),
  );
}
