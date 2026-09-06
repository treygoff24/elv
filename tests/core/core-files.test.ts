import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OutTargetError,
  deriveFilename,
  fileRecord,
  isSensitiveSpillFilename,
  resolveOutTarget,
  sha256File,
  streamToFile,
  tempFileWriter,
  writeBufferToFile,
  writeManifest,
} from "../../src/core/files";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-files-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("files", () => {
  it("derives deterministic filenames", () => {
    expect(deriveFilename("tts", undefined, "mp3")).toBe("tts.mp3");
    expect(deriveFilename("dubbing", "es", ".zip")).toBe("dubbing-es.zip");
  });

  it("hashes with a size cap unless forced", async () => {
    const path = join(dir, "small.txt");
    writeFileSync(path, "abc");

    expect(await sha256File(path)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256File(path, { maxBytes: 1 })).toBeNull();
    expect(await sha256File(path, { maxBytes: 1, hash: true })).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("streams to files and records mime/bytes/hash", async () => {
    const path = join(dir, "audio.mp3");

    await streamToFile(Readable.from([Buffer.from("abc")]), path);
    const record = await fileRecord(path);

    expect(record).toMatchObject({ path, mime: "audio/mpeg", bytes: 3 });
    expect(record.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("handles buffer write collisions by content", async () => {
    const target = join(dir, "out.txt");

    expect(await writeBufferToFile(Buffer.from("same"), target)).toBe(target);
    expect(await writeBufferToFile(Buffer.from("same"), target)).toBe(target);
    const different = await writeBufferToFile(Buffer.from("different"), target);

    expect(different).not.toBe(target);
    expect(basename(different)).toMatch(/^out-[a-f0-9]{8}\.txt$/);
  });

  it("preserves a modified hashed collision and publishes to a new path", async () => {
    const target = join(dir, "out.txt");
    await writeBufferToFile("original", target);
    const hashed = await writeBufferToFile("new content", target);
    writeFileSync(hashed, "foreign modification");

    const published = await writeBufferToFile("new content", target);

    expect(published).not.toBe(hashed);
    expect(readFileSync(hashed, "utf8")).toBe("foreign modification");
    expect(readFileSync(published, "utf8")).toBe("new content");
  });

  it("publishes concurrent different buffers to distinct authoritative paths", async () => {
    const target = join(dir, "concurrent.txt");
    const contents = Array.from({ length: 12 }, (_, index) => `payload-${index}`);

    const paths = await Promise.all(contents.map((content) => writeBufferToFile(content, target)));

    expect(new Set(paths).size).toBe(contents.length);
    for (const [index, path] of paths.entries()) {
      expect(readFileSync(path, "utf8")).toBe(contents[index]);
    }
  });

  it("reuses identical concurrent buffer content without corrupting it", async () => {
    const target = join(dir, "same-concurrent.txt");
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => writeBufferToFile("same", target)),
    );

    expect(new Set(paths)).toEqual(new Set([target]));
    expect(readFileSync(target, "utf8")).toBe("same");
  });

  it("publishes concurrent streams and temp writers without replacement", async () => {
    const streamTarget = join(dir, "stream-concurrent.txt");
    const streamPaths = await Promise.all(
      ["stream-a", "stream-b"].map((content) =>
        streamToFile(Readable.from([Buffer.from(content)]), streamTarget),
      ),
    );
    expect(new Set(streamPaths).size).toBe(2);
    expect(streamPaths.map((path) => readFileSync(path, "utf8")).sort()).toEqual([
      "stream-a",
      "stream-b",
    ]);

    const writerTarget = join(dir, "writer-concurrent.txt");
    const first = tempFileWriter(writerTarget);
    const second = tempFileWriter(writerTarget);
    await Promise.all([first.write("writer-a"), second.write("writer-b")]);
    const writerPaths = await Promise.all([first.close(), second.close()]);
    expect(new Set(writerPaths).size).toBe(2);
    expect(writerPaths.map((path) => readFileSync(path, "utf8")).sort()).toEqual([
      "writer-a",
      "writer-b",
    ]);
  });

  it("never follows or replaces a symlink output leaf", async () => {
    const victim = join(dir, "victim.txt");
    const bufferTarget = join(dir, "buffer-link.txt");
    symlinkSync(victim, bufferTarget);

    const bufferPath = await writeBufferToFile("buffer", bufferTarget);
    expect(bufferPath).not.toBe(bufferTarget);
    expect(lstatSync(bufferTarget).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(false);
    expect(readFileSync(bufferPath, "utf8")).toBe("buffer");

    const streamTarget = join(dir, "stream-link.txt");
    symlinkSync(victim, streamTarget);
    const streamPath = await streamToFile(Readable.from(["stream"]), streamTarget);
    expect(streamPath).not.toBe(streamTarget);
    expect(lstatSync(streamTarget).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(false);

    const writerTarget = join(dir, "writer-link.txt");
    symlinkSync(victim, writerTarget);
    const writer = tempFileWriter(writerTarget);
    await writer.write("writer");
    const writerPath = await writer.close();
    expect(writerPath).not.toBe(writerTarget);
    expect(lstatSync(writerTarget).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(false);
  });

  it("publishes sensitive files as 0600 without chmodding an occupied path", async () => {
    const target = join(dir, "credential-sensitive.json");
    writeFileSync(target, "same", { mode: 0o644 });
    chmodSync(target, 0o644);

    const path = await writeBufferToFile("same", target, { mode: 0o600 });

    expect(path).not.toBe(target);
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe("same");
  });

  it("recognizes sensitive binary and collision filenames", () => {
    for (const name of [
      "token-sensitive.json",
      "token-sensitive.bin",
      "token-sensitive-deadbeef.json",
      "token-sensitive-deadbeef-2.bin",
      "token-sensitive-deadbeef-2-cafebabe-3.json",
      "token.sensitive-deadbeef.json",
    ]) {
      expect(isSensitiveSpillFilename(name)).toBe(true);
    }
    expect(isSensitiveSpillFilename("token-sensitive.txt")).toBe(false);
    expect(isSensitiveSpillFilename("token-nonsensitive-deadbeef.json")).toBe(false);
  });

  it("writes temp files atomically and reuses identical collision targets", async () => {
    const target = join(dir, "stream.txt");

    const first = tempFileWriter(target);
    await first.write("same");
    await expect(first.close()).resolves.toBe(target);

    const second = tempFileWriter(target);
    await second.write("same");
    await expect(second.close()).resolves.toBe(target);
  });

  it("returns the authoritative published path again during recovery close", async () => {
    const target = join(dir, "recovery.mp3");
    await writeBufferToFile("old", target);
    const writer = tempFileWriter(target);
    await writer.write("new");
    const actual = await writer.close();
    expect(actual).not.toBe(target);
    expect(await writer.close()).toBe(actual);
    expect(readFileSync(actual, "utf8")).toBe("new");
  });

  it("shares in-flight publication across concurrent recovery closes and abort", async () => {
    const fresh = tempFileWriter(join(dir, "fresh.mp3"));
    await fresh.write("fresh");
    const freshCloses = await Promise.all(Array.from({ length: 16 }, () => fresh.close()));
    expect(new Set(freshCloses).size).toBe(1);
    const target = join(dir, "concurrent-close.mp3");
    await writeBufferToFile("old", target);
    const writer = tempFileWriter(target);
    await writer.write("new");
    const first = writer.close();
    const second = writer.close();
    const paths = await Promise.all([first, second]);
    expect(first).toBe(second);
    expect(paths[0]).toBe(paths[1]);
    expect(paths[0]).not.toBe(target);
    expect(readFileSync(paths[0]!, "utf8")).toBe("new");
    expect(readFileSync(target, "utf8")).toBe("old");

    const another = tempFileWriter(join(dir, "abort-during-close.mp3"));
    await another.write("complete");
    const closing = another.close();
    await another.abort();
    expect(readFileSync(await closing, "utf8")).toBe("complete");
    expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("removes only owned partial temp files on abort and stream failure", async () => {
    const writerTarget = join(dir, "aborted.txt");
    const writer = tempFileWriter(writerTarget);
    await writer.write("partial");
    await writer.abort();
    expect(existsSync(writerTarget)).toBe(false);
    expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);

    const streamTarget = join(dir, "failed-stream.txt");
    const source = Readable.from(
      (async function* () {
        yield "partial";
        throw new Error("source failed");
      })(),
    );
    await expect(streamToFile(source, streamTarget)).rejects.toThrow("source failed");
    expect(existsSync(streamTarget)).toBe(false);
    expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("rejects file-looking --out targets for multi-file operations", () => {
    expect(resolveOutTarget(join(dir, "one.mp3"), false)).toEqual({ dir, file: "one.mp3" });
    expect(() => resolveOutTarget(join(dir, "one.mp3"), true)).toThrow(OutTargetError);
  });

  it("writes a JSON manifest", async () => {
    const path = await writeManifest(dir, { files: ["a"] });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ files: ["a"] });
  });
});
