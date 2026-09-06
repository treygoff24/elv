import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractMultipartResponse,
  MultipartResponseError,
} from "../../src/core/multipart-response";
import { OutTargetError } from "../../src/core/files";

let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "elv-multipart-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

function multipart(
  parts: { mime: string; bytes: Buffer; extraHeaders?: string }[],
  boundary = "music-boundary",
): Buffer {
  return Buffer.concat(
    parts
      .flatMap((part) => [
        Buffer.from(
          `--${boundary}\r\nContent-Type: ${part.mime}\r\n${part.extraHeaders ?? ""}\r\n`,
        ),
        part.bytes,
        Buffer.from("\r\n"),
      ])
      .concat(Buffer.from(`--${boundary}--\r\n`)),
  );
}

function response(
  bytes: Buffer,
  chunkSize = 1,
  contentType = 'multipart/mixed; boundary="music-boundary"',
): Response {
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + chunkSize));
        offset += chunkSize;
      },
    }),
    { headers: { "content-type": contentType } },
  );
}

describe("multipart music response extraction", () => {
  // Deliberate strictness, pinned so nobody "fixes" it into leniency: the one
  // provider endpoint returning multipart/mixed always sends CRLF-delimited parts
  // with a Content-Type header, and a lenient parser would have to guess where a
  // headerless part's body starts on a stream that may be truncated mid-part.
  it("rejects a part that carries no headers", async () => {
    const bytes = Buffer.from("--music-boundary\r\n\r\nnaked-body\r\n--music-boundary--\r\n");

    const error = await extractMultipartResponse(response(bytes), {
      operationId: "compose_detailed",
      out,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(MultipartResponseError);
    expect((error as MultipartResponseError).code).toBe("invalid_multipart_response");
  });

  // Deliberate strictness, as above: RFC 2046 delimiters are CRLF, and accepting a
  // bare LF would let a payload byte sequence end a paid audio part early.
  it("rejects a bare-LF multipart body", async () => {
    const bytes = Buffer.from(
      "--music-boundary\nContent-Type: application/json\n\n{}\n--music-boundary--\n",
    );

    const error = await extractMultipartResponse(response(bytes), {
      operationId: "compose_detailed",
      out,
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(MultipartResponseError);
    expect((error as MultipartResponseError).code).toBe("invalid_multipart_response");
  });

  it("surfaces an unusable output target as an out-target error, not a provider error", async () => {
    const error = await extractMultipartResponse(
      response(multipart([{ mime: "application/json", bytes: Buffer.from("{}") }])),
      { operationId: "compose_detailed", out: join(out, "single-file.mp3") },
    ).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(OutTargetError);
    expect(error).not.toBeInstanceOf(MultipartResponseError);
    const outTarget = error as InstanceType<typeof OutTargetError>;
    expect(outTarget.code).toBe("invalid_out_target");
    expect(outTarget.hint).toContain("directory");
  });

  it("extracts exact metadata and binary audio across one-byte boundary/header splits", async () => {
    const metadata = Buffer.from(
      '{ "composition_plan": {"title":"Trio"}, "song_metadata":{"bpm":92} }\n',
    );
    const audio = Buffer.concat([
      Buffer.from([0, 0xff, 0x80, 0x0d, 0x0a]),
      Buffer.from("--music-boundary-not-a-delimiter\r\n--music-boundary--not-final\r\n"),
      Buffer.from([0x01, 0x02, 0xff]),
    ]);
    const files = await extractMultipartResponse(
      response(
        multipart([
          { mime: "application/json", bytes: metadata },
          {
            mime: "audio/pcm",
            bytes: audio,
            extraHeaders: 'Content-Disposition: attachment; filename="../../escape.mp3"\r\n',
          },
        ]),
      ),
      { operationId: "compose_detailed", out, outputFormat: "pcm_44100" },
    );
    expect(files).toHaveLength(2);
    const json = files.find((file) => file.mime === "application/json")!;
    const media = files.find((file) => file.mime === "audio/pcm")!;
    expect(readFileSync(json.path)).toEqual(metadata);
    expect(readFileSync(media.path)).toEqual(audio);
    expect(media.path.endsWith(".pcm")).toBe(true);
    expect(files.every((file) => dirname(file.path) === out)).toBe(true);
    expect(files.every((file) => !basename(file.path).includes("escape"))).toBe(true);
    expect(files.every((file) => !file.partial)).toBe(true);
  });

  it("retains complete metadata and all received audio bytes when the body is truncated", async () => {
    const metadata = Buffer.from('{"song_metadata":{"bpm":92}}');
    const audio = Buffer.from("paid-audio\r\n--music-bound");
    const bytes = Buffer.concat([
      Buffer.from("--music-boundary\r\nContent-Type: application/json\r\n\r\n"),
      metadata,
      Buffer.from("\r\n--music-boundary\r\nContent-Type: audio/mpeg\r\n\r\n"),
      audio,
    ]);
    const error = await extractMultipartResponse(response(bytes, 7), {
      operationId: "compose_detailed",
      out,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MultipartResponseError);
    const failure = error as MultipartResponseError;
    expect(failure.retryRecommended).toBe(false);
    expect(failure.files).toHaveLength(2);
    expect(failure.files[0]!.partial).not.toBe(true);
    expect(readFileSync(failure.files[0]!.path)).toEqual(metadata);
    expect(failure.files[1]!.partial).toBe(true);
    expect(readFileSync(failure.files[1]!.path)).toEqual(audio);
  });

  it("protects secret metadata and still rejects malformed JSON on secret-result operations", async () => {
    const metadata = Buffer.from('{"access_token":"test-token","song_metadata":{"bpm":92}}');
    const files = await extractMultipartResponse(
      response(
        multipart([
          { mime: "application/json", bytes: metadata },
          { mime: "audio/mpeg", bytes: Buffer.from("audio") },
        ]),
        32,
      ),
      { operationId: "compose_detailed", out },
    );
    expect(files[0]!.sensitive).toBe(true);
    expect(files[0]!.path.endsWith("-sensitive.json")).toBe(true);
    expect(statSync(files[0]!.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(files[0]!.path)).toEqual(metadata);

    const malformed = Buffer.from('{"access_token":"test-token"');
    const error = await extractMultipartResponse(
      response(
        multipart([
          { mime: "application/json", bytes: malformed },
          { mime: "audio/mpeg", bytes: Buffer.from("audio") },
        ]),
        64,
      ),
      { operationId: "secret_music", out, secretResult: true },
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MultipartResponseError);
    const failure = error as MultipartResponseError;
    expect(failure.message).not.toContain("test-token");
    expect(failure.files[0]).toMatchObject({ sensitive: true, partial: true });
    expect(statSync(failure.files[0]!.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(failure.files[0]!.path)).toEqual(malformed);
    expect(failure.files).toHaveLength(2);
    expect(readFileSync(failure.files[1]!.path)).toEqual(Buffer.from("audio"));
    expect(failure.files[1]!.partial).not.toBe(true);
  });

  it("preserves delivered body bytes when the Response stream rejects", async () => {
    const audio = Buffer.from("delivered-paid-audio");
    const bytes = Buffer.concat([
      Buffer.from(
        "--music-boundary\r\nContent-Type: application/json\r\n\r\n{}\r\n--music-boundary\r\nContent-Type: audio/mpeg\r\n\r\n",
      ),
      audio,
    ]);
    let sent = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error("upstream interrupted"));
          else {
            sent = true;
            controller.enqueue(bytes);
          }
        },
      }),
      { headers: { "content-type": "multipart/mixed; boundary=music-boundary" } },
    );
    const error = await extractMultipartResponse(res, {
      operationId: "compose_detailed",
      out,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MultipartResponseError);
    const failure = error as MultipartResponseError;
    expect(failure.files).toHaveLength(2);
    expect(failure.files[1]!.partial).toBe(true);
    expect(readFileSync(failure.files[1]!.path)).toEqual(audio);
  });

  it("cancels an undecodable body when its boundary is missing", async () => {
    let cancelled = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }),
      {
        headers: { "content-type": "multipart/mixed" },
      },
    );
    const error = await extractMultipartResponse(res, {
      operationId: "compose_detailed",
      out,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MultipartResponseError);
    expect((error as MultipartResponseError).files).toEqual([]);
    expect((error as MultipartResponseError).retryRecommended).toBe(false);
    expect(cancelled).toBe(true);
  });

  it.each([
    'multipart/mixed; boundary=""',
    `multipart/mixed; boundary=${"x".repeat(71)}`,
    'multipart/mixed; boundary="bad;boundary"',
  ])("rejects malformed boundary: %s", async (contentType) => {
    await expect(
      extractMultipartResponse(response(Buffer.from("opaque"), 5, contentType), {
        operationId: "compose_detailed",
        out,
      }),
    ).rejects.toThrow(/malformed.*boundary/u);
    expect(readdirSync(out)).toEqual([]);
  });

  it("accepts a bounded preamble, boundary padding, folded headers, and a closing delimiter at EOF", async () => {
    const bytes = Buffer.from(
      [
        "provider preamble\r\n--music-boundary \t\r\nContent-Type: application/json;\r\n charset=utf-8\r\n\r\n{}",
        "\r\n--music-boundary\r\nContent-Type: audio/mpeg\r\n\r\naudio",
        "\r\n--music-boundary-- \t",
      ].join(""),
    );
    const files = await extractMultipartResponse(response(bytes, 3), {
      operationId: "compose_detailed",
      out,
    });
    expect(files).toHaveLength(2);
    expect(readFileSync(files[1]!.path, "utf8")).toBe("audio");
  });

  it("streams audio to disk before the entire response arrives", async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x7f);
    let index = 0;
    let wroteBeforeEof = false;
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === 0)
            controller.enqueue(
              Buffer.from(
                "--music-boundary\r\nContent-Type: application/json\r\n\r\n{}\r\n--music-boundary\r\nContent-Type: application/octet-stream\r\n\r\n",
              ),
            );
          else if (index <= 64) {
            if (index === 16)
              wroteBeforeEof = readdirSync(out).some(
                (name) => name.includes("audio") && statSync(join(out, name)).size > 64 * 1024,
              );
            controller.enqueue(chunk);
          } else if (index === 65) controller.enqueue(Buffer.from("\r\n--music-boundary--\r\n"));
          else controller.close();
          index++;
        },
      }),
      { headers: { "content-type": "multipart/mixed; boundary=music-boundary" } },
    );
    const files = await extractMultipartResponse(res, {
      operationId: "compose_detailed",
      out,
      outputFormat: "opus_48000_128",
    });
    expect(wroteBeforeEof).toBe(true);
    expect(files[1]!.path.endsWith(".opus")).toBe(true);
    expect(files[1]!.bytes).toBe(64 * chunk.length);
    expect(readFileSync(files[1]!.path).every((value) => value === 0x7f)).toBe(true);
    expect(readdirSync(out).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("retains bounded extra non-audio parts privately using generated filenames", async () => {
    const extra = Buffer.from("private provider annotation");
    const files = await extractMultipartResponse(
      response(
        multipart([
          { mime: "application/json", bytes: Buffer.from("{}") },
          {
            mime: "text/plain",
            bytes: extra,
            extraHeaders: 'Content-Disposition: attachment; filename="/tmp/overwrite"\r\n',
          },
          { mime: "audio/mpeg", bytes: Buffer.from("audio") },
        ]),
        64,
      ),
      { operationId: "compose_detailed", out },
    );
    expect(files).toHaveLength(3);
    expect(files[1]).toMatchObject({ sensitive: true, mime: "text/plain" });
    expect(statSync(files[1]!.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(files[1]!.path)).toEqual(extra);
    expect(files.every((file) => dirname(file.path) === out)).toBe(true);
  });

  it("caps metadata and retains a private partial receipt instead of claiming success", async () => {
    const bytes = Buffer.from(JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) }));
    const error = await extractMultipartResponse(
      response(
        multipart([
          { mime: "application/json", bytes },
          { mime: "audio/mpeg", bytes: Buffer.from("audio") },
        ]),
        64 * 1024,
      ),
      { operationId: "compose_detailed", out },
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MultipartResponseError);
    const failure = error as MultipartResponseError;
    expect(failure.message).toContain("exceeds 2 MiB");
    expect(failure.files).toHaveLength(1);
    expect(failure.files[0]).toMatchObject({
      bytes: 2 * 1024 * 1024,
      sensitive: true,
      partial: true,
    });
    expect(readFileSync(failure.files[0]!.path)).toEqual(bytes.subarray(0, 2 * 1024 * 1024));
  });

  it("caps part count while preserving the completed outputs", async () => {
    const parts = [
      { mime: "application/json", bytes: Buffer.from("{}") },
      ...Array.from({ length: 16 }, () => ({ mime: "audio/mpeg", bytes: Buffer.from("audio") })),
    ];
    const error = await extractMultipartResponse(response(multipart(parts), 128), {
      operationId: "compose_detailed",
      out,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(MultipartResponseError);
    expect((error as MultipartResponseError).message).toContain("exceeds 16 parts");
    expect((error as MultipartResponseError).files).toHaveLength(16);
    expect((error as MultipartResponseError).files.every((file) => !file.partial)).toBe(true);
  });

  it.each([
    "Broken header\r\nContent-Type: audio/mpeg",
    `Content-Type: audio/mpeg\r\n${Array.from({ length: 64 }, (_, index) => `X-${index}: value`).join("\r\n")}`,
    `Content-Type: audio/mpeg\r\nX-Large: ${"x".repeat(64 * 1024)}`,
  ])(
    "rejects malformed or excessive headers after preserving prior complete metadata",
    async (headers) => {
      const bytes = Buffer.from(
        `--music-boundary\r\nContent-Type: application/json\r\n\r\n{}\r\n--music-boundary\r\n${headers}\r\n\r\naudio\r\n--music-boundary--\r\n`,
      );
      const error = await extractMultipartResponse(response(bytes, 1024), {
        operationId: "compose_detailed",
        out,
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(MultipartResponseError);
      expect((error as MultipartResponseError).files).toHaveLength(1);
      expect(readFileSync((error as MultipartResponseError).files[0]!.path, "utf8")).toBe("{}");
      expect((error as MultipartResponseError).files[0]!.partial).not.toBe(true);
    },
  );
});
