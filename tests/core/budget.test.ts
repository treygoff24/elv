import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { estimateCredits, estimateDetail, overBudget } from "../../src/core/budget";
import type { CostHint, OperationCard } from "../../src/openapi/types";

let tempDir = "";

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "elv-budget-"));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function op(operationId: string, costHint: CostHint): OperationCard {
  return {
    operationId,
    method: "POST",
    pathTemplate: "/test",
    group: [],
    tags: [],
    risk: "generate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    costHint,
    deprecated: false,
    examples: [],
  };
}

function wav(seconds: number, sampleRate = 8_000): Buffer {
  const bytesPerSample = 2;
  const channels = 1;
  const byteRate = sampleRate * channels * bytesPerSample;
  const dataBytes = seconds * byteRate;
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

describe("budget estimates", () => {
  it("estimates TTS characters at a conservative 1.0 ratio", async () => {
    await expect(
      estimateCredits(op("text_to_speech_full", "characters"), { body: { text: "hello" } }, {}),
    ).resolves.toBe(5);
  });

  it("applies the Flash/Turbo 0.5 credit-per-character discount", async () => {
    await expect(
      estimateCredits(
        op("text_to_speech_full", "characters"),
        { body: { text: "abcdef", model_id: "eleven_flash_v2_5" } },
        {},
      ),
    ).resolves.toBe(3);
  });

  it("estimates Scribe speech-to-text at the calibrated ~27 credits/minute", async () => {
    const path = join(tempDir, "stt-two-seconds.wav");
    await writeFile(path, wav(2));

    await expect(
      estimateCredits(op("speech_to_text", "audio_seconds"), { files: { file: path } }, {}),
    ).resolves.toBeCloseTo((27 * 2) / 60);
  });

  it("joins dialogue input text for character estimates", async () => {
    await expect(
      estimateCredits(
        op("text_to_dialogue", "characters"),
        { body: { inputs: [{ text: "hi" }, { text: " there" }] } },
        {},
      ),
    ).resolves.toBe(8);
  });

  it("estimates sound generation from explicit duration or the auto-duration flat cap", async () => {
    await expect(
      estimateCredits(
        op("sound_generation", "per_generation"),
        { body: { duration_seconds: 2 } },
        {},
      ),
    ).resolves.toBe(22);
    await expect(
      estimateCredits(op("sound_generation", "per_generation"), { body: { text: "boom" } }, {}),
    ).resolves.toBe(100);
  });

  it("uses the music 5-minute cap and warns when generated length is unknown", async () => {
    const detail = await estimateDetail(
      op("generate", "per_generation"),
      { body: { prompt: "piano" } },
      {},
    );

    expect(detail.credits).toBe(4_500);
    expect(detail.warnings).toEqual([
      {
        code: "generated_length_unknown",
        message: "Generated length unknown; using 5-minute cap.",
      },
    ]);
  });

  it("estimates audio-second operations from local WAV duration", async () => {
    const path = join(tempDir, "two-seconds.wav");
    await writeFile(path, wav(2));

    await expect(
      estimateCredits(op("audio_isolation", "audio_seconds"), { files: { audio: path } }, {}),
    ).resolves.toBeCloseTo((1_000 * 2) / 60);
  });

  it("estimates per-source-minute dubbing from duration and target language count", async () => {
    const path = join(tempDir, "three-seconds.wav");
    await writeFile(path, wav(3));

    await expect(
      estimateCredits(
        op("create_dubbing", "per_source_minute"),
        { files: { file: path }, body: { target_languages: ["es", "fr"] } },
        {},
      ),
    ).resolves.toBe(1_000);
  });

  it("multiplies estimates for --retry-post", async () => {
    await expect(
      estimateCredits(
        op("text_to_speech_full", "characters"),
        { body: { text: "abc" } },
        { retryPost: true },
      ),
    ).resolves.toBe(9);
  });

  it("checks over-budget boundaries only for known estimates", () => {
    expect(overBudget(10, { maxCredits: 9 })).toBe(true);
    expect(overBudget(10, { maxCredits: 10 })).toBe(false);
    expect(overBudget(null, { maxCredits: 0 })).toBe(false);
  });

  it("does not guard slot or unknown cost hints", async () => {
    await expect(estimateCredits(op("text_to_voice", "slot"), {}, {})).resolves.toBeNull();
    await expect(estimateCredits(op("get_voices", "unknown"), {}, {})).resolves.toBeNull();
  });

  it("guards B1 credit-burning operations with non-null estimates", async () => {
    const path = join(tempDir, "one-second.wav");
    await writeFile(path, wav(1));

    await expect(
      estimateCredits(op("text_to_speech_full", "characters"), { body: { text: "x" } }, {}),
    ).resolves.not.toBeNull();
    await expect(
      estimateCredits(
        op("sound_generation", "per_generation"),
        { body: { duration_seconds: 1 } },
        {},
      ),
    ).resolves.not.toBeNull();
    await expect(
      estimateCredits(op("audio_isolation", "audio_seconds"), { files: { audio: path } }, {}),
    ).resolves.not.toBeNull();
  });
});
