import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  arrayValue,
  errorRecord,
  parseEnvelope,
  recordValue,
  runCli,
  type CliResult,
} from "../helpers/cli-result";

const CANARY_KEY = "test_key_CANARY";
const CALL_TIMEOUT_MS = 30_000;
const SIGNED_URL = "https://signed.example/media?token=SHOULD_NOT_LEAK";

type FlowMode = "success" | "failure" | "timeout";

describe("assets and flows aliases mock server", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let assetPath: string;
  let assetRequests = 0;
  let deleteRequests = 0;
  let uploadRequests = 0;
  let flowListRequests = 0;
  let flowCreateRequests = 0;
  let flowPolls = 0;
  let summaryRequests = 0;
  let flowMode: FlowMode = "success";
  let lastQuery: URLSearchParams = new URLSearchParams();

  function runElv(args: string[], env?: Record<string, string>): Promise<CliResult> {
    return runCli(args, {
      ELEVENLABS_BASE_URL: baseUrl,
      ELEVENLABS_API_KEY: CANARY_KEY,
      ELV_CACHE_DIR: cacheDir,
      ...env,
    });
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-assets-flows-cache-"));
    assetPath = join(tmpdir(), `elv-asset-${Date.now()}.txt`);
    writeFileSync(assetPath, "asset bytes");

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v1/assets") {
        assetRequests += 1;
        lastQuery = url.searchParams;
        const cursor = url.searchParams.get("cursor");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            assets: [
              {
                id: cursor ? "asset_2" : "asset_1",
                name: cursor ? "second" : "first",
                content_url: SIGNED_URL,
              },
            ],
            has_more: !cursor,
            next_cursor: cursor ? null : "cursor_2",
          }),
        );
        return;
      }

      if (method === "DELETE" && path === "/v1/assets/asset_1") {
        deleteRequests += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (method === "POST" && path === "/v1/assets") {
        uploadRequests += 1;
        await drain(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "asset_uploaded", name: "uploaded" }));
        return;
      }

      const flowCreateMatch = /^\/v1\/flows\/(image|video|text-to-speech)$/u.exec(path);
      if (method === "POST" && flowCreateMatch) {
        flowCreateRequests += 1;
        await drain(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "gen_1", status: "pending" }));
        return;
      }

      if (method === "GET" && path === "/v1/flows/image") {
        flowListRequests += 1;
        lastQuery = url.searchParams;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            generations: [{ id: "gen_list_1", status: "completed", content_url: SIGNED_URL }],
            has_more: true,
            next_cursor: "next_gen",
          }),
        );
        return;
      }

      const flowGetMatch = /^\/v1\/flows\/(image|video|text-to-speech)\/gen_1$/u.exec(path);
      if (method === "GET" && flowGetMatch) {
        flowPolls += 1;
        const status =
          flowMode === "failure"
            ? "failed"
            : flowMode === "timeout" || flowPolls < 2
              ? "generating"
              : "completed";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "gen_1",
            status,
            ...(status === "completed" ? { content_url: SIGNED_URL } : {}),
          }),
        );
        return;
      }

      if (method === "GET" && path === "/v1/convai/conversations/conv_1/summary") {
        summaryRequests += 1;
        lastQuery = url.searchParams;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ conversation_id: "conv_1", status: "done", messages: [] }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("failed to bind mock server");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(assetPath, { force: true });
  });

  beforeEach(() => {
    assetRequests = 0;
    deleteRequests = 0;
    uploadRequests = 0;
    flowListRequests = 0;
    flowCreateRequests = 0;
    flowPolls = 0;
    summaryRequests = 0;
    flowMode = "success";
    lastQuery = new URLSearchParams();
  });

  it(
    "assets list maps filters, defaults page_size through pagination, and redacts signed URLs",
    async () => {
      const { stdout, code } = await runElv(["assets", "list", "--search", "logo", "--limit", "1"]);

      expect(code).toBe(0);
      expect(assetRequests).toBe(1);
      expect(lastQuery.get("search")).toBe("logo");
      expect(lastQuery.get("page_size")).toBe("1");
      expect(stdout).not.toContain(SIGNED_URL);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      const data = recordValue(envelope.data, "data");
      const assets = arrayValue(data.assets, "assets");
      expect(recordValue(assets[0]).content_url).toBe("[REDACTED]");
      expect(String(recordValue(data.next).cmd)).toContain("list_assets");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "assets list --all follows next_cursor and writes only redacted items",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-assets-all-"));
      try {
        const { stdout, code } = await runElv(["assets", "list", "--all", "--out", outDir]);

        expect(code).toBe(0);
        expect(assetRequests).toBe(2);
        expect(stdout).not.toContain(SIGNED_URL);
        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        const files = arrayValue(envelope.files, "files");
        const file = recordValue(files[0], "files[0]");
        const path = String(file.path);
        expect(existsSync(path)).toBe(true);
        const saved = readFileSync(path, "utf8");
        expect(saved).not.toContain(SIGNED_URL);
        expect(saved).toContain("[REDACTED]");
        expect(JSON.parse(saved)).toHaveLength(2);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "assets delete inherits central confirmation",
    async () => {
      const blocked = await runElv(["assets", "delete", "--id", "asset_1"]);
      expect(blocked.code).toBe(4);
      expect(errorRecord(parseEnvelope(blocked.stdout)).code).toBe("confirmation");
      expect(deleteRequests).toBe(0);

      const confirmed = await runElv(["assets", "delete", "--id", "asset_1", "--yes"]);
      expect(confirmed.code).toBe(0);
      expect(parseEnvelope(confirmed.stdout).ok).toBe(true);
      expect(deleteRequests).toBe(1);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "assets upload requires explicit unknown-budget consent under a ceiling",
    async () => {
      const blocked = await runElv(["assets", "upload", "--file", assetPath, "--max-credits", "1"]);
      expect(blocked.code).toBe(5);
      expect(errorRecord(parseEnvelope(blocked.stdout)).code).toBe("budget");
      expect(uploadRequests).toBe(0);

      const accepted = await runElv([
        "assets",
        "upload",
        "--file",
        assetPath,
        "--max-credits",
        "1",
        "--yes",
      ]);
      expect(accepted.code).toBe(0);
      expect(parseEnvelope(accepted.stdout).ok).toBe(true);
      expect(uploadRequests).toBe(1);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "assets upload validates missing files before network calls",
    async () => {
      const missing = join(tmpdir(), `elv-missing-${Date.now()}.txt`);
      const { stdout, code } = await runElv(["assets", "upload", "--file", missing, "--yes"]);

      expect(code).toBe(2);
      expect(uploadRequests).toBe(0);
      expect(errorRecord(parseEnvelope(stdout)).code).toBe("validation_error");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "flows image create validates --timeout-ms before network calls",
    async () => {
      const { stdout, code } = await runElv([
        "flows",
        "image",
        "create",
        "--json",
        '{"prompt":"blue fox","model_id":"gpt-image-1"}',
        "--wait",
        "--timeout-ms",
        "not-a-number",
      ]);

      expect(code).toBe(2);
      expect(flowCreateRequests).toBe(0);
      expect(errorRecord(parseEnvelope(stdout)).code).toBe("validation_error");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "flows create rejects --timeout-ms without --wait before network calls",
    async () => {
      const { stdout, code } = await runElv([
        "flows",
        "image",
        "create",
        "--json",
        '{"prompt":"blue fox","model_id":"gpt-image-1"}',
        "--timeout-ms",
        "5000",
      ]);

      expect(code).toBe(2);
      expect(flowCreateRequests).toBe(0);
      expect(String(errorRecord(parseEnvelope(stdout)).message)).toContain(
        "--timeout-ms requires --wait",
      );
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "flows image list maps filters, paginates, and redacts signed media URLs",
    async () => {
      const { stdout, code } = await runElv([
        "flows",
        "image",
        "list",
        "--status",
        "completed",
        "--model-id",
        "gpt-image-1",
        "--limit",
        "1",
      ]);

      expect(code).toBe(0);
      expect(flowListRequests).toBe(1);
      expect(lastQuery.get("status")).toBe("completed");
      expect(lastQuery.get("model_id")).toBe("gpt-image-1");
      expect(lastQuery.get("page_size")).toBe("1");
      expect(stdout).not.toContain(SIGNED_URL);
      const data = recordValue(parseEnvelope(stdout).data, "data");
      const generations = arrayValue(data.generations, "generations");
      expect(recordValue(generations[0]).content_url).toBe("[REDACTED]");
      expect(String(recordValue(data.next).cmd)).toContain("list_image_generations");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "agents conversations summary maps the conversation id and max_messages",
    async () => {
      const { stdout, code } = await runElv([
        "agents",
        "conversations",
        "summary",
        "--conversation-id",
        "conv_1",
        "--max-messages",
        "1",
      ]);

      expect(code).toBe(0);
      expect(summaryRequests).toBe(1);
      expect(lastQuery.get("max_messages")).toBe("1");
      expect(recordValue(parseEnvelope(stdout).data, "data").conversation_id).toBe("conv_1");
    },
    CALL_TIMEOUT_MS,
  );

  it.each(["0", "201", "1.5"])(
    "agents conversations summary rejects invalid --max-messages=%s before network",
    async (value) => {
      const { stdout, code } = await runElv([
        "agents",
        "conversations",
        "summary",
        "--conversation-id",
        "conv_1",
        "--max-messages",
        value,
      ]);

      expect(code).toBe(2);
      expect(summaryRequests).toBe(0);
      expect(String(errorRecord(parseEnvelope(stdout)).message)).toContain(
        "--max-messages must be an integer from 1 to 200",
      );
    },
    CALL_TIMEOUT_MS,
  );

  it.each(["1", "200"])(
    "agents conversations summary accepts boundary --max-messages=%s",
    async (value) => {
      const { stdout, code } = await runElv([
        "agents",
        "conversations",
        "summary",
        "--conversation-id",
        "conv_1",
        "--max-messages",
        value,
      ]);

      expect(code).toBe(0);
      expect(summaryRequests).toBe(1);
      expect(lastQuery.get("max_messages")).toBe(value);
      expect(recordValue(parseEnvelope(stdout).data, "data").conversation_id).toBe("conv_1");
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "flows image create --dry-run --wait emits the dry-run preview without polling",
    async () => {
      const { stdout, code } = await runElv([
        "flows",
        "image",
        "create",
        "--json",
        '{"prompt":"blue fox","model_id":"gpt-image-1"}',
        "--dry-run",
        "--wait",
      ]);

      expect(code).toBe(0);
      expect(flowCreateRequests).toBe(0);
      expect(flowPolls).toBe(0);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      expect(recordValue(envelope.data, "data").dry_run).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it.each([
    ["image", '{"prompt":"blue fox","model_id":"gpt-image-1"}'],
    [
      "video",
      '{"model_id":"creatify-aurora","image":{"type":"generation","generation_id":"img_1"},"audio":{"type":"generation","generation_id":"aud_1"}}',
    ],
    ["speech", '{"text":"hello","voice":"voice_1","model_id":"eleven_flash_v2_5"}'],
  ] as const)(
    "flows %s create --wait polls through the shared wait seam",
    async (kind, body) => {
      const { code } = await runElv([
        "flows",
        kind,
        "create",
        "--json",
        body,
        "--wait",
        "--timeout-ms",
        "5000",
      ]);

      expect(code).toBe(0);
      expect(flowCreateRequests).toBe(1);
      expect(flowPolls).toBeGreaterThanOrEqual(2);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "flows image create --wait emits the terminal poll response without leaking content_url",
    async () => {
      const { stdout, code } = await runElv([
        "flows",
        "image",
        "create",
        "--json",
        '{"prompt":"blue fox","model_id":"gpt-image-1"}',
        "--wait",
        "--timeout-ms",
        "5000",
      ]);

      expect(code).toBe(0);
      expect(flowCreateRequests).toBe(1);
      expect(flowPolls).toBeGreaterThanOrEqual(2);
      expect(stdout).not.toContain(SIGNED_URL);
      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);
      const data = recordValue(envelope.data, "data");
      expect(data.status).toBe("completed");
      expect(data.content_url).toBe("[REDACTED]");
      const files = arrayValue(envelope.files, "files");
      const file = recordValue(files[0], "files[0]");
      expect(file.sensitive).toBe(true);
      const mode = statSync(String(file.path)).mode & 0o777;
      expect(mode).toBe(0o600);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "flows image create --wait reports failed and timeout states",
    async () => {
      flowMode = "failure";
      const failed = await runElv([
        "flows",
        "image",
        "create",
        "--json",
        '{"prompt":"blue fox","model_id":"gpt-image-1"}',
        "--wait",
        "--timeout-ms",
        "5000",
      ]);
      expect(failed.code).not.toBe(0);
      expect(String(errorRecord(parseEnvelope(failed.stdout)).message)).toMatch(/failed/i);

      flowPolls = 0;
      flowMode = "timeout";
      const timedOut = await runElv([
        "flows",
        "image",
        "create",
        "--json",
        '{"prompt":"blue fox","model_id":"gpt-image-1"}',
        "--wait",
        "--timeout-ms",
        "50",
      ]);
      expect(timedOut.code).not.toBe(0);
      expect(String(errorRecord(parseEnvelope(timedOut.stdout)).code)).toMatch(/timeout/i);
    },
    CALL_TIMEOUT_MS,
  );
});

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on("data", () => undefined);
    req.on("end", () => resolve());
    req.on("error", reject);
  });
}
