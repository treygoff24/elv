import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHttp } from "../../src/commands/http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("raw HTTP audio format", () => {
  it.each([
    ["/with-timestamps", true, "pcm_16000", ".pcm"],
    ["/with-timestamps", false, "pcm_16000", ".pcm"],
    ["/stream/with-timestamps", true, "pcm_16000", ".pcm"],
    ["/stream/with-timestamps", false, "pcm_16000", ".pcm"],
    ["/with-timestamps", true, "wav_16000", ".wav"],
    ["/with-timestamps", false, "wav_16000", ".wav"],
  ] as const)(
    "uses actual output_format for %s (embedded query %s, %s)",
    async (suffix, embedded, format, extension) => {
      const out = mkdtempSync(join(tmpdir(), "elv-http-format-"));
      vi.stubEnv("ELV_CACHE_DIR", join(out, "cache"));
      vi.stubEnv("ELV_MAX_CREDITS", undefined);
      const bytes = Buffer.from([0, 1, 0, 2]);
      const fetch = vi.fn(async (url: string | URL) => {
        expect(new URL(url).searchParams.getAll("output_format")).toEqual([format]);
        return Response.json({
          audio_base64: bytes.toString("base64"),
          alignment: {},
          normalized_alignment: {},
        });
      });
      vi.stubGlobal("fetch", fetch);
      try {
        const result = await runHttp(
          "POST",
          `/v1/text-to-speech/VOICE${suffix}${embedded ? `?output_format=${format}` : ""}`,
          {
            bodyJson: '{"text":"Hello"}',
            query: embedded ? undefined : [`output_format=${format}`],
            out,
          },
        );
        expect(result.ok).toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        const audio = result.files?.find((file) => file.path.endsWith(extension));
        expect(audio).toBeDefined();
        expect(readFileSync(audio!.path)).toEqual(bytes);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
  );
});
