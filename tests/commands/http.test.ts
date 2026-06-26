import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";

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

  it("requires --yes before raw DELETE hits the network", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const env = await runHttp("DELETE", "/v1/beta/thing", {
      baseUrl: "https://api.test",
      apiKey: "sk_test_secret",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(env).toMatchObject({
      ok: false,
      operation_id: "http",
      error: { code: "confirmation" },
    });
  });

  it("requires --yes for registry-backed raw external side effects", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const env = await runHttp("POST", "/v1/convai/twilio/outbound-call", {
      bodyJson: "{}",
      baseUrl: "https://api.test",
      apiKey: "sk_test_secret",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(env).toMatchObject({
      ok: false,
      operation_id: "http",
      error: { code: "confirmation" },
    });
  });

  it("requires --yes for off-registry raw outbound paths", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const env = await runHttp("POST", "/v1/private/outbound-message", {
      bodyJson: "{}",
      baseUrl: "https://api.test",
      apiKey: "sk_test_secret",
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(env).toMatchObject({
      ok: false,
      operation_id: "http",
      error: { code: "confirmation" },
    });
  });

  it("keeps large --all pages inline for collection", async () => {
    const out = mkdtempSync(join(tmpdir(), "elv-http-pages-"));
    try {
      const voices = Array.from({ length: 800 }, (_, i) => ({
        voice_id: `voice_${i}`,
        name: `Voice ${i}`,
        description: "x".repeat(80),
      }));
      const fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ voices, has_more: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetch);

      const env = await runHttp("GET", "/v2/voices", {
        all: true,
        out,
        baseUrl: "https://api.test",
        apiKey: "sk_test_secret",
      });

      expect(env.ok).toBe(true);
      if (!env.ok) throw new Error("expected success");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(env.files).toHaveLength(1);
      const saved = JSON.parse(readFileSync(env.files![0]!.path, "utf8")) as unknown[];
      expect(saved).toHaveLength(voices.length);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
