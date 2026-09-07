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
const cleanups: (() => void)[] = [];

/** Resolves once `check` holds, so a stream cancellation can be observed without a sleep. */
async function until(check: () => boolean, label: string, budgetMs = 5_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    for (const cleanup of cleanups.splice(0)) cleanup();
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

  it("cancels an abandoned 5xx body before backing off", async () => {
    let attempts = 0;
    let firstResponseClosed = false;
    const sleeps: number[] = [];
    const url = await listen((_request, response) => {
      attempts += 1;
      if (attempts > 1) {
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.write('{"detail":{"code":"internal_error"}}');
      // Never ends on its own: only a client-side cancel can close this response.
      const ticker = setInterval(() => response.write(" ".repeat(256)), 2);
      const stop = () => {
        clearInterval(ticker);
        response.destroy();
      };
      cleanups.push(stop);
      response.on("close", () => {
        firstResponseClosed = true;
        clearInterval(ticker);
      });
    });

    const res = await sendWithRetry({ ...req(), url: `${url}/v1/demo` }, op, {
      sleep: async (ms) => {
        // The abandoned body must already be released when the backoff starts.
        await until(() => firstResponseClosed, "the abandoned 5xx body to be cancelled");
        sleeps.push(ms);
      },
      jitter: () => 0,
      maxAttempts: 2,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sleeps).toHaveLength(1);
    expect(firstResponseClosed).toBe(true);
  });

  it("retries a 429 whose body never ends instead of buffering it", async () => {
    let attempts = 0;
    const url = await listen((_request, response) => {
      attempts += 1;
      if (attempts > 1) {
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return;
      }
      response.writeHead(429, { "content-type": "application/json" });
      response.write('{"detail":{"code":"rate_limit_exceeded","message":"slow down"}}');
      // Valid JSON so far, then padding forever: the document never completes.
      const ticker = setInterval(() => response.write(" ".repeat(256)), 1);
      cleanups.push(() => {
        clearInterval(ticker);
        response.destroy();
      });
      response.on("close", () => clearInterval(ticker));
    });

    const res = await sendWithRetry({ ...req(), url: `${url}/v1/demo` }, op, {
      sleep: async () => undefined,
      jitter: () => 0,
      maxAttempts: 2,
      errorBodyMaxBytes: 2_048,
    });

    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("gives up on a stalled 429 body rather than waiting for it", async () => {
    let attempts = 0;
    const url = await listen((_request, response) => {
      attempts += 1;
      if (attempts > 1) {
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        return;
      }
      response.writeHead(429, { "content-type": "application/json" });
      // A truncated document and then silence: no further chunk ever arrives.
      response.write('{"detail":');
      cleanups.push(() => response.destroy());
    });

    const started = Date.now();
    const res = await sendWithRetry({ ...req(), url: `${url}/v1/demo` }, op, {
      sleep: async () => undefined,
      jitter: () => 0,
      maxAttempts: 2,
      errorBodyTimeoutMs: 50,
    });

    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("returns the final retryable response with its body still readable", async () => {
    const fetch = vi.fn().mockResolvedValue(json(429, "rate_limit_exceeded"));
    vi.stubGlobal("fetch", fetch);

    const res = await sendWithRetry(req(), op, { sleep: async () => undefined, maxAttempts: 1 });

    expect(res.status).toBe(429);
    expect(res.bodyUsed).toBe(false);
    await expect(res.json()).resolves.toMatchObject({
      detail: { code: "rate_limit_exceeded" },
    });
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
