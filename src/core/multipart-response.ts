import { join } from "node:path";
import { MIMEType } from "node:util";
import { extension } from "mime-types";
import {
  deriveFilename,
  fileRecord,
  OutTargetError,
  resolveOutTarget,
  tempFileWriter,
  writeBufferToFile,
} from "./files";
import type { TempFileWriter } from "./files";
import { containsCredential } from "./redaction";
import type { FileRecord } from "./types";

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_HEADERS = 64;
const MAX_PARTS = 16;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const SLICE_BYTES = 64 * 1024;
const CRLF = Buffer.from("\r\n");

export interface MultipartResponseOptions {
  operationId: string;
  out?: string;
  hash?: boolean;
  outputFormat?: string;
  requestPath?: string;
  secretResult?: boolean;
}

export class MultipartResponseError extends Error {
  readonly code = "invalid_multipart_response";
  readonly retryRecommended = false;

  constructor(
    message: string,
    readonly files: FileRecord[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MultipartResponseError";
  }
}

/** Extract Music's multipart response without buffering its audio or trusting provider filenames. */
export async function extractMultipartResponse(
  res: Response,
  options: MultipartResponseOptions,
): Promise<FileRecord[]> {
  let parser: MultipartParser | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    parser = new MultipartParser(readBoundary(res.headers.get("content-type")), options);
    if (!res.body) throw new MultipartResponseError("Multipart response has no body");
    reader = res.body.getReader();
    while (!parser.done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes = Buffer.from(chunk.value.buffer, chunk.value.byteOffset, chunk.value.byteLength);
      for (let offset = 0; offset < bytes.length && !parser.done; offset += SLICE_BYTES) {
        await parser.feed(bytes.subarray(offset, offset + SLICE_BYTES));
      }
    }
    await parser.feed(Buffer.alloc(0), true);
    parser.requireComplete();
    return parser.files;
  } catch (error) {
    await parser?.preservePartial();
    // An unresolvable output target is an input error carrying its own hint.
    if (error instanceof OutTargetError) throw error;
    throw new MultipartResponseError(
      error instanceof MultipartResponseError
        ? error.message
        : "Multipart response was interrupted or could not be saved",
      parser?.files ?? [],
      { cause: error },
    );
  } finally {
    if (reader) await reader.cancel().catch(() => {});
    else await res.body?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

interface Part {
  index: number;
  mime: string;
  kind: "audio" | "json" | "other";
  bytes: number;
  chunks?: Buffer[];
  writer?: TempFileWriter;
}

type Ending = { length: number; final: boolean } | "incomplete" | "not-boundary";

class MultipartParser {
  readonly files: FileRecord[] = [];
  private readonly marker: Buffer;
  private readonly delimiter: Buffer;
  private readonly dir: string;
  private pending: Buffer = Buffer.alloc(0);
  private state: "preamble" | "headers" | "body" | "done" = "preamble";
  private active?: Part;
  private partCount = 0;
  private jsonCount = 0;
  private audioCount = 0;
  private metadataError?: MultipartResponseError;

  constructor(
    boundary: string,
    private readonly options: MultipartResponseOptions,
  ) {
    this.marker = Buffer.from(`--${boundary}`);
    this.delimiter = Buffer.from(`\r\n--${boundary}`);
    this.dir = resolveOutTarget(options.out, true).dir;
  }

  get done(): boolean {
    return this.state === "done";
  }

  async feed(bytes: Buffer, eof = false): Promise<void> {
    if (this.done) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes);
    while (!this.done) {
      if (this.state === "preamble") {
        if (!this.readOpening(eof)) return;
      } else if (this.state === "headers") {
        if (!this.readHeaders()) return;
      } else {
        const index = this.pending.indexOf(this.delimiter);
        if (index < 0) {
          const count = Math.max(0, this.pending.length - this.delimiter.length + 1);
          await this.writePending(count);
          return;
        }
        await this.writePending(index);
        const ending = boundaryEnding(this.pending, this.delimiter.length, eof);
        if (ending === "incomplete") return;
        if (ending === "not-boundary") {
          // A binary payload can contain the boundary prefix without a valid delimiter line.
          await this.writePending(CRLF.length);
          continue;
        }
        this.pending = this.pending.subarray(ending.length);
        await this.closePart(false);
        this.state = ending.final ? "done" : "headers";
      }
    }
    this.pending = Buffer.alloc(0);
  }

  requireComplete(): void {
    if (!this.done)
      throw new MultipartResponseError("Multipart response ended before its closing boundary");
    if (this.metadataError) throw this.metadataError;
    if (!this.jsonCount || !this.audioCount)
      throw new MultipartResponseError(
        "Multipart music response is missing its JSON metadata or audio part",
      );
  }

  async preservePartial(): Promise<void> {
    if (this.state === "body" && this.pending.length) {
      try {
        await this.writePending(this.pending.length);
      } catch {
        /* Retain whatever reached the writer. */
      }
    }
    try {
      await this.closePart(true);
    } catch {
      /* A failed disk write may prevent recovery of this part. */
    }
  }

  private readOpening(eof: boolean): boolean {
    let index = this.pending.indexOf(this.marker);
    while (index >= 0) {
      if (index === 0 || this.pending.subarray(index - 2, index).equals(CRLF)) {
        if (index > MAX_HEADER_BYTES)
          throw new MultipartResponseError("Multipart preamble exceeds 64 KiB");
        const ending = boundaryEnding(this.pending, index + this.marker.length, eof);
        if (ending === "incomplete") return false;
        if (ending !== "not-boundary") {
          this.pending = this.pending.subarray(ending.length);
          this.state = ending.final ? "done" : "headers";
          return true;
        }
      }
      index = this.pending.indexOf(this.marker, index + 1);
    }
    if (this.pending.length > MAX_HEADER_BYTES)
      throw new MultipartResponseError("Multipart preamble exceeds 64 KiB");
    return false;
  }

  private readHeaders(): boolean {
    const end = this.pending.indexOf("\r\n\r\n");
    if (end < 0) {
      if (this.pending.length > MAX_HEADER_BYTES)
        throw new MultipartResponseError("Multipart part headers exceed 64 KiB");
      return false;
    }
    if (end > MAX_HEADER_BYTES)
      throw new MultipartResponseError("Multipart part headers exceed 64 KiB");
    if (++this.partCount > MAX_PARTS)
      throw new MultipartResponseError("Multipart response exceeds 16 parts");
    const headers = parseHeaders(this.pending.subarray(0, end).toString("latin1"));
    const mime = (headers.get("content-type") ?? "application/octet-stream")
      .split(";", 1)[0]!
      .trim()
      .toLowerCase();
    const encoding = headers.get("content-transfer-encoding")?.toLowerCase();
    if (encoding && encoding !== "binary" && encoding !== "8bit" && encoding !== "7bit") {
      throw new MultipartResponseError(
        "Unsupported multipart Content-Transfer-Encoding; expected binary data",
      );
    }
    const kind =
      mime === "application/json" || mime.endsWith("+json")
        ? "json"
        : mime.startsWith("audio/") || mime === "application/octet-stream"
          ? "audio"
          : "other";
    const part: Part = { index: this.partCount, mime, kind, bytes: 0 };
    if (kind === "audio") {
      const name = deriveFilename(
        this.options.operationId,
        `audio-${part.index}`,
        audioExtension(mime, this.options),
      );
      part.writer = tempFileWriter(join(this.dir, name));
      part.writer.stream.on("error", () => {}); // write/close report the error; do not crash before the first payload arrives.
      this.audioCount++;
    } else if (kind === "json") this.jsonCount++;
    this.active = part;
    this.pending = this.pending.subarray(end + 4);
    this.state = "body";
    return true;
  }

  private async writePending(count: number): Promise<void> {
    if (!count) return;
    const part = this.active!;
    const bytes = this.pending.subarray(0, count);
    if (part.writer) await part.writer.write(bytes);
    else {
      // Metadata is normally a few hundred bytes; collect chunks rather than
      // reserving the 2 MiB cap for every part up front.
      const chunks = (part.chunks ??= []);
      const available = MAX_METADATA_BYTES - part.bytes;
      if (bytes.length > available) {
        if (available) chunks.push(Buffer.from(bytes.subarray(0, available)));
        part.bytes += available;
        throw new MultipartResponseError("Multipart metadata part exceeds 2 MiB");
      }
      chunks.push(Buffer.from(bytes));
    }
    part.bytes += bytes.length;
    this.pending = this.pending.subarray(count);
  }

  private async closePart(partial: boolean): Promise<void> {
    const part = this.active;
    if (!part) return;
    this.active = undefined;
    if (part.writer) {
      try {
        const path = await part.writer.close();
        this.files.push({
          ...(await fileRecord(path, { hash: this.options.hash })),
          mime: part.mime,
          ...(partial ? { partial: true } : {}),
        });
      } catch (error) {
        await part.writer.abort().catch(() => {});
        throw error;
      }
      return;
    }
    const bytes = part.chunks ? Buffer.concat(part.chunks) : Buffer.alloc(0);
    let invalid = false;
    let sensitive = Boolean(this.options.secretResult || partial || part.kind === "other");
    if (part.kind === "json") {
      try {
        const metadata: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
        sensitive = containsCredential(metadata) || sensitive;
      } catch {
        invalid = true;
        sensitive = true;
      }
    }
    const label = `metadata-${part.index}${sensitive ? "-sensitive" : ""}`;
    const name = deriveFilename(
      this.options.operationId,
      label,
      part.kind === "json" ? "json" : "bin",
    );
    const path = await writeBufferToFile(bytes, join(this.dir, name), { mode: 0o600 });
    this.files.push({
      ...(await fileRecord(path, { hash: this.options.hash })),
      mime: part.mime,
      ...(sensitive ? { sensitive: true } : {}),
      ...(partial || invalid ? { partial: true } : {}),
    });
    // Bad metadata must not prevent recovering a later, already-paid audio part.
    if (invalid && !partial)
      this.metadataError ??= new MultipartResponseError(
        "Multipart JSON metadata is not valid UTF-8 JSON",
      );
  }
}

function readBoundary(contentType: string | null): string {
  let mime: MIMEType;
  try {
    mime = new MIMEType(contentType ?? "");
  } catch {
    throw new MultipartResponseError("Missing or malformed multipart Content-Type boundary");
  }
  const boundary = mime.params.get("boundary");
  if (
    mime.essence !== "multipart/mixed" ||
    !boundary ||
    !/^[A-Za-z0-9'()+_,./:=? -]{1,70}$/u.test(boundary) ||
    boundary.endsWith(" ")
  ) {
    throw new MultipartResponseError("Missing or malformed multipart Content-Type boundary");
  }
  return boundary;
}

function boundaryEnding(bytes: Buffer, offset: number, eof: boolean): Ending {
  let cursor = offset;
  const final = bytes.subarray(cursor, cursor + 2).equals(Buffer.from("--"));
  if (final) cursor += 2;
  while (bytes[cursor] === 0x20 || bytes[cursor] === 0x09) {
    if (++cursor - offset > MAX_HEADER_BYTES)
      throw new MultipartResponseError("Multipart boundary padding exceeds 64 KiB");
  }
  if (bytes.subarray(cursor, cursor + 2).equals(CRLF)) return { length: cursor + 2, final };
  if (final && eof && cursor === bytes.length) return { length: cursor, final: true };
  if (
    cursor === bytes.length ||
    (cursor + 1 === bytes.length && (bytes[cursor] === 0x0d || bytes[cursor] === 0x2d))
  )
    return "incomplete";
  return "not-boundary";
}

function parseHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = text.split("\r\n");
  if (lines.length > MAX_HEADERS)
    throw new MultipartResponseError("Multipart part exceeds 64 header lines");
  let previous: string | undefined;
  for (const line of lines) {
    if (/^[ \t]/u.test(line) && previous) {
      headers.set(previous, `${headers.get(previous)} ${line.trim()}`);
      continue;
    }
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*)$/u.exec(line);
    if (!match) throw new MultipartResponseError("Malformed multipart part header");
    const name = match[1]!.toLowerCase();
    if (headers.has(name)) throw new MultipartResponseError("Duplicate multipart part header");
    headers.set(name, match[2]!.trim());
    previous = name;
  }
  return headers;
}

function audioExtension(mime: string, options: MultipartResponseOptions): string {
  const query = new URLSearchParams(options.requestPath?.split("?")[1] ?? "");
  const codec = (options.outputFormat ?? query.get("output_format") ?? "").split("_")[0]!;
  if (["mp3", "pcm", "ulaw", "alaw", "opus"].includes(codec)) return codec;
  if (mime === "audio/mpeg" || mime === "audio/*" || mime === "application/octet-stream")
    return "mp3";
  return extension(mime) || "bin";
}
