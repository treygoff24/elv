import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeResponse } from "../../src/core/response-normalizer";
import { buildViewResult } from "../../src/commands/view";
import type { OperationCard } from "../../src/openapi/types";

const canary = "credential_CANARY_secret_response";

function secretOp(): OperationCard {
  return {
    operationId: "get_single_use_token",
    method: "POST",
    pathTemplate: "/v1/single-use-token/{token_type}",
    group: [],
    tags: [],
    risk: "mutate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [{ status: "200", contentType: "application/json", binary: false }],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    secretResult: true,
    deprecated: false,
    examples: [],
  };
}

describe("secret results in non-JSON response forms", () => {
  it.each(["text/plain", "application/octet-stream"])(
    "protects opaque %s credentials and their exact bytes",
    async (mime) => {
      const bytes = Buffer.concat([Buffer.from(canary), Buffer.from([0, 255])]);
      const env = await normalizeResponse(
        secretOp(),
        new Response(bytes, { headers: { "content-type": mime } }),
        {
          cmd: "get token",
          out: join(mkdtempSync(join(tmpdir(), "elv-opaque-secret-")), "chosen-output"),
        },
      );
      expect(env.ok).toBe(true);
      expect(JSON.stringify(env)).not.toContain(canary);
      expect(env.files?.[0]?.sensitive).toBe(true);
      expect(statSync(env.files![0]!.path).mode & 0o777).toBe(0o600);
      expect(readFileSync(env.files![0]!.path)).toEqual(bytes);
      expect(buildViewResult(env.files![0]!.path).exitCode).toBe(2);
    },
  );

  it("marks caller-named secret JSON outputs so opaque values cannot bypass view", async () => {
    const env = await normalizeResponse(secretOp(), Response.json({ opaque: canary }), {
      cmd: "get token",
      out: join(mkdtempSync(join(tmpdir(), "elv-named-secret-")), "chosen.json"),
    });
    expect(env.files?.[0]?.path).toMatch(/\.sensitive\.json$/);
    expect(buildViewResult(env.files![0]!.path).exitCode).toBe(2);
    expect(JSON.stringify(buildViewResult(env.files![0]!.path).env)).not.toContain(canary);
  });
  it("preserves malformed JSON privately without leaking its parse error or body", async () => {
    const env = await normalizeResponse(
      secretOp(),
      new Response(`${canary} malformed`, {
        headers: { "content-type": "application/json" },
      }),
      { cmd: "get token", out: mkdtempSync(join(tmpdir(), "elv-private-error-")) },
    );
    expect(env.ok).toBe(false);
    expect(JSON.stringify(env)).not.toContain(canary);
    expect(env.files?.[0]?.sensitive).toBe(true);
    expect(statSync(env.files![0]!.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(env.files![0]!.path, "utf8")).toContain(canary);
  });
  it("protects a secret JSON result when content-type is missing", async () => {
    const response = new Response(JSON.stringify({ token: canary }));
    response.headers.delete("content-type");
    const env = await normalizeResponse(secretOp(), response, {
      cmd: "elv call get_single_use_token",
      out: mkdtempSync(join(tmpdir(), "elv-secret-form-")),
    });

    expect(JSON.stringify(env)).not.toContain(canary);
    expect(env.ok && env.files?.[0]?.sensitive).toBe(true);
  });
});
