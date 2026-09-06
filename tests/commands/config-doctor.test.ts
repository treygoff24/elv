import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { arrayValue, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";
import { rejectPortProbe } from "../helpers/http";
import type { JsonObject } from "../../src/util/json";

function checkNamed(stdout: string, name: string): JsonObject {
  const checks = arrayValue(recordValue(parseEnvelope(stdout).data, "data").checks, "checks").map(
    (check) => recordValue(check, "check"),
  );
  const match = checks.find((check) => check.name === name);
  if (!match) throw new Error(`Missing doctor check ${name}: ${JSON.stringify(checks)}`);
  return match;
}

function listen(server: Server): Promise<number> {
  return new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listener address");
      resolve(address.port);
    }),
  );
}

function closeAll(servers: Server[]): Promise<unknown> {
  return Promise.all(
    servers.map(
      (http) =>
        new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
}

describe("doctor network opt-in", () => {
  it("stays offline unless requested and never follows credential-bearing redirects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-doctor-"));
    const requests: string[] = [];
    let redirected = 0;
    const target = createServer((req, res) => {
      if (rejectPortProbe(req, res)) return;
      redirected++;
      res.end("unexpected");
    });
    const targetPort = await listen(target);
    const server = createServer((req, res) => {
      if (rejectPortProbe(req, res)) return;
      requests.push(req.url ?? "");
      if (req.url === "/v1/user/subscription") {
        res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/capture` });
      }
      res.end();
    });
    const sourcePort = await listen(server);
    const env = {
      ELV_CACHE_DIR: dir,
      ELV_OUTPUT_DIR: join(dir, "out"),
      ELEVENLABS_BASE_URL: `http://127.0.0.1:${sourcePort}`,
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
      // The root probe answered; only the credential-bearing check met a redirect,
      // and refusing it is reported as a skip rather than a failed configuration.
      expect(checkNamed(online.stdout, "base_url_reachable")).toMatchObject({
        status: "pass",
        detail: `http://127.0.0.1:${sourcePort} returned 200`,
      });
      expect(checkNamed(online.stdout, "credit_balance").status).toBe("skip");
      const conflict = await runCli(["config", "doctor", "--online", "--offline"], env);
      expect(conflict.code).toBe(2);
      expect(requests).toHaveLength(2);
    } finally {
      await closeAll([server, target]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a redirecting API root as unreachable rather than failing the config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-doctor-redirect-"));
    const requests: string[] = [];
    const server = createServer((req, res) => {
      if (rejectPortProbe(req, res)) return;
      requests.push(req.url ?? "");
      res.writeHead(302, { location: "https://api.elevenlabs.io/" });
      res.end();
    });
    const port = await listen(server);
    try {
      const online = await runCli(["config", "doctor", "--online"], {
        ELV_CACHE_DIR: dir,
        ELV_OUTPUT_DIR: join(dir, "out"),
        ELEVENLABS_BASE_URL: `http://127.0.0.1:${port}`,
        ELEVENLABS_API_KEY: "test_key_CANARY",
      });

      expect(online.code, online.stdout).toBe(0);
      // The root was reached and answered with a redirect, so the skip below is
      // the refusal, not an unreachable listener.
      expect(requests).toEqual(["/", "/v1/user/subscription"]);
      // A proxy that 3xx-redirects the API root turns this check into a false
      // negative; it stays a skip so the doctor never fails on it.
      expect(checkNamed(online.stdout, "base_url_reachable")).toMatchObject({
        status: "skip",
        detail: "fetch failed",
      });
      expect(online.stdout + online.stderr).not.toContain("test_key_CANARY");
    } finally {
      await closeAll([server]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
