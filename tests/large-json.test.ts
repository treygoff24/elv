import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeResponse } from "../src/core/response-normalizer";
import type { OperationCard } from "../src/core/types";

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "elv-large-json-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

function op(): OperationCard {
  return {
    operationId: "big_json",
    method: "GET",
    pathTemplate: "/v1/big",
    group: [],
    tags: [],
    risk: "read",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [{ status: "200", contentType: "application/json", binary: false }],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

describe("large JSON spill", () => {
  it("keeps small JSON inline", async () => {
    const env = await normalizeResponse(
      op(),
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
      { cmd: "elv call big_json", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toEqual({ ok: true });
    expect(env.truncated).toBe(false);
    expect(env.files).toBeUndefined();
  });

  it("summarizes and spills JSON at 32 KB and above", async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ index, value: "x".repeat(1200) }));
    const body = JSON.stringify(items);
    expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(32 * 1024);

    const env = await normalizeResponse(
      op(),
      new Response(body, { headers: { "content-type": "application/json" } }),
      { cmd: "elv call big_json", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.data_summary).toMatchObject({ type: "array", count: 30, preview_count: 20 });
    expect(env.truncated).toBe(true);
    expect(env.files).toHaveLength(1);
    expect(env.hints?.[0]?.cmd).not.toContain("elv view");
    expect(env.hints?.[0]?.cmd).not.toContain("--jq");
    expect(env.hints?.[0]?.cmd).toContain(env.files![0]!.path);
    expect(env.files![0]!.mime).toBe("application/json");
    expect(existsSync(env.files![0]!.path)).toBe(true);
    expect(JSON.parse(readFileSync(env.files![0]!.path, "utf8"))).toEqual(items);
  });

  it("can keep large internal JSON lookups inline", async () => {
    const items = Array.from({ length: 30 }, (_, index) => ({ index, value: "x".repeat(1200) }));
    const body = JSON.stringify({ voices: items });
    expect(Buffer.byteLength(body)).toBeGreaterThanOrEqual(32 * 1024);

    const env = await normalizeResponse(
      op(),
      new Response(body, { headers: { "content-type": "application/json" } }),
      { cmd: "elv call big_json", out, inline: true },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toEqual({ voices: items });
    expect(env.files).toBeUndefined();
    expect(env.truncated).toBe(false);
  });
});
