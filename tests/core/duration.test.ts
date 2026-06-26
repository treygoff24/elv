import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeDurationSeconds } from "../../src/core/duration";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("duration probing", () => {
  it("reads local WAV durations without metadata probing", async () => {
    const dir = await tempDir();
    const path = join(dir, "two-and-half-seconds.wav");
    await writeFile(path, wav(2.5));

    await expect(probeDurationSeconds(path)).resolves.toBeCloseTo(2.5);
  });

  it("returns null for unreadable or unsupported files", async () => {
    const dir = await tempDir();
    const path = join(dir, "not-audio.txt");
    await writeFile(path, "hello");

    await expect(probeDurationSeconds(path)).resolves.toBeNull();
    await expect(probeDurationSeconds(join(dir, "missing.wav"))).resolves.toBeNull();
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "elv-duration-"));
  dirs.push(dir);
  return dir;
}

function wav(seconds: number, sampleRate = 8_000): Buffer {
  const bytesPerSample = 2;
  const channels = 1;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataBytes = Math.round(seconds * byteRate);
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}
