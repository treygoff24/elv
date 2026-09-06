import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRtc } from "../../src/commands/rtc";
import { parseEnvelope, runCli } from "../helpers/cli-result";
import { rejectPortProbe } from "../helpers/http";

let directory: string;
let server: Server;
let url: string;
let requests: number;
let tokenRequests: URL[];
let serveToken: boolean;
const token = "RTC_PRIVATE_CANARY";

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "elv-rtc-command-"));
  requests = 0;
  tokenRequests = [];
  serveToken = false;
  server = createServer((req, res) => {
    if (rejectPortProbe(req, res)) return;
    requests += 1;
    const requested = new URL(req.url ?? "/", "http://localhost");
    if (serveToken && requested.pathname === "/v1/convai/conversation/token") {
      tokenRequests.push(requested);
      expect(req.headers["xi-api-key"]).toBe("test_key_CANARY");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token, conversation_id: "conv_trace" }));
      return;
    }
    res.writeHead(403);
    res.end("not a real RTC server");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  url = `ws://127.0.0.1:${address.port}`;
  vi.stubEnv("ELV_RTC_TEST_TOKEN", token);
  vi.stubEnv("ELV_CACHE_DIR", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe("WebRTC command preflight", () => {
  it("does not connect, read duplex stdin, write files or disclose tokens during dry-run", async () => {
    const input = new PassThrough();
    const result = await runRtc(
      { serverUrl: url, tokenEnv: "ELV_RTC_TEST_TOKEN", duplex: true },
      { dryRun: true, out: directory, duplexInput: input, maxCredits: 0 },
    );
    expect(result).toMatchObject({
      exitCode: 0,
      env: {
        ok: true,
        data: {
          dry_run: true,
          transport: "webrtc",
          token_present: true,
          duplex: true,
          would_require_yes: true,
          would_exceed_budget: true,
        },
      },
    });
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("readable")).toBe(0);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(readdirSync(directory)).toEqual([]);
    expect(requests).toBe(0);
    input.destroy();
  });

  it("requires confirmation before joining even a receive-only session", async () => {
    const result = await runRtc(
      { serverUrl: url, tokenEnv: "ELV_RTC_TEST_TOKEN", timeoutMs: "200" },
      { out: directory },
    );
    expect(result.exitCode).toBe(4);
    expect(requests).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("fails closed under a ceiling even with --yes and an existing token", async () => {
    const result = await runRtc(
      { serverUrl: url, tokenEnv: "ELV_RTC_TEST_TOKEN", timeoutMs: "200" },
      { yes: true, maxCredits: 100, out: directory },
    );
    expect(result.exitCode).toBe(5);
    expect(requests).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  it.each([{ dryRun: true }, {}, { yes: true, maxCredits: 0 }])(
    "does not fetch an agent token before the execution gates: %j",
    async (options) => {
      const result = await runRtc(
        { serverUrl: url, agentId: "agent_test" },
        { ...options, baseUrl: url.replace("ws:", "http:"), out: directory },
      );
      expect(result.exitCode).toBe(options.dryRun ? 0 : "maxCredits" in options ? 5 : 4);
      expect(requests).toBe(0);
    },
  );

  it("accepts a private token response without exposing its contents", async () => {
    const path = join(directory, "token-sensitive.json");
    writeFileSync(path, JSON.stringify({ token, conversation_id: "conv_test" }), { mode: 0o600 });
    const result = await runRtc(
      { serverUrl: url, tokenFile: path },
      { dryRun: true, out: directory },
    );
    expect(result).toMatchObject({ exitCode: 0, env: { data: { token_present: true } } });
    expect(JSON.stringify(result)).not.toContain(token);
    writeFileSync(path, `broken JSON ${token}`);
    const invalid = await runRtc(
      { serverUrl: url, tokenFile: path },
      { dryRun: true, out: directory },
    );
    expect(invalid.exitCode).toBe(2);
    expect(JSON.stringify(invalid)).not.toContain(token);
    expect(requests).toBe(0);
  });

  it("fetches all token options after approval and retains the private receipt when connection fails", async () => {
    serveToken = true;
    const result = await runRtc(
      {
        serverUrl: url,
        agentId: "agent_test",
        participantName: "CLI test",
        branchId: "branch_test",
        environment: "staging",
        debugEvents: true,
        timeoutMs: "1000",
      },
      {
        yes: true,
        baseUrl: url.replace("ws:", "http:"),
        apiKey: "test_key_CANARY",
        out: directory,
      },
    );
    expect(result.exitCode).toBe(8);
    expect(tokenRequests).toHaveLength(1);
    expect(Object.fromEntries(tokenRequests[0]!.searchParams)).toEqual({
      agent_id: "agent_test",
      participant_name: "CLI test",
      branch_id: "branch_test",
      environment: "staging",
      debug_events_request: "true",
    });
    expect(result.env).toMatchObject({ error: { raw: { conversation_id: "conv_trace" } } });
    const privateFile = result.env.files?.find((file) => file.sensitive);
    expect(privateFile).toBeDefined();
    expect(statSync(privateFile!.path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(privateFile!.path, "utf8"))).toEqual({
      token,
      conversation_id: "conv_trace",
    });
    expect(JSON.stringify(result)).not.toContain(token);
  }, 15_000);

  it("rejects credentials in server URLs without reflecting them", async () => {
    const result = await runRtc(
      { serverUrl: `wss://example.invalid/?token=${token}` },
      { dryRun: true },
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("requires an explicit server for an undocumented regional mapping", async () => {
    const result = await runRtc(
      {},
      { dryRun: true, baseUrl: "https://api.sg.residency.elevenlabs.io" },
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result)).toContain("--server-url");
  });

  it.each([
    ["https://api.elevenlabs.io", "wss://livekit.rtc.elevenlabs.io/"],
    ["https://api.eu.residency.elevenlabs.io", "wss://livekit.rtc.eu.residency.elevenlabs.io/"],
    ["https://api.in.residency.elevenlabs.io", "wss://livekit.rtc.in.residency.elevenlabs.io/"],
  ])("uses the documented regional server for %s", async (baseUrl, serverUrl) => {
    const result = await runRtc({}, { dryRun: true, baseUrl });
    expect(result).toMatchObject({ exitCode: 0, env: { data: { server_url: serverUrl } } });
  });

  it("rejects incompatible token sources, output targets, and limits before connecting", async () => {
    for (const flags of [
      { agentId: "agent_test", tokenEnv: "ELV_RTC_TEST_TOKEN" },
      { tokenEnv: "ELV_RTC_TEST_TOKEN", tokenFile: "none" },
      { maxTracks: "0" },
      { timeoutMs: "-1" },
      { maxAudioBytes: "1.5" },
    ]) {
      expect(
        (await runRtc({ serverUrl: url, ...flags }, { dryRun: true, out: directory })).exitCode,
      ).toBe(2);
    }
    expect(
      (await runRtc({ serverUrl: url }, { dryRun: true, out: join(directory, "out.mp3") }))
        .exitCode,
    ).toBe(2);
    expect(requests).toBe(0);
  });

  it("validates audio file shape before a paid connection", async () => {
    const path = join(directory, "script.ndjson");
    writeFileSync(
      path,
      JSON.stringify({
        type: "send_audio_file",
        path: "missing.pcm",
        sample_rate: 48000,
        channels: 1,
      }),
    );
    const result = await runRtc(
      { serverUrl: url, tokenEnv: "ELV_RTC_TEST_TOKEN", send: path },
      { yes: true, out: directory },
    );
    expect(result.exitCode).toBe(2);
    expect(requests).toBe(0);
  });

  it("prints exactly one envelope through the CLI dry-run path", async () => {
    const result = await runCli(
      ["rtc", "--server-url", url, "--token-env", "ELV_RTC_TEST_TOKEN", "--duplex", "--dry-run"],
      { ELV_CACHE_DIR: directory },
    );
    expect(result.code, result.stderr).toBe(0);
    expect(parseEnvelope(result.stdout)).toMatchObject({
      ok: true,
      cmd: "elv rtc",
      data: { transport: "webrtc" },
    });
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(requests).toBe(0);
  });
});
