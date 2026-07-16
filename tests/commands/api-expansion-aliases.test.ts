import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  buildAgentRagQueryInput,
  buildAgentTestRunsGetInput,
  buildAgentTestRunsListInput,
  buildAgentTestRunsResubmitInput,
  buildAgentTestsCreateInput,
  buildAgentTestsDeleteInput,
  buildAgentTestsGetInput,
  buildAgentTestsListInput,
  buildAgentTestsRunInput,
  buildAgentTestsUpdateInput,
} from "../../src/commands/aliases/agents";
import {
  buildDubbingTargetTranscriptGetInput,
  buildDubbingTargetTranscriptRegenerateInput,
  buildDubbingTargetTranscriptUpdateSegmentInput,
  buildDubbingTranscriptAddSegmentInput,
  buildDubbingTranscriptDeleteSegmentInput,
  buildDubbingTranscriptGetInput,
  buildDubbingTranscriptUpdateSegmentInput,
} from "../../src/commands/aliases/dubbing-project";
import { registerAliases } from "../../src/commands/aliases/index";
import { buildMusicInput } from "../../src/commands/aliases/music";
import { resolveTtsModel } from "../../src/commands/aliases/tts";
import {
  buildServiceAccountCreateInput,
  buildServiceAccountsListInput,
  buildWorkspaceMembersListInput,
} from "../../src/commands/aliases/workspace";
import { loadRegistry } from "../../src/openapi/registry";
import { errorRecord, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";

describe("current API workflow aliases", () => {
  it("builds detailed Music SSE input", () => {
    expect(
      buildMusicInput({
        detailed: true,
        prompt: "Jazz trio",
        model: "music_v2",
        lengthMs: "30000",
        timestamps: true,
        format: "mp3_44100_128",
      }),
    ).toEqual({
      operationId: "compose_detailed_stream",
      input: {
        query: { output_format: "mp3_44100_128" },
        body: {
          prompt: "Jazz trio",
          model_id: "music_v2",
          music_length_ms: 30000,
          with_timestamps: true,
        },
      },
    });
  });

  it("builds agent test and RAG inputs", () => {
    expect(buildAgentTestsListInput({ search: "refund" })).toEqual({
      operationId: "list_chat_response_tests_route",
      input: { query: { search: "refund" } },
    });
    expect(buildAgentTestsGetInput({ testId: "test_1" })).toEqual({
      operationId: "get_agent_response_test_route",
      input: { path: { test_id: "test_1" } },
    });
    expect(buildAgentTestsCreateInput({ json: '{"name":"Refund"}' })).toEqual({
      operationId: "create_agent_response_test_route",
      input: { body: { name: "Refund" } },
    });
    expect(buildAgentTestsUpdateInput({ testId: "test_1", json: '{"name":"Returns"}' })).toEqual({
      operationId: "update_agent_response_test_route",
      input: { path: { test_id: "test_1" }, body: { name: "Returns" } },
    });
    expect(buildAgentTestsDeleteInput({ testId: "test_1" })).toEqual({
      operationId: "delete_chat_response_test_route",
      input: { path: { test_id: "test_1" } },
    });
    expect(buildAgentTestsRunInput({ agentId: "agent_1", json: '{"tests":[]}' })).toEqual({
      operationId: "run_agent_test_suite_route",
      input: { path: { agent_id: "agent_1" }, body: { tests: [] } },
    });
    expect(buildAgentTestRunsListInput({ agentId: "agent_1" })).toEqual({
      operationId: "list_test_invocations_route",
      input: { query: { agent_id: "agent_1" } },
    });
    expect(buildAgentTestRunsGetInput({ invocationId: "inv_1" })).toEqual({
      operationId: "get_test_invocation_route",
      input: { path: { test_invocation_id: "inv_1" } },
    });
    expect(
      buildAgentTestRunsResubmitInput({
        invocationId: "inv_1",
        json: '{"test_run_ids":["run_1"],"agent_id":"agent_1"}',
      }),
    ).toEqual({
      operationId: "resubmit_tests_route",
      input: {
        path: { test_invocation_id: "inv_1" },
        body: { test_run_ids: ["run_1"], agent_id: "agent_1" },
      },
    });
    expect(
      buildAgentRagQueryInput({ agentId: "agent_1", query: "Refund?", branchId: "branch_1" }),
    ).toEqual({
      operationId: "query_agent_knowledge_base_rag_route",
      input: {
        path: { agent_id: "agent_1" },
        query: { branch_id: "branch_1" },
        body: { query: "Refund?" },
      },
    });
  });

  it("builds workspace inputs and keeps typed name authoritative", () => {
    expect(buildWorkspaceMembersListInput()).toEqual({
      operationId: "get_workspace_members",
      input: {},
    });
    expect(buildServiceAccountsListInput()).toEqual({
      operationId: "get_workspace_service_accounts",
      input: {},
    });
    expect(
      buildServiceAccountCreateInput({ name: "CI", json: '{"name":"ignored","x":1}' }),
    ).toEqual({
      operationId: "create_service_account",
      input: { body: { name: "CI", x: 1 } },
    });
  });

  it("builds source and target Dubbing Project transcript inputs", () => {
    expect(buildDubbingTranscriptGetInput({ projectId: "project_1" })).toEqual({
      operationId: "dubbing_transcript_get",
      input: { path: { project_id: "project_1" } },
    });
    expect(
      buildDubbingTranscriptAddSegmentInput({
        projectId: "project_1",
        json: '{"text":"Hi","speaker_id":"s1","start_s":0,"end_s":1}',
      }),
    ).toEqual({
      operationId: "dubbing_transcript_segment_add",
      input: {
        path: { project_id: "project_1" },
        body: { text: "Hi", speaker_id: "s1", start_s: 0, end_s: 1 },
      },
    });
    expect(
      buildDubbingTranscriptUpdateSegmentInput({
        projectId: "project_1",
        segmentId: "segment_1",
        json: '{"text":"Hello"}',
      }),
    ).toEqual({
      operationId: "dubbing_transcript_segment_update",
      input: {
        path: { project_id: "project_1", segment_id: "segment_1" },
        body: { text: "Hello" },
      },
    });
    expect(
      buildDubbingTranscriptDeleteSegmentInput({ projectId: "project_1", segmentId: "segment_1" }),
    ).toEqual({
      operationId: "dubbing_transcript_segment_delete",
      input: { path: { project_id: "project_1", segment_id: "segment_1" } },
    });
    expect(
      buildDubbingTargetTranscriptGetInput({ projectId: "project_1", languageId: "es" }),
    ).toEqual({
      operationId: "dubbing_target_transcript_get",
      input: { path: { project_id: "project_1", language_id: "es" } },
    });
    expect(
      buildDubbingTargetTranscriptUpdateSegmentInput({
        projectId: "project_1",
        languageId: "es",
        segmentId: "segment_1",
        json: '{"translation":"Hola"}',
      }),
    ).toEqual({
      operationId: "dubbing_target_transcript_segment_update",
      input: {
        path: { project_id: "project_1", language_id: "es", segment_id: "segment_1" },
        body: { translation: "Hola" },
      },
    });
    expect(
      buildDubbingTargetTranscriptRegenerateInput({ projectId: "project_1", languageId: "es" }),
    ).toEqual({
      operationId: "dubbing_target_transcript_regenerate",
      input: { path: { project_id: "project_1", language_id: "es" } },
    });
  });

  it("rejects conflicting JSON sources before reading either", () => {
    expect(() => buildAgentTestsCreateInput({ json: "{}", jsonFile: "/does/not/matter" })).toThrow(
      "Use --json or --json-file, not both",
    );
    expect(() =>
      buildDubbingTranscriptAddSegmentInput({
        projectId: "project_1",
        json: "{}",
        jsonFile: "/does/not/matter",
      }),
    ).toThrow("Use --json or --json-file, not both");
  });

  it("registers new top-level aliases", () => {
    const program = new Command();
    registerAliases(program, (command) => command);
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["workspace", "dubbing-project"]),
    );
  });

  it("targets callable operations in the pinned registry", async () => {
    const registry = await loadRegistry();
    for (const operationId of [
      "compose_detailed_stream",
      "list_chat_response_tests_route",
      "get_agent_response_test_route",
      "create_agent_response_test_route",
      "update_agent_response_test_route",
      "delete_chat_response_test_route",
      "run_agent_test_suite_route",
      "list_test_invocations_route",
      "get_test_invocation_route",
      "resubmit_tests_route",
      "query_agent_knowledge_base_rag_route",
      "get_workspace_members",
      "get_workspace_service_accounts",
      "create_service_account",
      "dubbing_transcript_get",
      "dubbing_transcript_segment_add",
      "dubbing_transcript_segment_update",
      "dubbing_transcript_segment_delete",
      "dubbing_target_transcript_get",
      "dubbing_target_transcript_segment_update",
      "dubbing_target_transcript_regenerate",
    ]) {
      expect(registry.has(operationId), operationId).toBe(true);
    }
  });

  it("uses the TTS profile default only when no explicit model is present", () => {
    expect(resolveTtsModel(undefined, "eleven_flash_v2_5")).toBe("eleven_flash_v2_5");
    expect(resolveTtsModel("eleven_v3", "eleven_flash_v2_5")).toBe("eleven_v3");
  });

  it("keeps new mutations gated and command errors in one JSON envelope", async () => {
    const serviceAccount = await runCli([
      "workspace",
      "service-accounts",
      "create",
      "--name",
      "CI",
    ]);
    expect(serviceAccount.code).toBe(4);
    const serviceAccountEnvelope = parseEnvelope(serviceAccount.stdout);
    expect(serviceAccountEnvelope.cmd).toBe("elv workspace service-accounts create");
    expect(errorRecord(serviceAccountEnvelope).code).toBe("confirmation");
    expect(serviceAccountEnvelope.hints).toEqual([
      expect.objectContaining({ cmd: "elv workspace service-accounts create --dry-run" }),
    ]);

    const deleteSegment = await runCli([
      "dubbing-project",
      "transcript",
      "delete-segment",
      "--project-id",
      "project_1",
      "--segment-id",
      "segment_1",
    ]);
    expect(deleteSegment.code).toBe(4);
    expect(errorRecord(parseEnvelope(deleteSegment.stdout)).code).toBe("confirmation");

    const conflict = await runCli([
      "agents",
      "tests",
      "create",
      "--json",
      "{}",
      "--json-file",
      "/does/not/matter",
      "--dry-run",
    ]);
    expect(conflict.code).toBe(2);
    expect(errorRecord(parseEnvelope(conflict.stdout)).message).toContain("--json or --json-file");
  });

  it("dry-runs polymorphic request schemas with nested document refs", async () => {
    const agentTest = await runCli([
      "agents",
      "tests",
      "create",
      "--json",
      '{"name":"Refund"}',
      "--dry-run",
    ]);
    expect(agentTest.code).toBe(0);
    expect(parseEnvelope(agentTest.stdout)).toMatchObject({
      ok: true,
      cmd: "elv agents tests create",
      operation_id: "create_agent_response_test_route",
    });

    const authConnection = await runCli([
      "call",
      "create_auth_connection",
      "--json",
      '{"body":{"name":"CI OAuth","auth_type":"oauth2_client_credentials","provider":"custom","client_id":"client","token_url":"https://example.test/token","client_secret":"secret"}}',
      "--dry-run",
    ]);
    expect(authConnection.code).toBe(0);
    expect(parseEnvelope(authConnection.stdout)).toMatchObject({
      ok: true,
      operation_id: "create_auth_connection",
    });
  });

  it("includes Music prompt in detailed-stream dry-run", async () => {
    const result = await runCli([
      "music",
      "detailed-stream",
      "--prompt",
      "Jazz trio",
      "--timestamps",
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    const data = recordValue(envelope.data);
    const request = recordValue(data.request);
    const input = recordValue(request.input);
    expect(recordValue(input.body)).toMatchObject({ prompt: "Jazz trio", with_timestamps: true });
  });

  it("marks the compatibility simulation alias deprecated in dry-run results", async () => {
    const result = await runCli([
      "agents",
      "simulate",
      "--agent-id",
      "agent_1",
      "--text",
      "Hi",
      "--dry-run",
    ]);
    expect(result.code).toBe(0);
    const warnings = parseEnvelope(result.stdout).warnings as Array<Record<string, unknown>>;
    expect(warnings).toEqual([expect.objectContaining({ code: "deprecated_operation" })]);
  });
});
