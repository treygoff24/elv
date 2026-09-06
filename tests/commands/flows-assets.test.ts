import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildAssetDeleteInput,
  buildAssetGetInput,
  buildAssetUploadInput,
  buildAssetsListInput,
} from "../../src/commands/aliases/assets";
import {
  buildFlowCreateInput,
  buildFlowGetInput,
  buildFlowListInput,
} from "../../src/commands/aliases/flows";
import {
  arrayValue,
  errorRecord,
  filesArray,
  parseEnvelope,
  recordValue,
  runCli,
} from "../helpers/cli-result";
import { rejectPortProbe } from "../helpers/http";

describe("Flows and assets input mapping", () => {
  it("preserves model-specific JSON while explicit flags override matching fields", () => {
    expect(
      buildFlowCreateInput("image", {
        model: "gpt-image-1",
        prompt: "A lighthouse",
        json: '{"model_id":"other","prompt":"old","quality":"high","images":[{"asset_id":"a1"}]}',
      }),
    ).toEqual({
      operationId: "create_image_generation",
      input: {
        body: {
          model_id: "gpt-image-1",
          prompt: "A lighthouse",
          quality: "high",
          images: [{ asset_id: "a1" }],
        },
      },
    });
    expect(
      buildFlowCreateInput("speech", { model: "eleven_v3", text: "Hello", voiceId: "v1" }),
    ).toEqual({
      operationId: "create_text_to_speech_generation",
      input: { body: { model_id: "eleven_v3", text: "Hello", voice: "v1" } },
    });
  });

  it("maps get and list filters for every generation family", () => {
    for (const [kind, operation] of [
      ["image", "image"],
      ["video", "video"],
      ["speech", "text_to_speech"],
    ] as const) {
      expect(buildFlowGetInput(kind, { generationId: "g1" })).toEqual({
        operationId: `get_${operation}_generation`,
        input: { path: { generation_id: "g1" } },
      });
      expect(
        buildFlowListInput(kind, { cursor: "next", pageSize: "5", status: "failed", model: "m1" }),
      ).toEqual({
        operationId: `list_${operation}_generations`,
        input: { query: { cursor: "next", page_size: 5, status: "failed", model_id: "m1" } },
      });
    }
  });

  it("maps multipart asset uploads and asset lifecycle paths", () => {
    expect(buildAssetUploadInput({ file: "image.png" })).toEqual({
      operationId: "upload_asset",
      input: { files: { asset: resolve("image.png") }, body: { name: "image.png" } },
    });
    expect(
      buildAssetUploadInput({ file: "image.png", json: '{"name":"Reference"}' }).input.body,
    ).toEqual({ name: "Reference" });
    expect(
      buildAssetUploadInput({ file: "image.png", name: "Override", json: '{"name":"Old"}' }).input
        .body,
    ).toEqual({ name: "Override" });
    expect(buildAssetsListInput({ search: "image", pageSize: "10", cursor: "next" })).toEqual({
      operationId: "list_assets",
      input: { query: { search: "image", page_size: 10, cursor: "next" } },
    });
    expect(buildAssetGetInput({ assetId: "a1" })).toEqual({
      operationId: "get_asset",
      input: { path: { asset_id: "a1" } },
    });
    expect(buildAssetDeleteInput({ assetId: "a1" })).toEqual({
      operationId: "delete_asset_endpoint",
      input: { path: { asset_id: "a1" } },
    });
  });

  it("rejects conflicting sources, missing paths and malformed JSON", () => {
    expect(() => buildFlowGetInput("image", {})).toThrow("--generation-id");
    expect(() => buildAssetGetInput({})).toThrow("--asset-id");
    expect(() => buildAssetUploadInput({})).toThrow("--file");
    expect(() => buildFlowCreateInput("speech", { text: "Hello", textFile: "/not/read" })).toThrow(
      "--text or --text-file",
    );
    expect(() => buildFlowCreateInput("image", { json: "{}", jsonFile: "/not/read" })).toThrow(
      "--json or --json-file",
    );
    expect(() => buildFlowCreateInput("image", { json: "[]" })).toThrow("JSON must be an object");
  });
});

