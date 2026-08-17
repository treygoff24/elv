import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";
import { runPreparedOperation } from "../../src/core/client";
import { requiresYes } from "../../src/core/safety";
import { compileSpec } from "../../src/openapi/compile-spec";
import { riskCurationInputs } from "../../src/openapi/risk";
import { errorRecord, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";
import type { AgentInput } from "../../src/core/types";

afterEach(() => vi.unstubAllGlobals());

function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/gu, "test-id");
}

describe("curated confirmation contract", () => {
  it("gates every curated destructive and external-side-effect operation through call and raw HTTP", async () => {
    const { destructiveOperationIds, externalSideEffectOperationIds } = riskCurationInputs();
    const ids = [...destructiveOperationIds, ...externalSideEffectOperationIds];
    const compiled = await compileSpec({ sourcePath: "spec/openapi.snapshot.json" });
    const byId = new Map(
      compiled.operations.map((operation) => [operation.operationId, operation]),
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    for (const operationId of ids) {
      const op = byId.get(operationId);
      expect(op, operationId).toBeDefined();
      expect(requiresYes(op!), operationId).toBe(true);

      const call = await runPreparedOperation({
        cmd: `elv call ${operationId}`,
        op: op!,
        input: {} as AgentInput,
        opts: {},
        command: { kind: "call" },
        dryRunRequest: {
          operation_id: operationId,
          method: op!.method,
          path: op!.pathTemplate,
          input: {},
        },
        creditsEstimated: null,
      });
      expect(call.ok ? undefined : call.error.code, `${operationId} call`).toBe("confirmation");

      const raw = await runHttp(op!.method, concretePath(op!.pathTemplate));
      expect(raw.ok ? undefined : raw.error.code, `${operationId} http`).toBe("confirmation");
    }
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it.each([
    ["history delete", ["history", "delete", "--id", "history-id"]],
    ["agent test delete", ["agents", "tests", "delete", "--test-id", "test-id"]],
    [
      "dubbing transcript delete",
      [
        "dubbing-project",
        "transcript",
        "delete-segment",
        "--project-id",
        "project-id",
        "--segment-id",
        "segment-id",
      ],
    ],
    ["service account create", ["workspace", "service-accounts", "create", "--name", "CI"]],
    [
      "voice replication",
      ["voices", "replicate", "--voice-id", "voice-id", "--target-workspace-id", "workspace-id"],
    ],
  ])("gates the %s alias", async (_name, args) => {
    const result = await runCli(args);
    expect(result.code).toBe(4);
    expect(errorRecord(parseEnvelope(result.stdout)).code).toBe("confirmation");
  });

  it("keeps July 27 POST bulk lookup ungated and bulk delete confirmed in dry-runs", async () => {
    const lookup = await runCli([
      "call",
      "get_knowledge_base_bulk_dependent_agents_route",
      "--json",
      '{"body":{"document_ids":["doc_1"]}}',
      "--dry-run",
    ]);
    expect(lookup.code).toBe(0);
    expect(recordValue(parseEnvelope(lookup.stdout).data).would_require_yes).toBe(false);

    const deletion = await runCli([
      "call",
      "post_knowledge_base_bulk_delete_route",
      "--json",
      '{"body":{"document_ids":["doc_1"]}}',
      "--dry-run",
    ]);
    expect(deletion.code).toBe(0);
    expect(recordValue(parseEnvelope(deletion.stdout).data).would_require_yes).toBe(true);

    const rawLookup = await runCli([
      "http",
      "POST",
      "/v1/convai/knowledge-base/dependent-agents",
      "--body-json",
      '{"document_ids":["doc_1"]}',
      "--dry-run",
    ]);
    expect(rawLookup.code).toBe(0);
    expect(recordValue(parseEnvelope(rawLookup.stdout).data).would_require_yes).toBe(false);

    const rawDeletion = await runCli([
      "http",
      "POST",
      "/v1/convai/knowledge-base/bulk-delete",
      "--body-json",
      '{"document_ids":["doc_1"]}',
      "--dry-run",
    ]);
    expect(rawDeletion.code).toBe(0);
    expect(recordValue(parseEnvelope(rawDeletion.stdout).data).would_require_yes).toBe(true);

    for (const result of [
      await runCli([
        "call",
        "post_knowledge_base_bulk_delete_route",
        "--json",
        '{"body":{"document_ids":["doc_1"]}}',
      ]),
      await runCli([
        "http",
        "POST",
        "/v1/convai/knowledge-base/bulk-delete",
        "--body-json",
        '{"document_ids":["doc_1"]}',
      ]),
    ]) {
      expect(result.code).toBe(4);
      expect(errorRecord(parseEnvelope(result.stdout)).code).toBe("confirmation");
    }
  });

  it("previews and budget-gates cross-residency voice replication before confirmation", async () => {
    const input = '{"path":{"voice_id":"voice_1"},"body":{"target_workspace_id":"workspace_1"}}';
    const preview = await runCli([
      "call",
      "replicate_voice_to_isolated_environment",
      "--json",
      input,
      "--dry-run",
    ]);

    expect(preview.code).toBe(0);
    expect(recordValue(parseEnvelope(preview.stdout).data)).toMatchObject({
      would_require_yes: true,
      budget_policy: "not_configured",
    });

    const capped = await runCli([
      "call",
      "replicate_voice_to_isolated_environment",
      "--json",
      input,
      "--max-credits",
      "1",
    ]);
    const error = errorRecord(parseEnvelope(capped.stdout));

    expect(capped.code).toBe(5);
    expect(error.code).toBe("budget");
    expect(recordValue(error.raw).budget_policy).toBe("unknown_unbounded");
  });

  it("budget-gates Dubbing target regeneration before confirmation or network", async () => {
    const cases = [
      [
        "alias",
        [
          "dubbing-project",
          "target-transcript",
          "regenerate",
          "--project-id",
          "project_1",
          "--language-id",
          "es",
          "--max-credits",
          "0",
          "--base-url",
          "http://127.0.0.1:9",
          "--yes",
        ],
      ],
      [
        "call",
        [
          "call",
          "dubbing_target_transcript_regenerate",
          "--json",
          '{"path":{"project_id":"project_1","language_id":"es"}}',
          "--max-credits",
          "0",
          "--base-url",
          "http://127.0.0.1:9",
          "--yes",
        ],
      ],
      [
        "http",
        [
          "http",
          "POST",
          "/v1/dubbing/project/project_1/language/es/transcript/regenerate",
          "--base-url",
          "http://127.0.0.1:9",
          "--max-credits",
          "0",
          "--yes",
        ],
      ],
    ] as const;

    for (const [name, args] of cases) {
      const result = await runCli([...args]);
      const error = errorRecord(parseEnvelope(result.stdout));
      expect(result.code, name).toBe(5);
      expect(error.code, name).toBe("budget_estimate_unavailable");
      expect(recordValue(error.raw).budget_policy, name).toBe("estimate_unavailable");
    }
  });

  it("budget-gates Flows image and video generation through alias, call, and raw HTTP", async () => {
    const cases = [
      [
        "image alias",
        ["flows", "image", "create", "--json", '{"prompt":"cat","model_id":"gpt-image-1"}'],
      ],
      [
        "image call",
        [
          "call",
          "create_image_generation",
          "--json",
          '{"body":{"prompt":"cat","model_id":"gpt-image-1"}}',
        ],
      ],
      [
        "image http",
        [
          "http",
          "POST",
          "/v1/flows/image",
          "--body-json",
          '{"prompt":"cat","model_id":"gpt-image-1"}',
        ],
      ],
      [
        "video alias",
        [
          "flows",
          "video",
          "create",
          "--json",
          '{"model_id":"creatify-aurora","image":{"type":"generation","generation_id":"img_1"},"audio":{"type":"generation","generation_id":"aud_1"}}',
        ],
      ],
      [
        "video call",
        [
          "call",
          "create_video_generation",
          "--json",
          '{"body":{"model_id":"creatify-aurora","image":{"type":"generation","generation_id":"img_1"},"audio":{"type":"generation","generation_id":"aud_1"}}}',
        ],
      ],
      [
        "video http",
        [
          "http",
          "POST",
          "/v1/flows/video",
          "--body-json",
          '{"model_id":"creatify-aurora","image":{"type":"generation","generation_id":"img_1"},"audio":{"type":"generation","generation_id":"aud_1"}}',
        ],
      ],
    ] as const;

    for (const [name, baseArgs] of cases) {
      for (const yes of [false, true]) {
        const result = await runCli([
          ...baseArgs,
          "--base-url",
          "http://127.0.0.1:9",
          "--max-credits",
          "1",
          ...(yes ? ["--yes"] : []),
        ]);
        const error = errorRecord(parseEnvelope(result.stdout));
        expect(result.code, `${name} yes=${yes}`).toBe(5);
        expect(error.code, `${name} yes=${yes}`).toBe("budget_estimate_unavailable");
        expect(recordValue(error.raw).budget_policy, `${name} yes=${yes}`).toBe(
          "estimate_unavailable",
        );
      }
    }
  }, 20_000);

  it("budget-gates asset upload through call and raw HTTP when a ceiling is configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-asset-budget-"));
    try {
      const file = join(dir, "asset.txt");
      writeFileSync(file, "asset");
      const cases = [
        [
          "call",
          [
            "call",
            "upload_asset",
            "--json",
            '{"body":{"name":"asset.txt"}}',
            "--file",
            `asset=${file}`,
          ],
        ],
        [
          "http",
          [
            "http",
            "POST",
            "/v1/assets",
            "--body-json",
            '{"name":"asset.txt"}',
            "--file",
            `asset=${file}`,
          ],
        ],
      ] as const;

      for (const [name, args] of cases) {
        const result = await runCli([
          ...args,
          "--base-url",
          "http://127.0.0.1:9",
          "--max-credits",
          "1",
        ]);
        const error = errorRecord(parseEnvelope(result.stdout));
        expect(result.code, name).toBe(5);
        expect(error.code, name).toBe("budget");
        expect(recordValue(error.raw).budget_policy, name).toBe("unknown_unbounded");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
