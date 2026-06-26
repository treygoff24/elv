import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup } from "mime-types";
import type { FileRecord } from "./types";

const DEFAULT_HASH_CAP_BYTES = 64 * 1024 * 1024;

export interface HashOptions {
  maxBytes?: number;
  hash?: boolean;
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
  body: globalThis.ReadableStream | Readable,
  path: string,
): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await pipeline(toNodeReadable(body), createWriteStream(tmpPath));
    await rename(tmpPath, await collisionPathForFile(path, tmpPath));
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

export async function writeBufferToFile(
  buffer: Buffer | Uint8Array | string,
  path: string,
): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  const content = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const finalPath = await collisionPath(path, content);
  await writeFile(finalPath, content);
  return finalPath;
}

export function tempFileWriter(path: string): TempFileWriter {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const stream = createWriteStream(tmpPath);

  return {
    stream,
    write: async (chunk) => {
      if (!stream.write(chunk)) await once(stream, "drain");
    },
    close: async () => {
      await closeWriteStream(stream);
      const finalPath = await collisionPathForFile(path, tmpPath);
      await rename(tmpPath, finalPath);
      return finalPath;
    },
    abort: async () => {
      stream.destroy();
      await rm(tmpPath, { force: true });
    },
  };
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

export async function writeManifest(dir: string, manifest: unknown): Promise<string> {
  const path = join(dir, "manifest.json");
  await writeBufferToFile(`${JSON.stringify(manifest, null, 2)}\n`, path);
  return path;
}

async function collisionPath(path: string, content: Buffer): Promise<string> {
  if (!existsSync(path)) return path;

  const existingHash = await sha256File(path, { hash: true });
  const contentHash = createHash("sha256").update(content).digest("hex");
  if (existingHash === contentHash) return path;

  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  return `${stem}-${contentHash.slice(0, 8)}${extension}`;
}

async function collisionPathForFile(path: string, contentPath: string): Promise<string> {
  if (!existsSync(path)) return path;

  const existingHash = await sha256File(path, { hash: true });
  const contentHash = await sha256File(contentPath, { hash: true });
  if (existingHash === contentHash) return path;

  const extension = extname(path);
  const stem = path.slice(0, path.length - extension.length);
  return `${stem}-${contentHash?.slice(0, 8) ?? "content"}${extension}`;
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

function toNodeReadable(body: globalThis.ReadableStream | Readable): Readable {
  if (body instanceof Readable) return body;
  return Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);
}
