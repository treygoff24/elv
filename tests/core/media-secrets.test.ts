import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { compileSpec } from "../../src/openapi/compile-spec";
import type { OperationCard } from "../../src/openapi/types";
import { normalizeResponse } from "../../src/core/response-normalizer";
import { collectAllPages } from "../../src/core/pagination";
import { failure } from "../../src/core/envelope";
import { containsCredential, redact, redactString } from "../../src/core/redaction";
import { buildViewResult } from "../../src/commands/view";

const signedUrl = "https://storage.example/content?X-Goog-Signature=media-canary";
let operations: Map<string, OperationCard>;
const dirs: string[] = [];
function outputDir() {
  const dir = mkdtempSync(join(tmpdir(), "elv-media-secret-"));
  dirs.push(dir);
  return dir;
}
beforeAll(async () => {
  operations = new Map((await compileSpec()).operations.map((op) => [op.operationId, op]));
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("signed media content", () => {
  it("protects Studio media URL variants without hiding project metadata", async () => {
    const data = {
      project_id: "p1",
      state: "default",
      video: {
        signed_preview_url: signedUrl,
        thumbnail_signed_url: signedUrl,
        signed_cloud_url: signedUrl,
        hls_manifest_url: signedUrl,
        dash_manifest_url: signedUrl,
      },
    };
    const env = await normalizeResponse(operations.get("get_project_by_id")!, Response.json(data), {
      cmd: "project get",
      out: outputDir(),
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toMatchObject({ project_id: "p1", state: "default" });
    expect(JSON.stringify(env)).not.toContain("media-canary");
    expect(env.files?.[0]?.sensitive).toBe(true);
    expect(JSON.parse(readFileSync(env.files![0]!.path, "utf8"))).toEqual(data);
    expect(redactString(JSON.stringify(data))).not.toContain("media-canary");
  });

  it.each(["X-Goog-Signature", "X-Amz-Signature", "sig"])(
    "detects %s URLs under arbitrary provider field names and in error text",
    async (parameter) => {
      const url = `https://storage.example/media?${parameter}=signature-canary&format=mp3`;
      const data = { download: url };
      expect(containsCredential(data)).toBe(true);
      expect(redactString(`Could not retrieve ${url}`)).not.toContain("signature-canary");
      const env = await normalizeResponse(operations.get("get_asset")!, Response.json(data), {
        cmd: "get",
        out: outputDir(),
      });
      expect(JSON.stringify(env)).not.toContain("signature-canary");
      expect(env.files?.[0]?.sensitive).toBe(true);
      expect(readFileSync(env.files![0]!.path, "utf8")).toContain("signature-canary");
    },
  );
  it("keeps polling metadata inline but protects signed content in a private artifact", async () => {
    const op = operations.get("get_image_generation")!;
    const data = { id: "gen-1", status: "completed", content_url: signedUrl };
    const env = await normalizeResponse(op, Response.json(data), {
      cmd: "elv flows image get",
      out: outputDir(),
    });
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toEqual({ ...data, content_url: "[REDACTED]" });
    expect(JSON.stringify(env)).not.toContain("media-canary");
    const file = env.files![0]!;
    expect(file.sensitive).toBe(true);
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file.path, "utf8"))).toEqual(data);
    expect(buildViewResult(file.path).exitCode).toBe(2);
    expect(redact({ content_url: signedUrl })).toEqual({ content_url: "[REDACTED]" });
    expect(redactString(JSON.stringify(data))).not.toContain("media-canary");
  });

  it("leaves unfinished media inline without inventing secret files", async () => {
    const data = { id: "gen-1", status: "generating", content_url: null };
    const env = await normalizeResponse(
      operations.get("get_video_generation")!,
      Response.json(data),
      { cmd: "get", out: outputDir() },
    );
    expect(env.ok && env.data).toEqual(data);
    expect(env.files).toBeUndefined();
    expect(redact(data)).toEqual(data);
  });

  it("collects all media pages and retains every sensitive original", async () => {
    const op = operations.get("list_assets")!;
    const out = outputDir();
    const saveJson = join(out, "all-assets.json");
    let fetched = 0;
    const env = await collectAllPages({
      op,
      input: {},
      command: { kind: "call" },
      out,
      saveJson,
      fetchPage: async (input) => {
        fetched += 1;
        expect(input.query?.cursor).toBe(fetched === 1 ? undefined : "next");
        return normalizeResponse(
          op,
          Response.json({
            assets: [{ asset_id: `asset-${fetched}`, content_url: signedUrl }],
            next_cursor: fetched === 1 ? "next" : null,
            has_more: fetched === 1,
          }),
          { cmd: "elv assets list", out, saveJson, inline: true },
        );
      },
    });
    expect(fetched).toBe(2);
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data_summary?.count).toBe(2);
    expect(JSON.stringify(env)).not.toContain("media-canary");
    const originals = env.files!.filter((file) => file.sensitive);
    expect(originals).toHaveLength(2);
    for (const file of originals) {
      expect(statSync(file.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(file.path, "utf8")).toContain(signedUrl);
    }
    const combined = env.files!.find((file) => !file.sensitive)!;
    expect(combined.path).toBe(saveJson);
    expect(buildViewResult(combined.path).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(combined.path, "utf8"))).toEqual([
      { asset_id: "asset-1", content_url: "[REDACTED]" },
      { asset_id: "asset-2", content_url: "[REDACTED]" },
    ]);
  });

  it("returns private page artifacts even when a later page fails", async () => {
    const op = operations.get("list_assets")!;
    const out = outputDir();
    let pages = 0;
    const env = await collectAllPages({
      op,
      input: {},
      command: { kind: "call" },
      out,
      fetchPage: async () =>
        ++pages === 1
          ? normalizeResponse(
              op,
              Response.json({
                assets: [{ asset_id: "a1", content_url: signedUrl }],
                next_cursor: "next",
                has_more: true,
              }),
              { cmd: "assets list", out, inline: true },
            )
          : failure({
              cmd: "assets list",
              error: { type: "provider_error", code: "failed", message: "Page unavailable" },
            }),
    });
    expect(pages).toBe(2);
    expect(env.ok).toBe(false);
    expect(env.files).toHaveLength(1);
    expect(env.files![0]!.sensitive).toBe(true);
    expect(readFileSync(env.files![0]!.path, "utf8")).toContain(signedUrl);
    expect(JSON.stringify(env)).not.toContain("media-canary");
  });
});
