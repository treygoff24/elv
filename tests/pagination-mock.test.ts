import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CANARY_KEY = "test_key_CANARY";
const CALL_TIMEOUT_MS = 30_000;
const PAGE_ONE_SIZE = 20;
const PAGE_TWO_SIZE = 5;

interface ElvResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function parseEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  expect(trimmed.length).toBeGreaterThan(0);
  const parsed: unknown = JSON.parse(trimmed);
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  return parsed as Record<string, unknown>;
}

function historyItem(id: string): Record<string, string> {
  return { history_item_id: id, text: `item ${id}` };
}

function buildHistoryPage(start: number, count: number, hasMore: boolean, lastId: string | null) {
  const history = Array.from({ length: count }, (_, i) => historyItem(`hist_${start + i}`));
  return {
    history,
    has_more: hasMore,
    ...(lastId ? { last_history_item_id: lastId } : {}),
  };
}

describe("pagination mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let historyRequestCount = 0;
  let voicesRequestCount = 0;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runElv(args: string[], env?: Record<string, string>): Promise<ElvResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["tsx", "src/cli.ts", ...args], {
        env: {
          ...process.env,
          ELEVENLABS_BASE_URL: baseUrl,
          ELEVENLABS_API_KEY: CANARY_KEY,
          ELV_CACHE_DIR: cacheDir,
          ...env,
        },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code: number | null) => resolve({ stdout, stderr, code }));
    });
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-pagination-cache-"));

    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v1/history") {
        historyRequestCount += 1;
        const cursor = url.searchParams.get("start_after_history_item_id");

        if (!cursor) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(buildHistoryPage(0, PAGE_ONE_SIZE, true, "page1_last")));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildHistoryPage(PAGE_ONE_SIZE, PAGE_TWO_SIZE, false, null)));
        return;
      }

      if (method === "GET" && path === "/v1/voices") {
        voicesRequestCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            voices: [{ voice_id: "v1", name: "Rachel" }],
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "not found" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("failed to bind mock server");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it(
    "get_speech_history --all --out writes the full paginated set (AC #25)",
    async () => {
      historyRequestCount = 0;
      const outDir = mkdtempSync(join(tmpdir(), "elv-pagination-out-"));

      try {
        const { stdout, code } = await runElv([
          "call",
          "get_speech_history",
          "--all",
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        expect(historyRequestCount).toBeGreaterThanOrEqual(2);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.v).toBe(1);

        const savedFiles = readdirSync(outDir);
        expect(savedFiles.length).toBeGreaterThan(0);

        const jsonFiles = savedFiles.filter((name) => name.endsWith(".json"));
        expect(jsonFiles.length).toBeGreaterThan(0);

        const combined = jsonFiles
          .map((name) => readFileSync(join(outDir, name), "utf8"))
          .join("\n");
        const totalItems = (combined.match(/history_item_id/g) ?? []).length;
        expect(totalItems).toBe(PAGE_ONE_SIZE + PAGE_TWO_SIZE);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "get_speech_history without --all returns at most 20 items and a next command",
    async () => {
      historyRequestCount = 0;

      const { stdout, code } = await runElv(["call", "get_speech_history"]);

      expect(code).toBe(0);
      expect(historyRequestCount).toBe(1);

      const envelope = parseEnvelope(stdout);
      expect(envelope.ok).toBe(true);

      const data = envelope.data as Record<string, unknown>;
      const history = (data.history ?? data.items) as unknown;
      expect(Array.isArray(history)).toBe(true);
      expect((history as unknown[]).length).toBeLessThanOrEqual(PAGE_ONE_SIZE);

      const next = (data.next ?? envelope.next) as Record<string, unknown> | undefined;
      expect(next).toBeDefined();
      const nextCmd = String(next?.cmd ?? "");
      expect(nextCmd).toMatch(/get_speech_history/);
      expect(nextCmd).toMatch(/start_after_history_item_id/);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "get_voices --all performs a single fetch for non-paginated endpoint",
    async () => {
      voicesRequestCount = 0;
      const outDir = mkdtempSync(join(tmpdir(), "elv-pagination-out-"));

      try {
        const { stdout, code } = await runElv(["call", "get_voices", "--all", "--out", outDir]);

        expect(code).toBe(0);
        expect(voicesRequestCount).toBe(1);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        // --all writes the full set to disk and never floods stdout (spec §17), so the
        // collected voices live in the saved file, not inline in envelope.data.
        const files = readdirSync(outDir);
        expect(files.length).toBeGreaterThan(0);
        const jsonPath = join(outDir, files.find((f) => f.endsWith(".json")) ?? files[0]!);
        expect(existsSync(jsonPath)).toBe(true);
        expect(statSync(jsonPath).size).toBeGreaterThan(0);

        const saved: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
        const savedItems = Array.isArray(saved)
          ? saved
          : ((saved as Record<string, unknown>).voices as unknown[]);
        expect(Array.isArray(savedItems)).toBe(true);
        expect(JSON.stringify(savedItems)).toContain("voice_id");
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );
});