describe("Flows and assets CLI against offline/mock transport", () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let nextGenerationId = "g1";
  const requests: Array<{ method: string; url: string; body: string }> = [];

  function run(args: string[]) {
    return runCli(args, {
      ELEVENLABS_BASE_URL: baseUrl,
      ELEVENLABS_API_KEY: "test_key_CANARY",
      ELV_MAX_CREDITS: "",
      ELV_CACHE_DIR: join(dir, "cache"),
      ELV_OUTPUT_DIR: join(dir, "output"),
    });
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "elv-flows-assets-"));
    writeFileSync(join(dir, "reference.png"), "mock-image-bytes");
    writeFileSync(join(dir, "text.txt"), "Hello from file");
    writeFileSync(
      join(dir, "image.json"),
      '{"model_id":"gpt-image-1","prompt":"A lighthouse","quality":"high"}',
    );
    server = createServer(async (req, res) => {
      if (rejectPortProbe(req, res)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "DELETE" && url.pathname === "/v1/assets/a1") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST" && url.pathname.startsWith("/v1/flows/")) {
        res.end(JSON.stringify({ id: nextGenerationId, status: "pending" }));
        return;
      }
      if (url.pathname === "/v1/flows/image/g_complete") {
        res.end(
          JSON.stringify({
            id: "g_complete",
            status: "completed",
            content_mime_type: "image/png",
            content_url:
              "https://storage.example/image.png?X-Goog-Signature=mock-private-signature",
          }),
        );
        return;
      }
      if (url.pathname === "/v1/flows/image/g_failed") {
        res.end(
          JSON.stringify({
            id: "g_failed",
            status: "failed",
            error: { message: "Generation failed" },
          }),
        );
        return;
      }
      if (
        req.method === "GET" &&
        /^\/v1\/flows\/(image|video|text-to-speech)\/g1$/.test(url.pathname)
      ) {
        res.end(JSON.stringify({ id: "g1", status: "generating" }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/v1/flows/")) {
        const second = url.searchParams.get("cursor") === "page2";
        res.end(
          JSON.stringify({
            generations: [{ id: second ? "g2" : "g1", status: "pending" }],
            next_cursor: second ? null : "page2",
            has_more: !second,
          }),
        );
        return;
      }
      if (url.pathname === "/v1/assets" && req.method === "GET") {
        res.end(
          JSON.stringify({
            assets: [
              {
                asset_id: "a1",
                name: "Reference",
                mime_type: "image/png",
                created_at_unix: 1,
                content_url: null,
              },
            ],
            next_cursor: null,
            has_more: false,
          }),
        );
        return;
      }
      if (url.pathname === "/v1/assets" || url.pathname === "/v1/assets/a1") {
        res.end(
          JSON.stringify({
            asset_id: "a1",
            name: "Reference",
            mime_type: "image/png",
            created_at_unix: 1,
            content_url: null,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ detail: "Unmatched mock route" }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    [
      "image",
      "image",
      ["--json-file", "image.json"],
      { model_id: "gpt-image-1", prompt: "A lighthouse", quality: "high" },
    ],
    [
      "video",
      "video",
      ["--model", "veo-3.1-generate-001", "--prompt", "Waves", "--json", '{"duration_secs":4}'],
      { model_id: "veo-3.1-generate-001", prompt: "Waves", duration_secs: 4 },
    ],
    [
      "speech",
      "text-to-speech",
      ["--model", "eleven_v3", "--voice-id", "v1", "--text-file", "text.txt"],
      { model_id: "eleven_v3", voice: "v1", text: "Hello from file" },
    ],
  ])("previews and submits a matched mock %s create request", async (kind, path, args, body) => {
    const flags = (args as string[]).map((value) =>
      ["image.json", "text.txt"].includes(value) ? join(dir, value) : value,
    );
    const before = requests.length;
    const dry = await run(["flows", kind as string, "create", ...flags, "--dry-run"]);
    expect(dry.code, dry.stdout).toBe(0);
    expect(requests).toHaveLength(before);
    const envelope = parseEnvelope(dry.stdout);
    expect(recordValue(recordValue(envelope.data).request)).toMatchObject({
      method: "POST",
      path: `/v1/flows/${path}`,
    });
    expect(recordValue(recordValue(recordValue(envelope.data).request).input).body).toEqual(body);
    const created = await run(["flows", kind as string, "create", ...flags]);
    expect(created.code, created.stdout).toBe(0);
    expect(parseEnvelope(created.stdout).data).toEqual({ id: "g1", status: "pending" });
    expect(requests.at(-1)).toMatchObject({ method: "POST", url: `/v1/flows/${path}` });
    expect(JSON.parse(requests.at(-1)!.body)).toEqual(body);
  });

  it("gets every generation family and an asset using their documented paths", async () => {
    for (const [kind, path] of [
      ["image", "image"],
      ["video", "video"],
      ["speech", "text-to-speech"],
    ]) {
      const result = await run(["flows", kind!, "get", "--generation-id", "g1"]);
      expect(result.code, result.stdout).toBe(0);
      expect(parseEnvelope(result.stdout).data).toEqual({ id: "g1", status: "generating" });
      expect(requests.at(-1)?.url).toBe(`/v1/flows/${path}/g1`);
    }
    const result = await run(["assets", "get", "--asset-id", "a1"]);
    expect(result.code, result.stdout).toBe(0);
    expect(requests.at(-1)?.url).toBe("/v1/assets/a1");
  });

  it("waits for terminal status without exposing signed output URLs", async () => {
    const before = requests.length;
    const flags = [
      "flows",
      "image",
      "create",
      "--model",
      "gpt-image-1",
      "--prompt",
      "A lighthouse",
      "--wait",
      "--out",
      join(dir, "wait-output"),
    ];
    const preview = await run([...flags, "--dry-run"]);
    expect(preview.code, preview.stdout).toBe(0);
    expect(requests).toHaveLength(before);
    nextGenerationId = "g_complete";
    try {
      const result = await run(flags);
      expect(result.code, result.stdout).toBe(0);
      expect(parseEnvelope(result.stdout).data).toMatchObject({
        id: "g_complete",
        status: "completed",
        content_url: "[REDACTED]",
      });
      expect(result.stdout).not.toContain("mock-private-signature");
      const secure = filesArray(parseEnvelope(result.stdout)).find(
        (file) => file.sensitive === true,
      );
      expect(secure).toBeDefined();
      expect(typeof secure?.path).toBe("string");
      const securePath = secure!.path as string;
      expect(statSync(securePath).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(securePath, "utf8")).content_url).toContain(
        "mock-private-signature",
      );
      expect(requests.slice(before).map(({ method, url }) => `${method} ${url}`)).toEqual([
        "POST /v1/flows/image",
        "GET /v1/flows/image/g_complete",
      ]);
    } finally {
      nextGenerationId = "g1";
    }
  });

  it("names the re-poll command when --wait passes its deadline", async () => {
    const before = requests.length;
    const result = await run([
      "flows",
      "video",
      "create",
      "--model",
      "veo-3.1-generate-001",
      "--prompt",
      "Waves",
      "--wait",
      "--interval-ms",
      "20",
      "--timeout-ms",
      "150",
    ]);

    expect(result.code, result.stdout).toBe(7);
    const envelope = parseEnvelope(result.stdout);
    const error = errorRecord(envelope);
    expect(error.code).toBe("wait_timeout");
    expect(String(error.message)).toContain("150ms");
    // The creation receipt must survive the timeout: the id identifies a paid job.
    const polled = recordValue(recordValue(recordValue(error.raw).envelope).data);
    expect(polled).toMatchObject({ id: "g1", status: "generating" });
    const hints = arrayValue(envelope.hints).map((hint) => recordValue(hint));
    expect(hints[0]?.cmd).toBe("elv flows video get --generation-id g1");
    expect(String(hints[1]?.cmd)).toContain("--timeout-ms");
    const calls = requests.slice(before).map(({ method, url }) => `${method} ${url}`);
    expect(calls[0]).toBe("POST /v1/flows/video");
    expect(calls.slice(1).every((call) => call === "GET /v1/flows/video/g1")).toBe(true);
    expect(calls.length).toBeGreaterThan(1);
  });

  it("rejects a non-positive --timeout-ms before submitting a paid generation", async () => {
    const before = requests.length;
    const result = await run([
      "flows",
      "video",
      "create",
      "--model",
      "veo-3.1-generate-001",
      "--prompt",
      "Waves",
      "--wait",
      "--timeout-ms",
      "0",
    ]);

    expect(result.code, result.stdout).toBe(2);
    expect(String(errorRecord(parseEnvelope(result.stdout)).message)).toContain(
      "--timeout-ms must be positive",
    );
    expect(requests).toHaveLength(before);
  });

  it("returns a failure envelope when a waited generation fails", async () => {
    nextGenerationId = "g_failed";
    try {
      const result = await run([
        "flows",
        "image",
        "create",
        "--model",
        "gpt-image-1",
        "--prompt",
        "A lighthouse",
        "--wait",
      ]);
      expect(result.code, result.stdout).toBe(8);
      expect(errorRecord(parseEnvelope(result.stdout)).code).toBe("wait_failure");
      expect(requests.at(-1)?.url).toBe("/v1/flows/image/g_failed");
    } finally {
      nextGenerationId = "g1";
    }
  });

  it("previews file mapping then uploads actual multipart bytes to the mock", async () => {
    const file = join(dir, "reference.png");
    const before = requests.length;
    const preview = await run(["assets", "upload", "--file", file, "--dry-run"]);
    expect(preview.code, preview.stdout).toBe(0);
    expect(requests).toHaveLength(before);
    const request = recordValue(recordValue(parseEnvelope(preview.stdout).data).request);
    expect(recordValue(request.input).files).toEqual({ asset: file });
    expect(recordValue(request.input).body).toEqual({ name: "reference.png" });
    const result = await run(["assets", "upload", "--file", file, "--name", "Reference"]);
    expect(result.code, result.stdout).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: "POST", url: "/v1/assets" });
    expect(requests.at(-1)?.body).toContain('name="asset"; filename="reference.png"');
    expect(requests.at(-1)?.body).toContain("mock-image-bytes");
    expect(requests.at(-1)?.body).toContain("Reference");
  });

  it("paginates generations to disk and maps asset list filters", async () => {
    const out = join(dir, "generations.json");
    const before = requests.length;
    const result = await run([
      "flows",
      "image",
      "list",
      "--all",
      "--save-json",
      out,
      "--page-size",
      "1",
      "--status",
      "pending",
    ]);
    expect(result.code, result.stdout).toBe(0);
    expect(
      requests
        .slice(before)
        .map((request) => new URL(request.url, baseUrl).searchParams.get("cursor")),
      JSON.stringify(requests.slice(before)),
    ).toEqual([null, "page2"]);
    const saved = JSON.parse(readFileSync(out, "utf8"));
    expect(saved).toEqual([
      { id: "g1", status: "pending" },
      { id: "g2", status: "pending" },
    ]);
    const listed = await run([
      "assets",
      "list",
      "--search",
      "Reference",
      "--cursor",
      "next",
      "--limit",
      "1",
    ]);
    expect(listed.code, listed.stdout).toBe(0);
    const query = new URL(requests.at(-1)!.url, baseUrl).searchParams;
    expect(query.get("search")).toBe("Reference");
    expect(query.get("cursor")).toBe("next");
    expect(query.get("page_size")).toBe("1");
  });

  it("keeps projected list fields inline for all generation families", async () => {
    for (const kind of ["image", "video", "speech"]) {
      const result = await run(["flows", kind, "list", "--fields", "id", "--limit", "1"]);
      expect(result.code, result.stdout).toBe(0);
      expect(recordValue(parseEnvelope(result.stdout).data).generations).toEqual([{ id: "g1" }]);
    }
  });

  it("blocks unbounded generation under a credit ceiling before network", async () => {
    const before = requests.length;
    const args = [
      "flows",
      "image",
      "create",
      "--model",
      "gpt-image-1",
      "--prompt",
      "A lighthouse",
      "--max-credits",
      "1",
    ];
    const blocked = await run(args);
    expect(blocked.code, blocked.stdout).toBe(5);
    expect(parseEnvelope(blocked.stdout).ok).toBe(false);
    const preview = await run([...args, "--dry-run"]);
    expect(preview.code, preview.stdout).toBe(0);
    expect(recordValue(parseEnvelope(preview.stdout).data).would_exceed_budget).toBe(true);
    expect(requests).toHaveLength(before);
  });

  it.each([
    ["flows", "image", "create", "--model", "gpt-image-1"],
    ["flows", "video", "create", "--json", '{"model_id":"not-a-model","prompt":"Waves"}'],
    ["flows", "speech", "create", "--model", "eleven_v3", "--text", "Hello"],
    ["flows", "image", "get"],
    ["flows", "video", "list", "--status", "invalid"],
    ["assets", "upload"],
    ["assets", "get"],
    ["assets", "list", "--page-size", "101"],
  ])("rejects invalid %j input before network", async (...args) => {
    const before = requests.length;
    const result = await run(args);
    expect(result.code, result.stdout).toBe(2);
    expect(parseEnvelope(result.stdout).ok).toBe(false);
    expect(requests).toHaveLength(before);
  });

  it("gates deletion before network, permits dry-run, and deletes with --yes", async () => {
    const before = requests.length;
    const blocked = await run(["assets", "delete", "--asset-id", "a1"]);
    expect(blocked.code, blocked.stdout).toBe(4);
    expect(errorRecord(parseEnvelope(blocked.stdout)).code).toBe("confirmation");
    const preview = await run(["assets", "delete", "--asset-id", "a1", "--dry-run"]);
    expect(preview.code, preview.stdout).toBe(0);
    expect(recordValue(parseEnvelope(preview.stdout).data).would_require_yes).toBe(true);
    expect(requests).toHaveLength(before);
    const removed = await run(["assets", "delete", "--asset-id", "a1", "--yes"]);
    expect(removed.code, removed.stdout).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: "DELETE", url: "/v1/assets/a1" });
  });
});
