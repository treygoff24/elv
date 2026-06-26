import { describe, expect, it } from "vitest";
import { buildCatalogUrl, getWsCatalogEntry, listWsCatalog } from "../../src/ws/catalog";

const names = ["tts-realtime", "tts-multi", "stt-realtime", "convai"];

describe("ws catalog", () => {
  it("lists the scripted catalog plus interactive convai", () => {
    const entries = listWsCatalog();

    expect(entries.map((entry) => entry.name)).toEqual(names);
    expect(getWsCatalogEntry("convai")?.scriptable).toBe(false);
    expect(getWsCatalogEntry("tts-realtime")?.requiredParams).toContain("voice_id");
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
  });
});
