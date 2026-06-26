import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWithRetry } from "../src/core/retries";
import type { HttpRequest } from "../src/core/request-builder";
import type { OperationCard } from "../src/core/types";

const op: OperationCard = {
  operationId: "retry_demo",
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
};

function req(method: HttpRequest["method"] = "GET"): HttpRequest {
  return { url: "https://api.test/v1/demo", method, headers: {}, path: "/v1/demo" };
}

function json(status: number, code: string): Response {
  return new Response(JSON.stringify({ detail: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("retry runner", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("backs off 429 rate_limit_exceeded then succeeds", async () => {
    const sleeps: number[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, "rate_limit_exceeded"))
      .mockResolvedValueOnce(json(200, "ok"));
    vi.stubGlobal("fetch", fetch);

    const res = await sendWithRetry(req(), op, {
      sleep: async (ms) => void sleeps.push(ms),
      jitter: () => 0,
      maxAttempts: 3,
    });

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
  });

  it("throttles 429 concurrent_limit_exceeded without escalating backoff", async () => {
    const sleeps: number[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, "concurrent_limit_exceeded"))
      .mockResolvedValueOnce(json(429, "too_many_concurrent_requests"))
      .mockResolvedValueOnce(json(200, "ok"));
    vi.stubGlobal("fetch", fetch);

    const res = await sendWithRetry(req(), op, {
      sleep: async (ms) => void sleeps.push(ms),
      jitter: () => 0,
      maxAttempts: 3,
    });

    expect(res.status).toBe(200);
    expect(sleeps).toEqual([250, 250]);
  });

  it("does not retry POST unless retryPost is set", async () => {
    const fetch = vi.fn().mockResolvedValue(json(500, "internal_error"));
    vi.stubGlobal("fetch", fetch);

    await sendWithRetry(
      req("POST"),
      { ...op, method: "POST" },
      { sleep: async () => undefined, maxAttempts: 3 },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries POST when retryPost is set", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(500, "internal_error"))
      .mockResolvedValueOnce(json(200, "ok"));
    vi.stubGlobal("fetch", fetch);

    const res = await sendWithRetry(
      req("POST"),
      { ...op, method: "POST" },
      { retryPost: true, sleep: async () => undefined, maxAttempts: 3 },
    );

    expect(res.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("never retries deterministic client/provider status codes", async () => {
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      const fetch = vi.fn().mockResolvedValue(json(status, "invalid_parameters"));
      vi.stubGlobal("fetch", fetch);
      await sendWithRetry(req(), op, { sleep: async () => undefined, maxAttempts: 3 });
      expect(fetch).toHaveBeenCalledTimes(1);
      vi.unstubAllGlobals();
    }
  });
});
