import { describe, expect, it } from "vitest";
import { buildCatalogUrl, getWsCatalogEntry, listWsCatalog } from "../../src/ws/catalog";

const names = [
  "tts-realtime",
  "tts-multi",
  "ttd-realtime",
  "ttd-multi",
  "stt-realtime",
  "convai",
  "convai-monitor",
];

describe("ws catalog", () => {
  it("lists protocol-specific scripted catalog entries", () => {
    const entries = listWsCatalog();

    expect(entries.map((entry) => entry.name)).toEqual(names);
    expect(getWsCatalogEntry("convai")?.scriptable).toBe(true);
    expect(getWsCatalogEntry("convai")?.protocol).toBe("convai");
    expect(getWsCatalogEntry("convai-monitor")).toMatchObject({
      protocol: "monitor",
      requiredParams: ["conversation_id"],
      outboundRisk: "external_side_effect",
    });
    expect(getWsCatalogEntry("tts-realtime")?.requiredParams).toContain("voice_id");
    expect(getWsCatalogEntry("tts-multi")?.protocol).toBe("tts-multi");
    expect(getWsCatalogEntry("ttd-realtime")).toMatchObject({
      protocol: "ttd",
      pathTemplate: "/v1/text-to-dialogue/stream-input",
      defaultQuery: { model_id: "eleven_v3_conversational" },
    });
    expect(getWsCatalogEntry("ttd-multi")).toMatchObject({
      protocol: "ttd-multi",
      pathTemplate: "/v1/text-to-dialogue/multi-stream-input",
    });
    expect(getWsCatalogEntry("stt-realtime")?.auth).toContain("xi-api-key");
  });

  it("advertises duplex support and the protocol rules an agent has to follow", () => {
    for (const entry of listWsCatalog()) {
      expect(entry.duplex).toBe(true);
      expect(entry.firstMessage.length).toBeGreaterThan(0);
      expect(entry.terminalRule.length).toBeGreaterThan(0);
      expect(["tts_characters", "unbounded", "unknown"]).toContain(entry.costModel);
    }

    expect(getWsCatalogEntry("tts-realtime")).toMatchObject({
      costModel: "tts_characters",
      tokenParam: "single_use_token",
      rejectsV3: true,
      defaultAudioFormat: "mp3_44100_128",
    });
    expect(getWsCatalogEntry("stt-realtime")).toMatchObject({
      costModel: "unbounded",
      tokenParam: "token",
    });
    expect(getWsCatalogEntry("convai")?.tokenParam).toBeUndefined();
    expect(getWsCatalogEntry("convai")?.defaultAudioFormat).toBeUndefined();
    expect(getWsCatalogEntry("convai-monitor")?.costModel).toBe("unknown");
    expect(getWsCatalogEntry("tts-realtime")?.firstMessage).toContain('"text":" "');
  });

  it("builds regional urls without leaking auth into catalog metadata", () => {
    const url = buildCatalogUrl(getWsCatalogEntry("tts-realtime")!, {
      baseUrl: "https://api.eu.residency.elevenlabs.io",
      query: { voice_id: "voice-1", model_id: "eleven_flash_v2_5" },
    });

    expect(url.toString()).toBe(
      "wss://api.eu.residency.elevenlabs.io/v1/text-to-speech/voice-1/stream-input?model_id=eleven_flash_v2_5",
    );

    const convai = buildCatalogUrl(getWsCatalogEntry("convai")!, {
      baseUrl: "https://api.elevenlabs.io",
      query: { agent_id: "agent-1" },
    });
    expect(convai.toString()).toBe(
      "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent-1",
    );
  });

  it("builds text-to-dialogue urls with the documented default model", () => {
    const url = buildCatalogUrl(getWsCatalogEntry("ttd-realtime")!, {
      baseUrl: "https://api.elevenlabs.io",
    });

    expect(url.toString()).toBe(
      "wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?model_id=eleven_v3_conversational",
    );
  });
});
