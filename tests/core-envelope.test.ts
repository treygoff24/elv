import { describe, expect, it, vi } from "vitest";
import { dryRun, failure, success, writeEnvelope } from "../src/core/envelope";

function captureStdout(fn: () => void): string {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return out;
}

describe("envelope", () => {
  it("stamps success and failure envelopes", () => {
    expect(success({ cmd: "elv config get", data: { ok: 1 } })).toMatchObject({ v: 1, ok: true });
    expect(
      failure({
        cmd: "elv call missing",
        error: { type: "not_found", code: "unknown_operation", message: "missing" },
      }),
    ).toMatchObject({ v: 1, ok: false });
  });

  it("writes exactly one redacted JSON object to stdout", () => {
    const out = captureStdout(() =>
      writeEnvelope(
        success({ cmd: "elv x", data: { token: "secret", url: "https://x.test/?token=abc" } }),
      ),
    );

    const parsed = JSON.parse(out);
    expect(parsed.data).toEqual({ token: "[REDACTED]", url: "https://x.test/?token=[REDACTED]" });
    expect(out.trim()).toBe(JSON.stringify(parsed));
  });

  it("builds a redacted dry-run request preview", () => {
    const env = dryRun({
      cmd: "elv call op",
      operationId: "op",
      request: { headers: { authorization: "Bearer abc" } },
      wouldRequireYes: true,
      wouldExceedBudget: false,
    });

    expect(env).toMatchObject({
      ok: true,
      operation_id: "op",
      cost: { credits_estimated: null, credits_charged: null, credits_source: "estimate" },
      data: {
        dry_run: true,
        credits_estimated: null,
        would_require_yes: true,
        would_exceed_budget: false,
        request: { headers: { authorization: "[REDACTED]" } },
      },
    });
  });
});
