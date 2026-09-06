import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEnvelope, runCli } from "../helpers/cli-result";

describe("doctor network opt-in", () => {
  it("stays offline unless requested and never follows credential-bearing redirects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-doctor-"));
    const requests: string[] = [];
    let redirected = 0;
    const target = createServer((_req, res) => {
      redirected++;
      res.end("unexpected");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address === "string") throw new Error("Missing target address");
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.url === "/v1/user/subscription") {
        res.writeHead(302, { location: `http://127.0.0.1:${address.port}/capture` });
      }
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const source = server.address();
    if (!source || typeof source === "string") throw new Error("Missing source address");
    const env = {
      ELV_CACHE_DIR: dir,
      ELV_OUTPUT_DIR: join(dir, "out"),
      ELEVENLABS_BASE_URL: `http://127.0.0.1:${source.port}`,
      ELEVENLABS_API_KEY: "test_key_CANARY",
    };
    try {
      for (const args of [[], ["--offline"]]) {
        const result = await runCli(["config", "doctor", ...args], env);
        expect(result.code, result.stdout).toBe(0);
        expect(parseEnvelope(result.stdout).ok).toBe(true);
        expect(requests).toEqual([]);
      }
      const online = await runCli(["config", "doctor", "--online"], env);
      expect(requests).toEqual(["/", "/v1/user/subscription"]);
      expect(redirected).toBe(0);
      expect(online.stdout + online.stderr).not.toContain("test_key_CANARY");
      const conflict = await runCli(["config", "doctor", "--online", "--offline"], env);
      expect(conflict.code).toBe(2);
      expect(requests).toHaveLength(2);
    } finally {
      await Promise.all(
        [server, target].map(
          (http) =>
            new Promise<void>((resolve, reject) =>
              http.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
