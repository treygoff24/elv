import { existsSync, openAsBlob } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendWithRetry } from "../../src/core/retries";
import type { HttpRequest } from "../../src/core/request-builder";
import type { OperationCard } from "../../src/openapi/types";

const servers: Server[] = [];
const op: OperationCard = {
  operationId: "post_replay",
  method: "POST",
  pathTemplate: "/start",
  group: [],
  tags: [],
  risk: "mutate",
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

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(handler: (request: IncomingMessage, body: Buffer) => void): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      handler(request, Buffer.concat(chunks));
      response.statusCode = request.url === "/retry" ? 200 : 500;
      response.end("ok");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("POST body replay", () => {
  it("replays byte-identical JSON bodies and makes the duplicate attempt explicit", async () => {
    const bodies: Buffer[] = [];
    let attempts = 0;
    const baseUrl = await listen((_request, received) => {
      attempts += 1;
      bodies.push(received);
    });
    const request: HttpRequest = {
      url: `${baseUrl}/start`,
      method: "POST",
      headers: {},
      body: JSON.stringify({ prompt: "same bytes" }),
      path: "/start",
    };
    await sendWithRetry(request, op, {
      retryPost: true,
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    expect(attempts).toBe(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("replays semantically identical multipart bodies and makes the duplicate attempt explicit", async () => {
    const bodies: Buffer[] = [];
    let attempts = 0;
    const baseUrl = await listen((_request, received) => {
      attempts += 1;
      bodies.push(received);
    });
    const form = new FormData();
    form.append("prompt", "same bytes");
    const request: HttpRequest = {
      url: `${baseUrl}/start`,
      method: "POST",
      headers: {},
      body: form,
      path: "/start",
    };
    await sendWithRetry(request, op, {
      retryPost: true,
      maxAttempts: 2,
      sleep: async () => undefined,
    });
    expect(attempts).toBe(2);
    expect(normalizeMultipartBoundary(bodies[1]!)).toEqual(normalizeMultipartBoundary(bodies[0]!));
  });

  it("replays semantically identical file-backed multipart bodies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "elv-post-replay-"));
    const bodies: Buffer[] = [];
    let attempts = 0;
    try {
      const uploadPath = join(dir, "sample.txt");
      await writeFile(uploadPath, "file-backed bytes\n", "utf8");

      const baseUrl = await listen((_request, received) => {
        attempts += 1;
        bodies.push(received);
      });
      const form = new FormData();
      form.append("prompt", "same bytes");
      form.append("file", await openAsBlob(uploadPath, { type: "text/plain" }), "sample.txt");
      const request: HttpRequest = {
        url: `${baseUrl}/start`,
        method: "POST",
        headers: {},
        body: form,
        path: "/start",
      };
      await sendWithRetry(request, op, {
        retryPost: true,
        maxAttempts: 2,
        sleep: async () => undefined,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
    expect(existsSync(dir)).toBe(false);
    expect(attempts).toBe(2);
    expect(normalizeMultipartBoundary(bodies[1]!)).toEqual(normalizeMultipartBoundary(bodies[0]!));
  });

  it.each([307, 308])("replays the POST body across a %s redirect", async (status) => {
    const bodies: Buffer[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks));
        if (request.url === "/start") response.writeHead(status, { location: "/retry" }).end();
        else response.end("ok");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const body = JSON.stringify({ prompt: "redirect bytes" });
    await sendWithRetry(
      {
        url: `http://127.0.0.1:${address.port}/start`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        path: "/start",
      },
      op,
      { retryPost: true, maxAttempts: 1 },
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });
});

function normalizeMultipartBoundary(body: Buffer): string {
  const text = body.toString("utf8");
  const firstLine = text.slice(0, text.indexOf("\r\n"));
  expect(firstLine.startsWith("--")).toBe(true);
  return text.split(firstLine.slice(2)).join("BOUNDARY");
}
