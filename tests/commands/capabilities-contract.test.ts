import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCapabilities } from "../../src/commands/capabilities";
import { arrayValue as array, recordValue as record } from "../helpers/cli-result";

describe("capabilities machine contract", () => {
  const previousCache = process.env.ELV_CACHE_DIR;

  beforeEach(() => {
    process.env.ELV_CACHE_DIR = mkdtempSync(join(tmpdir(), "elv-capabilities-"));
  });

  afterEach(() => {
    if (previousCache === undefined) delete process.env.ELV_CACHE_DIR;
    else process.env.ELV_CACHE_DIR = previousCache;
  });

  it("returns the bounded top-level schema with stable sorted inventories", async () => {
    const result = await handleCapabilities({ version: "9.8.7" });
    expect(result.exitCode).toBe(0);
    expect(result.env.ok).toBe(true);

    const data = record(result.env.ok ? result.env.data : undefined);
    expect(Object.keys(data)).toEqual([
      "cli",
      "spec",
      "command_families",
      "service_groups",
      "alias_families",
      "websockets",
      "protocol",
      "configuration",
      "safety",
      "next",
    ]);
    expect(record(data.cli)).toEqual({ name: "elv", version: "9.8.7", envelope_version: 1 });
    expect(record(data.spec)).toMatchObject({
      source: expect.any(String),
      sha256: expect.any(String),
      paths: 294,
      total_operations: 378,
      callable_operations: 377,
      skipped_operations: 1,
      schemas: 1452,
    });

    const groups = array(data.service_groups).map((entry) => String(record(entry).name));
    expect(groups).toEqual([...groups].sort());
    const aliasEntries = array(data.alias_families).map((entry) => record(entry));
    const aliases = aliasEntries.map((entry) => String(entry.name));
    expect(aliases).toEqual([...aliases].sort());
    for (const alias of aliasEntries) {
      const operationIds = array(alias.operation_ids).map(String);
      expect(operationIds, String(alias.name)).toEqual([...operationIds].sort());
    }
    const agents = aliasEntries.find((entry) => entry.name === "agents");
    expect(agents).toMatchObject({
      operation_ids: expect.arrayContaining([
        "compile_procedures_route",
        "create_procedure_route",
        "delete_procedure_draft_route",
        "get_conversation_summary_route",
        "get_procedure_draft_route",
        "get_procedure_route",
        "list_procedures_route",
        "remove_procedure_route",
        "update_procedure_draft_route",
      ]),
    });
    const assets = aliasEntries.find((entry) => entry.name === "assets");
    expect(assets).toMatchObject({
      operation_ids: expect.arrayContaining([
        "delete_asset_endpoint",
        "get_asset",
        "list_assets",
        "upload_asset",
      ]),
    });
    const flows = aliasEntries.find((entry) => entry.name === "flows");
    expect(flows).toMatchObject({
      operation_ids: expect.arrayContaining([
        "create_image_generation",
        "create_text_to_speech_generation",
        "create_video_generation",
        "get_image_generation",
        "get_text_to_speech_generation",
        "get_video_generation",
        "list_image_generations",
        "list_text_to_speech_generations",
        "list_video_generations",
      ]),
    });
    const dubbingProject = aliasEntries.find((entry) => entry.name === "dubbing-project");
    expect(dubbingProject).toMatchObject({
      operation_ids: expect.arrayContaining([
        "dubbing_target_transcript_segments_update",
        "dubbing_transcript_segments_update",
      ]),
    });
    const voices = aliasEntries.find((entry) => entry.name === "voices");
    expect(voices).toMatchObject({
      operation_ids: expect.arrayContaining([
        "get_voice_accents",
        "replicate_voice_to_isolated_environment",
      ]),
    });
    const music = aliasEntries.find((entry) => entry.name === "music");
    expect(music).toMatchObject({
      operation_ids: expect.arrayContaining([
        "create_finetune",
        "delete_finetune",
        "get_finetune",
        "get_finetunes",
        "update_finetune",
      ]),
    });
    const websockets = array(data.websockets).map((entry) => String(record(entry).name));
    expect(websockets).toEqual([...websockets].sort());

    expect(record(data.protocol)).toMatchObject({
      stdout: "exactly_one_json_envelope",
      envelope_version: 1,
    });
    expect(record(data.safety)).toMatchObject({
      confirmation_flag: "--yes",
      budget_flag: "--max-credits",
    });
    expect(array(data.next)).toHaveLength(4);
  });
});
