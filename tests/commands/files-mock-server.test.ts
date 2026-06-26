import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertNoKeyLeak,
  filesArray,
  parseEnvelope,
  runCli,
  type CliResult,
} from "../helpers/cli-result";

const CANARY_KEY = "test_key_CANARY";
const FAKE_ISOLATED_AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01]);
const UPLOAD_MARKER = Buffer.from("ELV_MULTIPART_UPLOAD_MARKER_7f3a");
const CALL_TIMEOUT_MS = 30_000;
const LARGE_JSON_THRESHOLD = 32 * 1024;

const AUDIO_CHUNKS = [Buffer.from("AUD1"), Buffer.from("AUD2"), Buffer.from("AUD3")];
const EXPECTED_DECODED_AUDIO = Buffer.concat(AUDIO_CHUNKS);

interface AudioIsolationCapture {
  contentType: string | undefined;
  body: Buffer;
}

function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function buildLargeVoicesPayload(): { voices: Record<string, string>[] } {
  const voices = Array.from({ length: 1000 }, (_, i) => ({
    voice_id: `voice_${i}`,
    name: `Voice ${i}`,
    description: `Padding for large JSON spill test item ${i} `.repeat(8),
    category: "generated",
  }));
  return { voices };
}

function buildTimestampsNdjson(): string {
  return AUDIO_CHUNKS.map((chunk) =>
    JSON.stringify({
      audio_base64: chunk.toString("base64"),
      alignment: { characters: ["h", "i"] },
    }),
  ).join("\n");
}

