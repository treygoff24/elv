import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCall } from "../../src/commands/call";
import { runHttp } from "../../src/commands/http";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Music multipart command integration", () => {
  it.each(["call", "http"])("extracts real multipart bytes through %s", async (kind) => {
    const out = mkdtempSync(join(tmpdir(), "elv-music-multipart-"));
    vi.stubEnv("ELV_CACHE_DIR", join(out, "cache"));
    vi.stubEnv("ELV_MAX_CREDITS", undefined);
    const audio = Buffer.from([0, 255, 2, 0, 3]);
    const metadata = { composition_plan: { sections: [] }, song_metadata: { title: "Canary" } };
    const wire = Buffer.concat([
      Buffer.from(
        "--music\r\nContent-Type: application/json\r\n\r\n" +
          JSON.stringify(metadata) +
          '\r\n--music\r\nContent-Type: audio/mpeg\r\nContent-Disposition: attachment; filename="../../escape.mp3"\r\n\r\n',
      ),
      audio,
      Buffer.from("\r\n--music--\r\n"),
    ]);
    const fetch = vi.fn(async (url: string | URL) => {
      expect(new URL(url).pathname).toBe("/v1/music/detailed");
      return new Response(wire, {
        headers: { "content-type": 'multipart/mixed; boundary="music"', "song-id": "song-canary" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const env =
        kind === "call"
          ? (
              await handleCall("compose_detailed", {
                json: '{"body":{"prompt":"Quiet music"}}',
                out,
              })
            ).env
          : await runHttp("POST", "/v1/music/detailed", {
              bodyJson: '{"prompt":"Quiet music"}',
              out,
            });
      expect(env.ok).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
      expect(env.files).toHaveLength(2);
      const audioFile = env.files!.find((file) => file.mime === "audio/mpeg")!;
      const jsonFile = env.files!.find((file) => file.mime === "application/json")!;
      expect(readFileSync(audioFile.path)).toEqual(audio);
      expect(JSON.parse(readFileSync(jsonFile.path, "utf8"))).toEqual(metadata);
      expect(audioFile.path.startsWith(out + "/")).toBe(true);
      expect(audioFile.path).not.toContain("escape");
      expect(env.ok && env.request?.song_id).toBe("song-canary");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
