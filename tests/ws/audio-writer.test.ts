import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AudioWriter } from "../../src/ws/audio-writer";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AudioWriter", () => {
  it("writes audio and chooses an extension from the output format", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "pcm_16000");

    expect(writer.path).toBe(join(dir, "audio.pcm"));
    await expect(
      writer.writeFromEvent({ audio: Buffer.from("one").toString("base64") }),
    ).resolves.toBe(true);
    await expect(
      writer.writeFromEvent({ audio_base64: Buffer.from("two").toString("base64") }),
    ).resolves.toBe(true);

    await expect(writer.close()).resolves.toBe(writer.path);
    await expect(readFile(writer.path, "utf8")).resolves.toBe("onetwo");
  });

  it("ignores non-audio events and closes without a file", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "opus_48000");

    expect(writer.path).toBe(join(dir, "audio.opus"));
    await expect(writer.writeFromEvent({ text: "no audio" })).resolves.toBe(false);
    await expect(writer.close()).resolves.toBeNull();
  });

  it("rejects invalid base64 instead of writing decoded garbage", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "mp3_44100_128");

    await expect(writer.writeFromEvent({ audio: "not!!valid" })).rejects.toThrow(
      "Invalid base64 audio",
    );
    await writer.abort();
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "elv-audio-writer-"));
  dirs.push(dir);
  return dir;
}
