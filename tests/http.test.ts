import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../src/commands/http";

describe("http command", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends an off-registry arbitrary path through auth, retry, and response normalization", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, beta: 1 }), {
        status: 200,
        headers: { "content-type": "application/json", "request-id": "req_http" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const env = await runHttp("GET", "/v1/beta/thing", {
      query: ["a=1"],
      baseUrl: "https://api.test",
      apiKey: "sk_test_secret",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/v1/beta/thing?a=1");
    expect((init as RequestInit).headers).toMatchObject({ "xi-api-key": "sk_test_secret" });
    expect(env).toMatchObject({
      ok: true,
      cmd: "elv http GET /v1/beta/thing",
      operation_id: "http",
      http: { status: 200, method: "GET", path: "/v1/beta/thing" },
      request: { id: "req_http" },
      data: { ok: true, beta: 1 },
    });
  });
});
