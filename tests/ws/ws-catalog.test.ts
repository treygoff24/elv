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
