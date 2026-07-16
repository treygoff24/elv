import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvelope, recordValue, runCli } from "../helpers/cli-result";

let cacheDir = "";

afterEach(() => {
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

describe("spec CLI dry-run", () => {
  it("does not write the cache when --dry-run is parsed from common flags", async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-spec-cli-"));
    const result = await runCli(["spec", "update", "--offline", "--dry-run"], {
      ELV_CACHE_DIR: cacheDir,
    });

    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(recordValue(envelope.data).written).toBe(false);
    expect(existsSync(join(cacheDir, "0.1.0", "openapi.compact.json"))).toBe(false);
  });
});
