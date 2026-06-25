import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../src/core/response-normalizer";
import type { OperationCard } from "../src/core/types";

function op(overrides: Partial<OperationCard> = {}): OperationCard {
  return {
    operationId: "response_demo",
    method: "GET",
    pathTemplate: "/v1/demo",
    group: [],
    tags: [],
    risk: "read",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
    ...overrides,
  };
}

describe("response normalization", () => {
  it("streams binary to files and never puts bytes in data", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-out-"));
    const env = await normalizeResponse(
      op({ returnsBinary: true, responses: [{ status: "200", contentType: "audio/mpeg", binary: true }], streamKind: "audio_bytes" }),
      new Response(Buffer.from("mp3-bytes"), { status: 200, headers: { "content-type": "audio/mpeg" } }),
      { cmd: "elv call response_demo", out },
    );

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.files).toHaveLength(1);
    expect(readFileSync(env.files![0]!.path, "utf8")).toBe("mp3-bytes");
  });

  it("inlines small JSON and tolerates unknown response fields", async () => {
    const env = await normalizeResponse(
      op(),
      new Response(JSON.stringify({ known: true, provider_added: "ignored by schema" }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_1", "character-cost": "12" },
      }),
      { cmd: "elv call response_demo" },
    );

    expect(env).toMatchObject({
      ok: true,
      request: { id: "req_1" },
      cost: { credits_charged: 12, credits_source: "header" },
      data: { known: true, provider_added: "ignored by schema" },
    });
  });
});