describe("files mock server (black-box, integration gate)", () => {
  let server: Server;
  let baseUrl: string;
  let cacheDir: string;
  let lastAudioIsolation: AudioIsolationCapture | null = null;
  let largeVoicesJson: string;

  // Async spawn (NOT spawnSync): the mock server runs in THIS process, so the event
  // loop must stay free to service the spawned CLI's request — spawnSync would deadlock.
  function runCall(args: string[], env?: Record<string, string>): Promise<CliResult> {
    return runCli(args, {
      ELEVENLABS_BASE_URL: baseUrl,
      ELEVENLABS_API_KEY: CANARY_KEY,
      ELV_CACHE_DIR: cacheDir,
      ...env,
    });
  }

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), "elv-files-cache-"));
    largeVoicesJson = JSON.stringify(buildLargeVoicesPayload());
    expect(Buffer.byteLength(largeVoicesJson, "utf8")).toBeGreaterThan(LARGE_JSON_THRESHOLD);

    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (method === "GET" && path === "/v1/voices") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(largeVoicesJson);
        return;
      }

      if (method === "POST" && path === "/v1/audio-isolation") {
        const body = await readBodyBuffer(req);
        lastAudioIsolation = {
          contentType: req.headers["content-type"],
          body,
        };
        res.writeHead(200, { "Content-Type": "audio/mpeg" });
        res.end(FAKE_ISOLATED_AUDIO);
        return;
      }

      const timestampsMatch = path.match(
        /^\/v1\/text-to-speech\/([^/]+)\/stream\/with-timestamps$/,
      );
      if (method === "POST" && timestampsMatch) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(buildTimestampsNdjson());
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
    "multipart upload sends file bytes and saves returned audio (AC #8)",
    async () => {
      lastAudioIsolation = null;
      const uploadPath = join(tmpdir(), `elv-upload-${Date.now()}.wav`);
      const outDir = mkdtempSync(join(tmpdir(), "elv-files-out-"));
      writeFileSync(uploadPath, UPLOAD_MARKER);

      try {
        const { stdout, stderr, code } = await runCall([
          "call",
          "audio_isolation",
          "--file",
          `audio=${uploadPath}`,
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        assertNoKeyLeak(stdout, stderr);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.operation_id).toBe("audio_isolation");

        const files = filesArray(envelope);
        expect(files.length).toBeGreaterThanOrEqual(1);

        const audioFile = files.find((f) => String(f.mime ?? "").includes("audio"));
        expect(audioFile).toBeDefined();
        const audioPath = audioFile!.path as string;
        expect(existsSync(audioPath)).toBe(true);
        expect(readFileSync(audioPath).equals(FAKE_ISOLATED_AUDIO)).toBe(true);

        expect(lastAudioIsolation).not.toBeNull();
        const capture = lastAudioIsolation!;
        expect(String(capture.contentType ?? "")).toMatch(/multipart\/form-data/i);
        expect(capture.body.includes(UPLOAD_MARKER)).toBe(true);
      } finally {
        rmSync(uploadPath, { force: true });
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "large JSON is summarized inline and saved to disk (AC #10)",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-files-out-"));
      try {
        const { stdout, stderr, code } = await runCall(["call", "get_voices", "--out", outDir]);

        expect(code).toBe(0);
        assertNoKeyLeak(stdout, stderr);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.truncated).toBe(true);

        const summary = envelope.data_summary;
        expect(summary).toBeTypeOf("object");
        expect(summary).not.toBeNull();
        const summaryRecord = summary as Record<string, unknown>;
        expect(summaryRecord.count ?? summaryRecord.preview_count).toBeDefined();

        const files = filesArray(envelope);
        const jsonFile = files.find(
          (f) =>
            String(f.path ?? "").endsWith(".json") ||
            String(f.mime ?? "").includes("application/json"),
        );
        expect(jsonFile).toBeDefined();

        const jsonPath = jsonFile!.path as string;
        expect(existsSync(jsonPath)).toBe(true);
        expect(statSync(jsonPath).size).toBeGreaterThan(LARGE_JSON_THRESHOLD);

        const saved = readFileSync(jsonPath, "utf8");
        const parsedSaved: unknown = JSON.parse(saved);
        expect(parsedSaved).toBeTypeOf("object");

        const data = envelope.data;
        if (data !== undefined) {
          const serialized = JSON.stringify(data);
          expect(serialized.length).toBeLessThan(LARGE_JSON_THRESHOLD);
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );

  it(
    "json_events stream is parsed into ndjson + decoded audio, not piped raw (AC #31)",
    async () => {
      const outDir = mkdtempSync(join(tmpdir(), "elv-files-out-"));
      const payload = JSON.stringify({ path: { voice_id: "v1" }, body: { text: "hi" } });

      try {
        const { stdout, stderr, code } = await runCall([
          "call",
          "text_to_speech_stream_with_timestamps",
          "--json",
          payload,
          "--out",
          outDir,
        ]);

        expect(code).toBe(0);
        assertNoKeyLeak(stdout, stderr);

        const envelope = parseEnvelope(stdout);
        expect(envelope.ok).toBe(true);

        const files = filesArray(envelope);
        expect(files.length).toBeGreaterThanOrEqual(2);

        const ndjsonFile = files.find((f) => String(f.path ?? "").endsWith(".ndjson"));
        expect(ndjsonFile).toBeDefined();
        const ndjsonPath = ndjsonFile!.path as string;
        expect(existsSync(ndjsonPath)).toBe(true);

        const ndjsonText = readFileSync(ndjsonPath, "utf8");
        expect(ndjsonText).toContain('"alignment"');
        expect(ndjsonText).toContain('"characters"');

        const audioFile = files.find(
          (f) =>
            String(f.mime ?? "").includes("audio") && !String(f.path ?? "").endsWith(".ndjson"),
        );
        expect(audioFile).toBeDefined();
        const audioPath = audioFile!.path as string;
        expect(existsSync(audioPath)).toBe(true);

        const audioBytes = readFileSync(audioPath);
        expect(audioBytes.equals(EXPECTED_DECODED_AUDIO)).toBe(true);
        expect(audioBytes.toString("utf8")).not.toContain("audio_base64");
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    CALL_TIMEOUT_MS,
  );
});
