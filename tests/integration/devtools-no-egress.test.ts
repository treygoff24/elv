import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// scripts/no-egress.mjs is what makes the offline smoke actually offline: it is
// preloaded through NODE_OPTIONS so it survives into whatever process a
// credential-injecting wrapper finally execs. These fixtures pin the scope it
// claims — non-loopback TCP, TLS, DNS and fetch refused; loopback, Unix sockets
// and ELV_NO_EGRESS_ALLOW hosts permitted — because a blocker that silently
// stopped blocking would make every smoke run look hermetic while it was not.
//
// None of these tests need the network: every blocked case is refused before a
// packet leaves, and the allowed cases stay on loopback.

const execFileAsync = promisify(execFile);

const preload = fileURLToPath(new URL("../../scripts/no-egress.mjs", import.meta.url));
const cliSource = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const MARKER = "ELV_NO_EGRESS_BLOCKED";

interface ChildRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runNode(args: string[], env: Record<string, string> = {}): Promise<ChildRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? -1 };
  }
}

/** Runs `script` under the preload and returns whatever it printed as JSON. */
async function underBlocker(script: string, env: Record<string, string> = {}): Promise<unknown> {
  const run = await runNode(["--import", preload, "-e", script], env);
  expect(run.stdout.trim(), `child printed nothing; stderr was: ${run.stderr}`).not.toBe("");
  return JSON.parse(run.stdout.trim());
}

describe("no-egress preload", () => {
  it("refuses a TCP connect to a non-loopback address", async () => {
    // 198.51.100.1 is RFC 5737 documentation space and is never routed, so a
    // regression here fails on the timeout rather than reaching anything real.
    const result = await underBlocker(`
      const net = require("node:net");
      const report = (message) => { console.log(JSON.stringify({ message })); process.exit(0); };
      try {
        // The socket timeout keeps a regression fast-failing instead of hanging
        // until the vitest timeout, since unrouted space never answers.
        const socket = net.connect(443, "198.51.100.1");
        socket.on("error", () => report("NOT BLOCKED (error)"));
        socket.setTimeout(1500, () => report("NOT BLOCKED (timeout)"));
      } catch (error) { report(error.message); }
    `);
    expect((result as { message: string }).message).toContain(MARKER);
  });

  it("refuses TLS, DNS and fetch for a public hostname", async () => {
    const result = await underBlocker(`
      const dns = require("node:dns");
      const tls = require("node:tls");
      const out = {};
      try { tls.connect(443, "api.elevenlabs.io").on("error", () => {}); out.tls = "NOT BLOCKED"; }
      catch (error) { out.tls = error.message; }
      fetch("https://api.elevenlabs.io/v1/models", { signal: AbortSignal.timeout(1500) })
        .then(() => { out.fetch = "NOT BLOCKED"; })
        .catch((error) => { out.fetch = error.message; })
        .then(() => new Promise((done) => {
          dns.lookup("api.elevenlabs.io", (error) => {
            out.dns = error ? error.message : "NOT BLOCKED";
            done();
          });
        }))
        .then(() => { console.log(JSON.stringify(out)); });
    `);
    const out = result as Record<string, string>;
    expect(out.tls).toContain(MARKER);
    expect(out.fetch).toContain(MARKER);
    expect(out.dns).toContain(MARKER);
  });

  it("still allows a loopback HTTP round trip", async () => {
    const result = await underBlocker(`
      const http = require("node:http");
      const server = http.createServer((_req, res) => res.end("pong")).listen(0, "127.0.0.1");
      server.once("listening", async () => {
        const port = server.address().port;
        const literal = await (await fetch("http://127.0.0.1:" + port + "/")).text();
        const byName = await (await fetch("http://localhost:" + port + "/")).text();
        server.close();
        console.log(JSON.stringify({ literal, byName }));
      });
    `);
    expect(result).toEqual({ literal: "pong", byName: "pong" });
  });

  it("permits a host named in ELV_NO_EGRESS_ALLOW", async () => {
    // The escape hatch a broker or launcher needs. Success here is only that the
    // check let the call through; the socket is destroyed before it can finish.
    const result = await underBlocker(
      `
      const net = require("node:net");
      let message = "allowed";
      try { net.connect(443, "198.51.100.1").on("error", () => {}).destroy(); }
      catch (error) { message = error.message; }
      console.log(JSON.stringify({ message }));
    `,
      { ELV_NO_EGRESS_ALLOW: "198.51.100.1" },
    );
    expect((result as { message: string }).message).toBe("allowed");
  });

  it("stops a credential-bearing provider call and reports it as one envelope", async () => {
    // The canary the assessment asked for: unsetting ELEVENLABS_API_KEY proves
    // nothing when a wrapper re-injects it, so inject a synthetic key on purpose
    // and prove the call is still refused before any egress.
    const syntheticKey = "sk_synthetic_no_egress_canary";
    const run = await runNode(
      ["--import", preload, "--import", "tsx", cliSource, "models", "list"],
      {
        ELEVENLABS_API_KEY: syntheticKey,
      },
    );

    expect(run.code).toBe(7); // transient/network
    const envelope = JSON.parse(run.stdout.trim()) as {
      v: number;
      ok: boolean;
      error: { type: string; message: string };
    };
    expect(envelope.v).toBe(1);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.message).toContain(MARKER);
    expect(run.stdout).not.toContain(syntheticKey);
    expect(run.stderr).not.toContain(syntheticKey);
  });
});
