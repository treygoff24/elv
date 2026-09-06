import { basename } from "node:path";
import type { Command } from "commander";
import { numberValue } from "../options";
import {
  addPaginationFlags,
  compact,
  compactInput,
  readJsonBody,
  required,
  requiredPath,
  runAlias,
  runListAlias,
  type BuiltOperation,
  type JsonBodyFlags,
} from "./shared";

interface AssetFlags extends JsonBodyFlags {
  file?: string;
  name?: string;
  assetId?: string;
  search?: string;
  cursor?: string;
  pageSize?: string | number;
}

export function buildAssetUploadInput(flags: AssetFlags): BuiltOperation {
  const file = requiredPath(flags.file, "--file");
  const body = readJsonBody(flags, false);
  return {
    operationId: "upload_asset",
    input: {
      files: { asset: file },
      body: { ...body, name: flags.name ?? body.name ?? basename(file) },
    },
  };
}

export function buildAssetsListInput(flags: AssetFlags): BuiltOperation {
  const pageSize = numberValue(flags.pageSize);
  return {
    operationId: "list_assets",
    input: compactInput({
      query: compact({
        search: flags.search,
        cursor: flags.cursor,
        page_size: pageSize,
      }),
    }),
  };
}

export function buildAssetGetInput(flags: AssetFlags): BuiltOperation {
  return {
    operationId: "get_asset",
    input: { path: { asset_id: required(flags.assetId, "--asset-id") } },
  };
}

export function buildAssetDeleteInput(flags: AssetFlags): BuiltOperation {
  return { ...buildAssetGetInput(flags), operationId: "delete_asset_endpoint" };
}

export function registerAssetsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const assets = program.command("assets").description("Upload and manage reusable media assets");
  addCommonFlags(
    assets
      .command("upload")
      .description("Upload an asset for use in generation requests")
      .option("--file <path>", "local media file")
      .option("--name <name>", "display name (defaults to the file basename)")
      .option("--json <json>", "additional multipart body fields as JSON")
      .option("--json-file <path>", "additional multipart body fields JSON file"),
  ).action((options: AssetFlags, command: Command) =>
    runAlias(buildAssetUploadInput, options, command),
  );
  addCommonFlags(
    addPaginationFlags(assets.command("list"))
      .description("List assets, newest first")
      .option("--search <text>", "filter asset names")
      .option("--cursor <cursor>", "resume from a previous next_cursor")
      .option("--page-size <n>", "page size (1-100)"),
  ).action((options: AssetFlags, command: Command) =>
    runListAlias(buildAssetsListInput, options, command),
  );
  addCommonFlags(
    assets
      .command("get")
      .description("Get asset metadata and a fresh content URL")
      .option("--asset-id <id>", "asset id"),
  ).action((options: AssetFlags, command: Command) =>
    runAlias(buildAssetGetInput, options, command),
  );
  addCommonFlags(
    assets
      .command("delete")
      .description("Delete an asset (requires --yes)")
      .option("--asset-id <id>", "asset id"),
  ).action((options: AssetFlags, command: Command) =>
    runAlias(buildAssetDeleteInput, options, command),
  );
}
