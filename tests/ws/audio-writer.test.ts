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
    await expect(
      writer.writeFromEvent({
        type: "audio",
        audio_event: { audio_base_64: Buffer.from("three").toString("base64") },
      }),
    ).resolves.toBe(true);

    await expect(writer.close()).resolves.toBe(writer.path);
    await expect(readFile(writer.path, "utf8")).resolves.toBe("onetwothree");
  });

  it("returns the authoritative collision path across writers in one output directory", async () => {
    const dir = await tempDir();
    const first = new AudioWriter(dir, "mp3_44100_128");
    await first.writeFromEvent({ audio: Buffer.from("first").toString("base64") });
    const firstPath = await first.close();

    const second = new AudioWriter(dir, "mp3_44100_128");
    await second.writeFromEvent({ audio: Buffer.from("second").toString("base64") });
    const secondPath = await second.close();

    expect(firstPath).not.toBeNull();
    expect(secondPath).not.toBeNull();
    expect(secondPath).not.toBe(firstPath);
    await expect(readFile(firstPath!, "utf8")).resolves.toBe("first");
    await expect(readFile(secondPath!, "utf8")).resolves.toBe("second");
  });

  it.each([
    ["pcm_16000", "pcm"],
    ["ulaw_8000", "ulaw"],
    ["alaw_8000", "alaw"],
    ["opus_48000_64", "opus"],
    ["wav_44100", "wav"],
    ["mp3_44100_128", "mp3"],
  ])("labels %s bytes with the %s extension", async (format, extension) => {
    const dir = await tempDir();
    const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
    const writer = new AudioWriter(dir, format);
    await writer.writeFromEvent({ audio: bytes.toString("base64") });

    const path = await writer.close();

    expect(path).toBe(join(dir, `audio.${extension}`));
    await expect(readFile(path!)).resolves.toEqual(bytes);
  });

  it("ignores non-audio events and closes without a file", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "opus_48000");

    expect(writer.path).toBe(join(dir, "audio.opus"));
    await expect(writer.writeFromEvent({ text: "no audio" })).resolves.toBe(false);
    await expect(writer.close()).resolves.toBeNull();
  });

  it("ignores malformed near-matches for nested agent audio", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "pcm_16000");

    await expect(
      writer.writeFromEvent({ type: "audio", audio_event: { audio_base64: "bm90IGF1ZGlv" } }),
    ).resolves.toBe(false);
    await expect(
      writer.writeFromEvent({ type: "audio", audio_event: { audio_base_64: 123 } }),
    ).resolves.toBe(false);
    await expect(writer.close()).resolves.toBeNull();
  });

  it("separates multi-context audio into safe context files", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "pcm_16000");

    await expect(
      writer.writeFromEvent({ audio: Buffer.from("a1").toString("base64"), contextId: "../../a" }),
    ).resolves.toBe(true);
    await expect(
      writer.writeFromEvent({ audio: Buffer.from("b1").toString("base64"), context_id: "b" }),
    ).resolves.toBe(true);
    await expect(
      writer.writeFromEvent({ audio: Buffer.from("a2").toString("base64"), context_id: "../../a" }),
    ).resolves.toBe(true);

    const outputs = await writer.closeAll();
    expect(outputs.map(({ contextId }) => contextId).sort()).toEqual(["../../a", "b"]);
    for (const output of outputs) {
      expect(output.path.startsWith(`${dir}/`)).toBe(true);
      expect(output.path.slice(dir.length + 1)).not.toContain("..");
    }
    const byContext = new Map(outputs.map((output) => [output.contextId, output.path]));
    await expect(readFile(byContext.get("../../a")!, "utf8")).resolves.toBe("a1a2");
    await expect(readFile(byContext.get("b")!, "utf8")).resolves.toBe("b1");
  });

  it("rejects malformed or conflicting audio context identifiers before writing", async () => {
    const dir = await tempDir();
    const writer = new AudioWriter(dir, "pcm_16000");
    const audio = Buffer.from("audio").toString("base64");

    await expect(writer.writeFromEvent({ audio, contextId: 1 })).rejects.toThrow(/context/iu);
    await expect(writer.writeFromEvent({ audio, contextId: "a", context_id: "b" })).rejects.toThrow(
      /context/iu,
    );
    await expect(writer.closeAll()).resolves.toEqual([]);
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
