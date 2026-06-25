import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OutTargetError,
  deriveFilename,
  fileRecord,
  resolveOutTarget,
  sha256File,
  streamToFile,
  writeBufferToFile,
  writeManifest,
} from "../src/core/files";

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

  it("rejects file-looking --out targets for multi-file operations", () => {
    expect(resolveOutTarget(join(dir, "one.mp3"), false)).toEqual({ dir, file: "one.mp3" });
    expect(() => resolveOutTarget(join(dir, "one.mp3"), true)).toThrow(OutTargetError);
  });

  it("writes a JSON manifest", async () => {
    const path = await writeManifest(dir, { files: ["a"] });
    expect(await sha256File(path)).toBe(await sha256File(createReadStream(path).path.toString()));
  });
});
