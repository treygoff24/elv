import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWithRetry } from "../../src/core/retries";
import type { HttpRequest } from "../../src/core/request-builder";
import type { OperationCard } from "../../src/openapi/types";

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

const servers: Server[] = [];

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
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it("follows same-origin redirects without dropping authentication", async () => {
    let receivedKey: string | undefined;
    const url = await listen((request, response) => {
      if (request.url === "/v1/demo") {
        response.writeHead(302, { location: "/v1/final" }).end();
        return;
      }
      receivedKey = request.headers["xi-api-key"] as string | undefined;
      response.end("ok");
    });

    const res = await sendWithRetry(
      { ...req(), url: `${url}/v1/demo`, headers: { "xi-api-key": "secret" } },
      op,
      { maxAttempts: 1 },
    );

    expect(res.status).toBe(200);
    expect(receivedKey).toBe("secret");
  });

  it("refuses cross-origin redirects before forwarding authentication", async () => {
    let receivedKey: string | undefined;
    const targetUrl = await listen((request, response) => {
      receivedKey = request.headers["xi-api-key"] as string | undefined;
      response.end("unexpected");
    });
    const originUrl = await listen((_request, response) => {
      response.writeHead(302, { location: `${targetUrl}/capture` }).end();
    });

    await expect(
      sendWithRetry(
        {
          ...req(),
          url: `${originUrl}/v1/demo`,
          headers: { "xi-api-key": "secret" },
        },
        op,
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow(/cross-origin redirect/u);
    expect(receivedKey).toBeUndefined();
  });

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

function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
