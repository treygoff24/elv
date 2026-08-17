import { basename, resolve } from "node:path";
import type { Command } from "commander";
import type { CliOptionValues } from "../options";
import {
  addPaginationFlags,
  compact,
  compactInput,
  required,
  runAlias,
  runListAlias,
  type BuiltOperation,
} from "./shared";

interface AssetFlags extends Pick<CliOptionValues, "search"> {
  id?: string;
  cursor?: string;
  file?: string;
  name?: string;
}

export function buildAssetsListInput(flags: AssetFlags): BuiltOperation {
  return {
    operationId: "list_assets",
    input: compactInput({ query: compact({ search: flags.search, cursor: flags.cursor }) }),
  };
}

export function buildAssetsGetInput(flags: AssetFlags): BuiltOperation {
  return {
    operationId: "get_asset",
    input: { path: { asset_id: required(flags.id, "--id") } },
  };
}

export function buildAssetsUploadInput(flags: AssetFlags): BuiltOperation {
  const path = resolve(required(flags.file, "--file"));
  return {
    operationId: "upload_asset",
    input: { files: { asset: path }, body: { name: flags.name ?? basename(path) } },
  };
}

export function buildAssetsDeleteInput(flags: AssetFlags): BuiltOperation {
  return {
    operationId: "delete_asset_endpoint",
    input: { path: { asset_id: required(flags.id, "--id") } },
  };
}

export function registerAssetsCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const assets = program.command("assets").description("Media assets");
  addCommonFlags(
    addPaginationFlags(assets.command("list"))
      .description("List uploaded media assets")
      .option("--search <query>", "filter assets by name")
      .option("--cursor <cursor>", "pagination cursor from a previous response")
      .action((options: AssetFlags, command: Command) =>
        runListAlias(buildAssetsListInput, options, command, { mergeOptions: true }),
      ),
  );
  addCommonFlags(
    assets
      .command("get")
      .description("Get an asset by id")
      .option("--id <id>", "asset id")
      .action((options: AssetFlags, command: Command) =>
        runAlias(buildAssetsGetInput, options, command),
      ),
  );
  addCommonFlags(
    assets
      .command("upload")
      .description("Upload a media asset")
      .option("--file <path>", "asset file to upload")
      .option("--name <name>", "asset name; defaults to the file basename")
      .action((options: AssetFlags, command: Command) =>
        runAlias(buildAssetsUploadInput, options, command),
      ),
  );
  addCommonFlags(
    assets
      .command("delete")
      .description("Delete an asset")
      .option("--id <id>", "asset id")
      .action((options: AssetFlags, command: Command) =>
        runAlias(buildAssetsDeleteInput, options, command),
      ),
  );
}
