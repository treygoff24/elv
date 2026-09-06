import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { errorRecord, filesArray, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";
import { rejectPortProbe } from "../helpers/http";

const transcript = { language_code: "en", language_probability: 0.99, text: "Hello", words: [] };
let server: Server;
let baseUrl: string;
let directory: string;
let postBody: unknown;
let postStatus: number;
let pollBody: unknown;
let paths: string[];

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (rejectPortProbe(req, res)) return;
    for await (const _chunk of req) {
      /* Consume the actual multipart upload. */
    }
    const path = req.url ?? "";
    paths.push(`${req.method} ${path}`);
    const polling = req.method === "GET";
    const pollCount = paths.filter((entry) => entry.startsWith("GET ")).length;
    res.writeHead(polling ? (pollCount > 1 ? 404 : 200) : postStatus, {
      "content-type": "application/json",
      "request-id": "request_stt",
      "character-cost": "23",
    });
    res.end(
      JSON.stringify(
        polling ? (pollCount > 1 ? { detail: "Unexpected extra poll" } : pollBody) : postBody,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing mock server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "elv-stt-wait-"));
  writeFileSync(join(directory, "audio.mp3"), Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  postBody = transcript;
  postStatus = 200;
  pollBody = transcript;
  paths = [];
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(args: string[]) {
  return runCli(args, {
    ELEVENLABS_BASE_URL: baseUrl,
    ELEVENLABS_API_KEY: "test_key_CANARY",
    ELV_CACHE_DIR: directory,
  });
}
function stt(args: string[] = []) {
  return run([
    "stt",
    "--file",
    join(directory, "audio.mp3"),
    "--model",
    "scribe_v2",
    "--out",
    directory,
    ...args,
  ]);
}

describe("STT wait completion and creation receipts", () => {
  it.each(["small", "large", "private", "multichannel"])(
    "returns the %s synchronous transcript envelope unchanged",
    async (shape) => {
      if (shape === "large") postBody = { ...transcript, text: "transcript ".repeat(5000) };
      if (shape === "private")
        postBody = {
          ...transcript,
          text: "transcript ".repeat(5000) + "https://example.invalid/?token=test-token",
        };
      if (shape === "multichannel")
        postBody = { transcripts: [transcript, { ...transcript, text: "Second channel" }] };
      const baseline = await stt();
      const waited = await stt(["--wait"]);
      expect(baseline.code, baseline.stdout).toBe(0);
      expect(waited.code, waited.stdout).toBe(0);
      expect(parseEnvelope(waited.stdout)).toEqual(parseEnvelope(baseline.stdout));
      expect(paths).toEqual(["POST /v1/speech-to-text", "POST /v1/speech-to-text"]);
      if (shape === "large" || shape === "private") {
        const files = filesArray(parseEnvelope(waited.stdout));
        expect(files).toHaveLength(1);
        expect(JSON.parse(readFileSync(String(files[0]!.path), "utf8"))).toEqual(postBody);
        if (shape === "private") {
          expect(waited.stdout).not.toContain("test-token");
          expect(files[0]!.sensitive).toBe(true);
          expect(statSync(String(files[0]!.path)).mode & 0o777).toBe(0o600);
        }
      }
    },
  );

  it.each([false, true])(
    "polls the actual async ID and stops on a transcript with no status field (webhook=%s)",
    async (webhook) => {
      postBody = { transcription_id: "transcript_1", request_id: "request_1", message: "Accepted" };
      postStatus = 202;
      const result = await stt(["--wait", ...(webhook ? ["--webhook"] : [])]);
      expect(result.code, result.stdout).toBe(0);
      expect(parseEnvelope(result.stdout)).toMatchObject({
        operation_id: "get_transcript_by_id",
        data: transcript,
      });
      expect(paths).toEqual([
        "POST /v1/speech-to-text",
        "GET /v1/speech-to-text/transcripts/transcript_1",
      ]);
    },
  );

  it("preserves a completed transcript file returned by the async poll", async () => {
    postBody = { transcription_id: "transcript_1" };
    postStatus = 202;
    pollBody = { ...transcript, text: "transcript ".repeat(5000) };
    const result = await stt(["--wait", "--webhook"]);
    expect(result.code, result.stdout).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.operation_id).toBe("get_transcript_by_id");
    const files = filesArray(envelope);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(String(files[0]!.path), "utf8"))).toEqual(pollBody);
    expect(paths).toHaveLength(2);
  });

  it.each(["stt", "dubbing"])(
    "returns %s --wait --dry-run without polling or requiring a created ID",
    async (command) => {
      const result =
        command === "stt"
          ? await stt(["--wait", "--dry-run"])
          : await run([
              "dubbing",
              "create",
              "--file",
              join(directory, "audio.mp3"),
              "--target",
              "es",
              "--wait",
              "--dry-run",
            ]);
      expect(result.code, result.stdout).toBe(0);
      expect(recordValue(parseEnvelope(result.stdout).data).dry_run).toBe(true);
      expect(paths).toEqual([]);
    },
  );

  it("does not treat a webhook request_id as a transcript ID and retains the accepted request receipt", async () => {
    postBody = {
      request_id: "webhook_request",
      message: "Accepted for webhook delivery. ".repeat(2000),
    };
    postStatus = 202;
    const result = await stt(["--webhook", "--wait"]);
    expect(result.code, result.stdout).toBe(2);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope).toMatchObject({
      operation_id: "speech_to_text",
      http: { status: 202 },
      cost: { credits_charged: 23 },
      retry: { recommended: false },
    });
    expect(errorRecord(envelope).message).toContain("transcription id");
    const files = filesArray(envelope);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(String(files[0]!.path), "utf8"))).toEqual(postBody);
    expect(paths).toEqual(["POST /v1/speech-to-text"]);
  });

  it("advertises exactly the published timestamp granularities", async () => {
    const result = await run(["stt", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("none, word, character");
    expect(result.stdout).not.toContain("segment");
  });
});
