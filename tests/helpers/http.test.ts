import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { rejectPortProbe } from "./http";

describe("external port probe isolation", () => {
  it("rejects only the observed unauthenticated Go root probe", () => {
    const writeHead = vi.fn();
    const end = vi.fn();
    const response = { writeHead, end } as unknown as ServerResponse;
    const probe = { method: "GET", url: "/", headers: { "user-agent": "Go-http-client/1.1" } };
    expect(rejectPortProbe(probe as IncomingMessage, response)).toBe(true);
    expect(writeHead).toHaveBeenCalledWith(404);
    expect(end).toHaveBeenCalledOnce();
    for (const request of [
      { ...probe, method: "POST" },
      { ...probe, url: "/v1/models" },
      { ...probe, url: "/?query=value" },
      { ...probe, headers: { "user-agent": "node" } },
      { ...probe, headers: {} },
      ...["xi-api-key", "authorization", "cookie", "upgrade"].flatMap((key) =>
        ["test-canary", ""].map((value) => ({
          ...probe,
          headers: { ...probe.headers, [key]: value },
        })),
      ),
    ]) {
      expect(rejectPortProbe(request as IncomingMessage, response)).toBe(false);
    }
    expect(end).toHaveBeenCalledOnce();
  });
});
