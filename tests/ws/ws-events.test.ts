import { describe, expect, it } from "vitest";
import { parseSendScript, ttsCharacterEstimate } from "../../src/ws/events";

function script(...data: Record<string, unknown>[]): string {
  return data.map((value) => JSON.stringify({ type: "send", data: value })).join("\n");
}

describe("WebSocket protocol scripts", () => {
  it("accepts documented single-context Text to Dialogue messages", () => {
    const actions = parseSendScript(
      script(
        { voices: ["voice-a"] },
        { inputs: [{ text: "Hello there", voice_id: "voice-a" }] },
        { flush: true },
        { keep_alive: true },
        { close_socket: true },
      ),
      "ttd",
    );

    expect(actions).toHaveLength(5);
    expect(ttsCharacterEstimate(actions, "eleven_v3_conversational")).toBe(11);
  });

  it.each([
    ["missing voices", script({ inputs: [{ text: "Hello", voice_id: "voice-a" }] })],
    [
      "unknown voice",
      script({ voices: ["voice-a"] }, { inputs: [{ text: "Hi", voice_id: "voice-b" }] }),
    ],
    ["repeated init", script({ voices: ["voice-a"] }, { voices: ["voice-a"] })],
    ["bad control", script({ voices: ["voice-a"] }, { flush: "yes" })],
  ])("rejects malformed single-context TTD scripts: %s", (_label, raw) => {
    expect(() => parseSendScript(raw, "ttd")).toThrow();
  });

  it("accepts documented multi-context Text to Dialogue lifecycles", () => {
    const actions = parseSendScript(
      script(
        { context_id: "a", voices: ["voice-a"] },
        { context_id: "b", voices: ["voice-b"] },
        { context_id: "a", inputs: [{ text: "One", voice_id: "voice-a" }] },
        { context_id: "a", close_context: true },
        { context_id: "a", voices: ["voice-c"] },
        { context_id: "a", inputs: [{ text: "Two", voice_id: "voice-c", new_turn: true }] },
        { close_socket: true },
      ),
      "ttd-multi",
    );

    expect(actions).toHaveLength(7);
    expect(ttsCharacterEstimate(actions, "eleven_v3")).toBe(6);
  });

  it.each([
    ["missing context", script({ voices: ["voice-a"] })],
    [
      "context without init",
      script({ context_id: "a", inputs: [{ text: "Hi", voice_id: "voice-a" }] }),
    ],
    [
      "global close with context",
      script({ context_id: "a", voices: ["voice-a"] }, { context_id: "a", close_socket: true }),
    ],
    [
      "six live contexts",
      script(
        { context_id: "1", voices: ["v"] },
        { context_id: "2", voices: ["v"] },
        { context_id: "3", voices: ["v"] },
        { context_id: "4", voices: ["v"] },
        { context_id: "5", voices: ["v"] },
        { context_id: "6", voices: ["v"] },
      ),
    ],
  ])("rejects malformed multi-context TTD scripts: %s", (_label, raw) => {
    expect(() => parseSendScript(raw, "ttd-multi")).toThrow();
  });

  it("parses the documented file-backed STT audio action", () => {
    const actions = parseSendScript(
      JSON.stringify({
        type: "send_audio_file",
        path: "sample.pcm",
        sample_rate: 16_000,
        commit: true,
        previous_text: "Earlier context",
      }),
      "stt",
    );

    expect(actions).toEqual([
      {
        type: "send_audio_file",
        path: "sample.pcm",
        sampleRate: 16_000,
        commit: true,
        previousText: "Earlier context",
      },
    ]);
  });

  it("keeps raw binary frames raw-only and validates STT audio metadata", () => {
    expect(() =>
      parseSendScript(JSON.stringify({ type: "send_binary_file", path: "sample.pcm" }), "stt"),
    ).toThrow(/raw WebSocket sessions/iu);
    expect(() =>
      parseSendScript(
        JSON.stringify({ type: "send_audio_file", path: "sample.pcm", commit: true }),
        "stt",
      ),
    ).toThrow(/sample_rate/iu);
    expect(() =>
      parseSendScript(
        JSON.stringify({
          type: "send_audio_file",
          path: "sample.pcm",
          sample_rate: 16_000,
          commit: "yes",
        }),
        "stt",
      ),
    ).toThrow(/commit/iu);
    expect(() =>
      parseSendScript(
        JSON.stringify({
          type: "send_audio_file",
          path: "sample.pcm",
          sample_rate: 16_000,
          commit: true,
        }),
        "tts",
      ),
    ).toThrow(/only supported.*STT/iu);
    expect(() =>
      parseSendScript(JSON.stringify({ type: "send_binary_file", path: "sample.pcm" }), "raw"),
    ).not.toThrow();
  });
});
