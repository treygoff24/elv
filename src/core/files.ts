import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  type Stats,
  type WriteStream,
} from "node:fs";
import { chmod, link, lstat, open, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { lookup } from "mime-types";
import type { FileRecord } from "./types";
import type { JsonValue } from "../util/json";

const DEFAULT_HASH_CAP_BYTES = 64 * 1024 * 1024;

interface HashOptions {
  maxBytes?: number;
  hash?: boolean;
}

interface WriteOptions {
  mode?: number;
}

export class OutTargetError extends Error {
  readonly code = "invalid_out_target";
  readonly hint: string;

  constructor(message: string, hint: string) {
    super(message);
    this.name = "OutTargetError";
    this.hint = hint;
  }
}

export interface TempFileWriter {
  stream: WriteStream;
  write: (chunk: Buffer | Uint8Array | string) => Promise<void>;
  close: () => Promise<string>;
  abort: () => Promise<void>;
}

class TempFileWriterImpl implements TempFileWriter {
  private done = false;
  private closing: Promise<string> | undefined;

  constructor(
    private readonly path: string,
    private readonly tmpPath: string,
    readonly stream: WriteStream,
  ) {}

  async write(chunk: Buffer | Uint8Array | string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.stream.off("error", onError);
        reject(error);
      };
      this.stream.once("error", onError);
      this.stream.write(chunk, (error?: Error | null) => {
        this.stream.off("error", onError);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  close(): Promise<string> {
    return (this.closing ??= this.finishClose());
  }

  private async finishClose(): Promise<string> {
    if (this.done) throw new Error("Temporary file writer is already closed");
    try {
      await closeWriteStream(this.stream);
      const finalPath = await publishTempFile(this.tmpPath, this.path);
      this.done = true;
      return finalPath;
    } catch (error) {
      await rm(this.tmpPath, { force: true });
      this.done = true;
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.closing) {
      await this.closing.catch(() => undefined);
      return;
    }
    if (this.done) return;
    this.done = true;
    this.stream.destroy();
    await finished(this.stream).catch(() => undefined);
    await rm(this.tmpPath, { force: true });
  }
}

export async function sha256File(path: string, opts: HashOptions & { hash: true }): Promise<string>;
export async function sha256File(path: string, opts?: HashOptions): Promise<string | null>;
export async function sha256File(path: string, opts: HashOptions = {}): Promise<string | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_HASH_CAP_BYTES;
  const stats = statSync(path);
  if (!opts.hash && stats.size > maxBytes) return null;

  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export function deriveFilename(
  base: string,
  discriminator: string | undefined,
  ext: string,
): string {
  const cleanExt = ext.startsWith(".") ? ext.slice(1) : ext;
  const stem = discriminator ? `${cleanPart(base)}-${cleanPart(discriminator)}` : cleanPart(base);
  return `${stem}.${cleanExt}`;
}

/** Matches sensitive spill names, including collision suffixes produced during publication. */
export function isSensitiveSpillFilename(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = extname(lower);
  if (extension !== ".json" && extension !== ".bin") return false;
  const stem = lower.slice(0, -extension.length);
  const marker = Math.max(stem.lastIndexOf("-sensitive"), stem.lastIndexOf(".sensitive"));
  if (marker < 0) return false;
  const suffix = stem.slice(marker + "-sensitive".length);
  return (
    suffix === "" ||
    (suffix.startsWith("-") &&
      suffix
        .slice(1)
        .split("-")
        .every((part) => /^[a-f0-9]{8}$/u.test(part) || /^\d+$/u.test(part)))
  );
}

export function resolveOutTarget(
  out: string | undefined,
  multiFile: boolean,
): { dir: string; file?: string } {
  const target = out ? absolute(out) : process.cwd();
  const existing = existsSync(target) ? statSync(target) : undefined;
  const fileLooking = existing?.isFile() ?? Boolean(extname(target));

  if (multiFile) {
    if (fileLooking) {
      throw new OutTargetError(
        "--out file is only valid for single-file operations",
        "Pass a directory path to --out.",
      );
    }
    return { dir: target };
  }

  const looksLikeDirectory =
    existing?.isDirectory() || (!existing && (out?.endsWith("/") || !fileLooking));
  if (looksLikeDirectory) return { dir: target };
  return { dir: dirname(target), file: basename(target) };
}

export async function streamToFile(
  body: globalThis.ReadableStream | Readable | null,
  path: string,
): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = tempPathFor(path);
  let ownsTmp = false;
  let handle;
  try {
    handle = await open(tmpPath, "wx");
    ownsTmp = true;
    await pipeline(toNodeReadable(body), handle.createWriteStream());
    handle = undefined;
    return await publishTempFile(tmpPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (ownsTmp) await rm(tmpPath, { force: true });
    throw error;
  }
}

export async function writeBufferToFile(
  buffer: Buffer | Uint8Array | string,
  path: string,
  opts: WriteOptions = {},
): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const tmpPath = tempPathFor(path);
  let ownsTmp = false;
  let handle;
  try {
    handle = await open(tmpPath, "wx", opts.mode);
    ownsTmp = true;
    await handle.writeFile(content);
    await handle.close();
    handle = undefined;
    if (opts.mode !== undefined) await chmod(tmpPath, opts.mode);
    return await publishTempFile(tmpPath, path, opts);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (ownsTmp) await rm(tmpPath, { force: true });
    throw error;
  }
}

export function tempFileWriter(path: string): TempFileWriter {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = tempPathFor(path);
  const fd = openSync(tmpPath, "wx");
  try {
    return new TempFileWriterImpl(
      path,
      tmpPath,
      createWriteStream(tmpPath, { fd, autoClose: true }),
    );
  } catch (error) {
    closeSync(fd);
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

export async function fileRecord(path: string, opts: HashOptions = {}): Promise<FileRecord> {
  const stats = statSync(path);
  return {
    path,
    mime: lookup(path) || "application/octet-stream",
    bytes: stats.size,
    sha256: await sha256File(path, opts),
  };
}

export async function writeManifest(dir: string, manifest: JsonValue): Promise<string> {
  const path = join(dir, "manifest.json");
  return await writeBufferToFile(`${JSON.stringify(manifest, null, 2)}\n`, path);
}

async function publishTempFile(
  tmpPath: string,
  requestedPath: string,
  options: WriteOptions = {},
): Promise<string> {
  let contentHash: string | undefined;
  const support: LinkSupport = { hardLinks: true };
  for (let attempt = 0; attempt < 10_000; attempt += 1) {
    const candidate = publicationCandidate(requestedPath, contentHash ?? "", attempt);
    if (await occupyCandidate(tmpPath, candidate, options.mode, support)) {
      await rm(tmpPath, { force: true });
      return candidate;
    }
    // Fresh names need no extra read of a potentially large streamed file.
    contentHash ??= await sha256File(tmpPath, { hash: true });
    if (await reusablePublishedFile(candidate, contentHash, options.mode)) {
      await rm(tmpPath, { force: true });
      return candidate;
    }
  }
  throw new OutTargetError(
    "Could not publish output without replacing an occupied path",
    "Choose a different --out path or clear the colliding files; elv never overwrites an existing file.",
  );
}

interface LinkSupport {
  hardLinks: boolean;
}

// exFAT/FAT32, SMB without Unix extensions, and some FUSE backends reject link(2).
const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK", "ENOSYS"]);

/** Claim `candidate` exclusively, or report false when it is already occupied. */
async function occupyCandidate(
  tmpPath: string,
  candidate: string,
  mode: number | undefined,
  support: LinkSupport,
): Promise<boolean> {
  if (support.hardLinks) {
    try {
      await link(tmpPath, candidate);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      if (!LINK_UNSUPPORTED.has(errorCode(error))) throw publicationFailure(candidate, error);
      support.hardLinks = false;
    }
  }
  return await copyToCandidate(tmpPath, candidate, mode);
}

/** Hard-link-free publication: exclusive create keeps the never-replace guarantee. */
async function copyToCandidate(
  tmpPath: string,
  candidate: string,
  mode: number | undefined,
): Promise<boolean> {
  let handle;
  try {
    handle = await open(candidate, "wx", mode);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw publicationFailure(candidate, error);
  }
  try {
    // An explicit mode is still subject to umask; restate it on the handle we own.
    if (mode !== undefined) await handle.chmod(mode);
    await pipeline(createReadStream(tmpPath), handle.createWriteStream());
    return true;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(candidate, { force: true });
    throw publicationFailure(candidate, error);
  }
}

function publicationFailure(candidate: string, error: unknown): OutTargetError {
  return new OutTargetError(
    `Could not publish output file ${candidate} (${errorCode(error)})`,
    "Choose an --out directory that allows creating new files; elv publishes by hard link, falls back to exclusive create, and never replaces an existing file.",
  );
}

function publicationCandidate(path: string, contentHash: string, attempt: number): string {
  if (attempt === 0) return path;
  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  const suffix = attempt === 1 ? contentHash.slice(0, 8) : `${contentHash.slice(0, 8)}-${attempt}`;
  return `${stem}-${suffix}${extension}`;
}

async function reusablePublishedFile(
  path: string,
  contentHash: string,
  requestedMode: number | undefined,
): Promise<boolean> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;
  if (requestedMode !== undefined && (stats.mode & 0o777) !== (requestedMode & 0o777)) {
    return false;
  }

  let handle;
  try {
    // O_NOFOLLOW keeps a symlink swapped in after the lstat from being read.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    const hash = createHash("sha256");
    await pipeline(handle.createReadStream({ autoClose: false }), hash);
    return hash.digest("hex") === contentHash;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown";
}

async function closeWriteStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return;
  await new Promise<void>((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function cleanPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "file"
  );
}

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function toNodeReadable(body: globalThis.ReadableStream | Readable | null): Readable {
  if (body === null) return Readable.from([]);
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}

function tempPathFor(path: string): string {
  return `${path}.tmp-${process.pid}-${randomUUID()}`;
}
