import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  buildAgentProcedureCreateInput,
  buildAgentProcedureDraftDeleteInput,
  buildAgentProcedureDraftGetInput,
  buildAgentProcedureDraftUpdateInput,
  buildAgentProcedureGetInput,
  buildAgentProcedureRemoveInput,
  buildAgentProceduresCompileInput,
  buildAgentProceduresListInput,
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
  buildDubbingTargetTranscriptUpdateSegmentsInput,
  buildDubbingTranscriptAddSegmentInput,
  buildDubbingTranscriptDeleteSegmentInput,
  buildDubbingTranscriptGetInput,
  buildDubbingTranscriptUpdateSegmentInput,
  buildDubbingTranscriptUpdateSegmentsInput,
} from "../../src/commands/aliases/dubbing-project";
import { registerAliases } from "../../src/commands/aliases/index";
import {
  buildMusicFinetuneCreateInput,
  buildMusicFinetuneDeleteInput,
  buildMusicFinetuneGetInput,
  buildMusicFinetunesListInput,
  buildMusicFinetuneUpdateInput,
  buildMusicInput,
} from "../../src/commands/aliases/music";
import {
  buildVoiceAccentsInput,
  buildVoiceReplicationInput,
  buildVoicesListInput,
} from "../../src/commands/aliases/voices";
import {
  buildServiceAccountCreateInput,
  buildServiceAccountsListInput,
  buildWorkspaceMembersListInput,
} from "../../src/commands/aliases/workspace";
import { loadRegistry } from "../../src/openapi/registry";
import { arrayValue, errorRecord, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";

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
        finetuneId: "finetune_1",
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
          finetune_id: "finetune_1",
        },
      },
    });
  });

  it("passes a Music Finetune id through every generation form", () => {
    for (const flags of [{}, { stream: true }, { detailed: true }]) {
      expect(buildMusicInput({ ...flags, finetuneId: "finetune_1" }).input.body).toMatchObject({
        finetune_id: "finetune_1",
      });
    }
  });

  it("builds Music Finetune lifecycle inputs", () => {
    expect(
      buildMusicFinetunesListInput({
        visibility: "workspace",
        createdBy: "self",
        sort: "name",
        sortDirection: "asc",
      }),
    ).toEqual({
      operationId: "get_finetunes",
      input: {
        query: {
          visibility: "workspace",
          created_by: "self",
          sort: "name",
          sort_direction: "asc",
        },
      },
    });
    expect(buildMusicFinetuneGetInput({ finetuneId: "finetune_1" })).toEqual({
      operationId: "get_finetune",
      input: { path: { finetune_id: "finetune_1" } },
    });
    expect(
      buildMusicFinetuneCreateInput({
        name: "My Finetune",
        primaryGenre: "jazz",
        file: ["/tmp/one.wav", "/tmp/two.wav"],
        tag: ["warm", "live"],
        visibility: "workspace",
        model: "music_v2",
      }),
    ).toEqual({
      operationId: "create_finetune",
      input: {
        files: { files: ["/tmp/one.wav", "/tmp/two.wav"] },
        body: {
          name: "My Finetune",
          primary_genre: "jazz",
          tags: ["warm", "live"],
          visibility: "workspace",
          model_id: "music_v2",
        },
      },
    });
    expect(
      buildMusicFinetuneUpdateInput({
        finetuneId: "finetune_1",
        json: '{"name":"Renamed Finetune"}',
      }),
    ).toEqual({
      operationId: "update_finetune",
      input: {
        path: { finetune_id: "finetune_1" },
        body: { name: "Renamed Finetune" },
      },
    });
    expect(buildMusicFinetuneDeleteInput({ finetuneId: "finetune_1" })).toEqual({
      operationId: "delete_finetune",
      input: { path: { finetune_id: "finetune_1" } },
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

  it("builds every Agent Procedures input", () => {
    const branch = { agentId: "agent_1", branchId: "branch_1" };
    const procedure = { ...branch, procedureId: "procedure_1" };
    expect(buildAgentProceduresListInput(branch)).toEqual({
      operationId: "list_procedures_route",
      input: { path: { agent_id: "agent_1", branch_id: "branch_1" } },
    });
    expect(buildAgentProcedureCreateInput(branch)).toEqual({
      operationId: "create_procedure_route",
      input: { path: { agent_id: "agent_1", branch_id: "branch_1" } },
    });
    expect(buildAgentProcedureCreateInput({ ...branch, json: '{"name":"Refund"}' })).toEqual({
      operationId: "create_procedure_route",
      input: {
        path: { agent_id: "agent_1", branch_id: "branch_1" },
        body: { name: "Refund" },
      },
    });
    expect(buildAgentProcedureGetInput({ ...procedure, versionId: "version_1" })).toEqual({
      operationId: "get_procedure_route",
      input: {
        path: {
          agent_id: "agent_1",
          branch_id: "branch_1",
          procedure_id: "procedure_1",
        },
        query: { version_id: "version_1" },
      },
    });
    expect(buildAgentProcedureRemoveInput(procedure)).toEqual({
      operationId: "remove_procedure_route",
      input: {
        path: {
          agent_id: "agent_1",
          branch_id: "branch_1",
          procedure_id: "procedure_1",
        },
      },
    });
    expect(buildAgentProcedureDraftGetInput(procedure)).toEqual({
      operationId: "get_procedure_draft_route",
      input: {
        path: {
          agent_id: "agent_1",
          branch_id: "branch_1",
          procedure_id: "procedure_1",
        },
      },
    });
    expect(
      buildAgentProcedureDraftUpdateInput({ ...procedure, json: '{"name":"Returns"}' }),
    ).toEqual({
      operationId: "update_procedure_draft_route",
      input: {
        path: {
          agent_id: "agent_1",
          branch_id: "branch_1",
          procedure_id: "procedure_1",
        },
        body: { name: "Returns" },
      },
    });
    expect(buildAgentProcedureDraftDeleteInput(procedure)).toEqual({
      operationId: "delete_procedure_draft_route",
      input: {
        path: {
          agent_id: "agent_1",
          branch_id: "branch_1",
          procedure_id: "procedure_1",
        },
      },
    });
    expect(buildAgentProceduresCompileInput(branch)).toEqual({
      operationId: "compile_procedures_route",
      input: { path: { agent_id: "agent_1", branch_id: "branch_1" } },
    });
  });

  it("builds voice discovery, filtering, and replication inputs", () => {
    expect(
      buildVoicesListInput({
        gender: "female",
        age: "young",
        language: ["en", "es"],
        accent: "american",
        useCase: ["conversational", "narrative_story"],
        minNoticePeriodDays: "30",
        customRates: false,
        liveModerated: false,
        highQuality: true,
      }),
    ).toEqual({
      operationId: "get_user_voices_v2",
      input: {
        query: {
          gender: "female",
          age: "young",
          language: ["en", "es"],
          accent: "american",
          use_cases: ["conversational", "narrative_story"],
          min_notice_period_days: 30,
          include_custom_rates: false,
          include_live_moderated: false,
          high_quality: true,
        },
      },
    });
    expect(buildVoicesListInput({})).toEqual({
      operationId: "get_user_voices_v2",
      input: {},
    });
    expect(buildVoiceAccentsInput({ language: "en", modelId: "eleven_v3" })).toEqual({
      operationId: "get_voice_accents",
      input: { query: { language: "en", model_id: "eleven_v3" } },
    });
    expect(
      buildVoiceReplicationInput({
        voiceId: "voice_1",
        targetWorkspaceId: "workspace_1",
        preserveVoiceId: false,
      }),
    ).toEqual({
      operationId: "replicate_voice_to_isolated_environment",
      input: {
        path: { voice_id: "voice_1" },
        body: { target_workspace_id: "workspace_1", preserve_voice_id: false },
      },
    });
    expect(
      buildVoiceReplicationInput({
        voiceId: "voice_1",
        json: '{"target_workspace_id":"workspace_json","preserve_voice_id":true}',
        targetWorkspaceId: "workspace_flag",
        preserveVoiceId: false,
      }),
    ).toEqual({
      operationId: "replicate_voice_to_isolated_environment",
      input: {
        path: { voice_id: "voice_1" },
        body: { target_workspace_id: "workspace_flag", preserve_voice_id: false },
      },
    });
    expect(() => buildVoiceReplicationInput({ voiceId: "voice_1" })).toThrow(
      "--target-workspace-id or JSON target_workspace_id is required",
    );
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
      buildDubbingTranscriptUpdateSegmentsInput({
        projectId: "project_1",
        json: '{"segments":{"segment_1":{"text":"Hello"}}}',
      }),
    ).toEqual({
      operationId: "dubbing_transcript_segments_update",
      input: {
        path: { project_id: "project_1" },
        body: { segments: { segment_1: { text: "Hello" } } },
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
      buildDubbingTargetTranscriptUpdateSegmentsInput({
        projectId: "project_1",
        languageId: "es",
        json: '{"segments":{"segment_1":{"translation":"Hola"}}}',
      }),
    ).toEqual({
      operationId: "dubbing_target_transcript_segments_update",
      input: {
        path: { project_id: "project_1", language_id: "es" },
        body: { segments: { segment_1: { translation: "Hola" } } },
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

    const agents = program.commands.find((command) => command.name() === "agents")!;
    const procedures = agents.commands.find((command) => command.name() === "procedures")!;
    expect(procedures.commands.map((command) => command.name())).toEqual([
      "list",
      "create",
      "get",
      "remove",
      "get-draft",
      "update-draft",
      "delete-draft",
      "compile",
    ]);
    expect(
      procedures.commands
        .find((command) => command.name() === "get")!
        .options.map((option) => option.long),
    ).toEqual(
      expect.arrayContaining(["--agent-id", "--branch-id", "--procedure-id", "--version-id"]),
    );

    const voices = program.commands.find((command) => command.name() === "voices")!;
    expect(voices.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["accents", "replicate"]),
    );
    expect(
      voices.commands
        .find((command) => command.name() === "list")!
        .options.map((option) => option.long),
    ).toEqual(
      expect.arrayContaining([
        "--gender",
        "--age",
        "--language",
        "--accent",
        "--use-case",
        "--min-notice-period-days",
        "--no-custom-rates",
        "--no-live-moderated",
        "--high-quality",
      ]),
    );
    expect(
      voices.commands
        .find((command) => command.name() === "replicate")!
        .options.map((option) => option.long),
    ).toEqual(
      expect.arrayContaining([
        "--voice-id",
        "--target-workspace-id",
        "--no-preserve-voice-id",
        "--json",
        "--json-file",
      ]),
    );

    const dubbingProject = program.commands.find(
      (command) => command.name() === "dubbing-project",
    )!;
    expect(dubbingProject.description()).toContain("Dubbing v2");
    for (const group of ["transcript", "target-transcript"]) {
      expect(
        dubbingProject.commands
          .find((command) => command.name() === group)!
          .commands.map((command) => command.name()),
      ).toContain("update-segments");
    }
  });

  it("targets callable operations in the pinned registry", async () => {
    const registry = await loadRegistry();
    for (const operationId of [
      "compose_detailed_stream",
      "create_finetune",
      "delete_finetune",
      "get_finetune",
      "get_finetunes",
      "update_finetune",
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
      "list_procedures_route",
      "create_procedure_route",
      "get_procedure_route",
      "remove_procedure_route",
      "get_procedure_draft_route",
      "update_procedure_draft_route",
      "delete_procedure_draft_route",
      "compile_procedures_route",
      "get_workspace_members",
      "get_workspace_service_accounts",
      "create_service_account",
      "dubbing_transcript_get",
      "dubbing_transcript_segment_add",
      "dubbing_transcript_segment_update",
      "dubbing_transcript_segments_update",
      "dubbing_transcript_segment_delete",
      "dubbing_target_transcript_get",
      "dubbing_target_transcript_segment_update",
      "dubbing_target_transcript_segments_update",
      "dubbing_target_transcript_regenerate",
      "get_voice_accents",
      "replicate_voice_to_isolated_environment",
      "export_batch_call",
      "get_knowledge_base_bulk_dependent_agents_route",
      "post_knowledge_base_bulk_delete_route",
    ]) {
      expect(registry.has(operationId), operationId).toBe(true);
    }
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

    for (const action of ["remove", "delete-draft"]) {
      const procedure = await runCli([
        "agents",
        "procedures",
        action,
        "--agent-id",
        "agent_1",
        "--branch-id",
        "branch_1",
        "--procedure-id",
        "procedure_1",
      ]);
      expect(procedure.code).toBe(4);
      expect(errorRecord(parseEnvelope(procedure.stdout)).code).toBe("confirmation");
    }

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

  it("preserves replication ids by default and honors --no-preserve-voice-id", async () => {
    const defaultPreview = await runCli([
      "voices",
      "replicate",
      "--voice-id",
      "voice_1",
      "--target-workspace-id",
      "workspace_1",
      "--dry-run",
    ]);
    expect(defaultPreview.code).toBe(0);
    const defaultData = recordValue(parseEnvelope(defaultPreview.stdout).data);
    const defaultInput = recordValue(recordValue(defaultData.request).input);
    expect(recordValue(defaultInput.body)).toEqual({ target_workspace_id: "workspace_1" });
    expect(defaultData.would_require_yes).toBe(true);

    const newIdPreview = await runCli([
      "voices",
      "replicate",
      "--voice-id",
      "voice_1",
      "--target-workspace-id",
      "workspace_1",
      "--no-preserve-voice-id",
      "--dry-run",
    ]);
    expect(newIdPreview.code).toBe(0);
    const newIdInput = recordValue(
      recordValue(recordValue(parseEnvelope(newIdPreview.stdout).data).request).input,
    );
    expect(recordValue(newIdInput.body)).toEqual({
      target_workspace_id: "workspace_1",
      preserve_voice_id: false,
    });
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

  it("dry-runs repeated Music Finetune uploads and gates deletion", async () => {
    const create = await runCli([
      "music",
      "finetunes",
      "create",
      "--name",
      "Test Finetune",
      "--primary-genre",
      "jazz",
      "--file",
      "package.json",
      "--file",
      "package.json",
      "--model",
      "music_v2",
      "--dry-run",
    ]);
    expect(create.code).toBe(0);
    const createInput = recordValue(
      recordValue(recordValue(parseEnvelope(create.stdout).data).request).input,
    );
    expect(recordValue(createInput.files).files).toEqual([
      expect.stringMatching(/package\.json$/u),
      expect.stringMatching(/package\.json$/u),
    ]);
    expect(recordValue(createInput.body)).toMatchObject({
      name: "Test Finetune",
      primary_genre: "jazz",
      model_id: "music_v2",
    });

    const deletion = await runCli(["music", "finetunes", "delete", "--finetune-id", "finetune_1"]);
    expect(deletion.code).toBe(4);
    expect(errorRecord(parseEnvelope(deletion.stdout)).code).toBe("confirmation");
  });

  it("uses configured STT webhooks and env-sourced redacted tokens", async () => {
    const webhook = await runCli([
      "stt",
      "--file",
      "package.json",
      "--model",
      "scribe_v2",
      "--webhook",
      "--webhook-id",
      "webhook_1",
      "--dry-run",
    ]);
    expect(webhook.code).toBe(0);
    const webhookInput = recordValue(
      recordValue(recordValue(parseEnvelope(webhook.stdout).data).request).input,
    );
    expect(recordValue(webhookInput.body)).toMatchObject({
      webhook: true,
      webhook_id: "webhook_1",
    });

    const token = randomUUID();
    const tokenResult = await runCli(
      [
        "stt",
        "--file",
        "package.json",
        "--model",
        "scribe_v2",
        "--token-env",
        "ELV_TEST_STT_TOKEN",
        "--dry-run",
      ],
      { ELV_TEST_STT_TOKEN: token },
    );
    expect(tokenResult.code).toBe(0);
    expect(tokenResult.stdout).not.toContain(token);
    expect(tokenResult.stderr).not.toContain(token);
    const tokenInput = recordValue(
      recordValue(recordValue(parseEnvelope(tokenResult.stdout).data).request).input,
    );
    expect(recordValue(tokenInput.query).token).toBe("[REDACTED]");
  });

  it("rejects legacy STT webhook URLs, orphan webhook ids, and missing token env", async () => {
    const legacy = await runCli([
      "stt",
      "--file",
      "package.json",
      "--webhook",
      "https://example.test/hook",
      "--dry-run",
    ]);
    expect(legacy.code).toBe(2);
    expect(errorRecord(parseEnvelope(legacy.stdout)).message).toContain(
      "configure a workspace webhook, then use --webhook [--webhook-id ID]",
    );

    const orphanId = await runCli([
      "stt",
      "--file",
      "package.json",
      "--webhook-id",
      "webhook_1",
      "--dry-run",
    ]);
    expect(orphanId.code).toBe(2);
    expect(errorRecord(parseEnvelope(orphanId.stdout)).message).toContain(
      "--webhook-id requires --webhook",
    );

    const missingToken = await runCli(
      ["stt", "--file", "package.json", "--token-env", "ELV_TEST_STT_TOKEN", "--dry-run"],
      { ELV_TEST_STT_TOKEN: "" },
    );
    expect(missingToken.code).toBe(2);
    expect(errorRecord(parseEnvelope(missingToken.stdout)).message).toContain(
      "--token-env ELV_TEST_STT_TOKEN is unset or empty",
    );
  });

  it("previews crawl cancellation as destructive through call and raw HTTP", async () => {
    for (const args of [
      ["call", "cancel_crawl_job_route", "--path", "crawl_job_id=crawl_1", "--dry-run"],
      ["http", "POST", "/v1/convai/knowledge-base/crawl/crawl_1/cancel", "--dry-run"],
    ]) {
      const result = await runCli(args);
      expect(result.code).toBe(0);
      expect(recordValue(parseEnvelope(result.stdout).data).would_require_yes).toBe(true);
    }
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
    const warnings = arrayValue(parseEnvelope(result.stdout).warnings, "warnings").map((warning) =>
      recordValue(warning, "warning"),
    );
    expect(warnings).toEqual([expect.objectContaining({ code: "deprecated_operation" })]);
  });
});
