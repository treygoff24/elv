import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

// Negative and allowlist probes run over synthetic transports installed BEFORE
// the guard through inherited NODE_OPTIONS. Removing the guard cannot send traffic.
// The separate positive round trip uses only a literal loopback address.

const execFileAsync = promisify(execFile);

const preload = fileURLToPath(new URL("../../scripts/no-egress.mjs", import.meta.url));
const cliSource = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const MARKER = "ELV_NO_EGRESS_BLOCKED";
const SYNTHETIC = "ELV_SYNTHETIC_TRANSPORT_REACHED";
const transport = new URL("../fixtures/synthetic-transports.mjs", import.meta.url);

interface ChildRun {
  stdout: string;
  stderr: string;
  code: number;
}

async function runNode(args: string[], env: Record<string, string> = {}): Promise<ChildRun> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "elv-transport-test-")));
  const config = join(dir, "config.json");
  writeFileSync(config, "{}");
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: dir,
        ELV_CONFIG: config,
        ELV_PROFILE: "default",
        ELV_CACHE_DIR: dir,
        ELV_OUTPUT_DIR: join(dir, "out"),
        ELEVENLABS_API_KEY: "",
        ELEVENLABS_BASE_URL: "https://api.elevenlabs.io",
        NODE_OPTIONS: `--import=${transport.href}`,
        ELV_NO_EGRESS_ALLOW: "",
        ...env,
      },
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? -1 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    // The synthetic Socket.connect cannot emit packets, regardless of address.
    const result = await underBlocker(`
      const net = require("node:net");
      let message = "unblocked";
      try { net.connect(443, "198.51.100.1"); }
      catch (error) { message = error.message; }
      console.log(JSON.stringify({ message }));
    `);
    expect((result as { message: string }).message).toContain(MARKER);
  });

  it("refuses TLS, DNS and fetch for a public hostname", async () => {
    const result = await underBlocker(`
      const dns = require("node:dns");
      const tls = require("node:tls");
      const out = {};
      try { tls.connect(443, "api.elevenlabs.io"); out.tls = "NOT BLOCKED"; }
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
    const run = await runNode(
      [
        "--import",
        preload,
        "-e",
        `
      const http = require("node:http");
      const server = http.createServer((_req, res) => res.end("pong")).listen(0, "127.0.0.1");
      server.once("listening", async () => {
        const port = server.address().port;
        const literal = await (await fetch("http://127.0.0.1:" + port + "/")).text();
        server.close();
        console.log(JSON.stringify({ literal }));
      });
    `,
      ],
      { NODE_OPTIONS: "" },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ literal: "pong" });
  });

  it("permits a host named in ELV_NO_EGRESS_ALLOW", async () => {
    // Reaching the synthetic transport proves the allowlist passed the call.
    const result = await underBlocker(
      `
      const net = require("node:net");
      let message = "allowed";
      try { net.connect(443, "198.51.100.1"); }
      catch (error) { message = error.message; }
      console.log(JSON.stringify({ message }));
    `,
      { ELV_NO_EGRESS_ALLOW: "198.51.100.1" },
    );
    expect((result as { message: string }).message).toBe(SYNTHETIC);
  });

  it("stops a credential-bearing provider call and reports it as one envelope", async () => {
    // The canary the assessment asked for: unsetting ELEVENLABS_API_KEY proves
    // nothing when a wrapper re-injects it, so inject a synthetic key on purpose
    // and assert the guard refusal above an independently inert transport.
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

it("guards named DNS exports, all resolver methods, and localhost DNS packets", async () => {
  const result = await runNode([
    "--input-type=module",
    "-e",
    `
    import dns from 'node:dns';
    import promises from 'node:dns/promises';
    const methods = ['resolve4','resolveSoa','resolveNaptr','resolvePtr','resolveCaa','reverse','lookupService'];
    await import(${JSON.stringify(preload)});
    const named = await import('node:dns');
    const namedPromises = await import('node:dns/promises');
    const messages = [];
    for (const target of [dns, promises, new dns.Resolver(), new promises.Resolver()]) {
      for (const method of methods) {
        if (method === "lookupService" && !Object.hasOwn(target, method)) continue;
        try { await target[method]('localhost'); messages.push('unblocked'); }
        catch (error) { messages.push(error.message); }
      }
    }
    console.log(JSON.stringify({same: named.resolve4 === dns.resolve4 && namedPromises.resolve4 === promises.resolve4, messages}));
  `,
  ]);
  expect(result.code, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.same).toBe(true);
  expect(data.messages).toHaveLength(26);
  for (const message of data.messages) expect(message).toContain(MARKER);
});

it("removing the guard exposes only synthetic transports, including in CLI children", async () => {
  const run = await runNode([
    "-e",
    `
    const out = [];
    try { require('node:net').connect(443, '198.51.100.1'); } catch (error) { out.push(error.message); }
    try { require('node:tls').connect(443, 'api.elevenlabs.io'); } catch (error) { out.push(error.message); }
    require('node:dns').resolve4('api.elevenlabs.io', async (error) => {
      out.push(error.message);
      try { await fetch('https://api.elevenlabs.io/v1/models'); } catch (error) { out.push(error.message); }
      console.log(JSON.stringify(out));
    });
  `,
  ]);
  expect(run.code, run.stderr).toBe(0);
  expect(JSON.parse(run.stdout)).toEqual(Array(4).fill(SYNTHETIC));
  const cli = await runNode(["--import", "tsx", cliSource, "models", "list"], {
    ELEVENLABS_API_KEY: "synthetic-only",
  });
  expect(cli.code).toBe(7);
  expect(JSON.parse(cli.stdout).error.message).toContain(SYNTHETIC);
  expect(cli.stdout).not.toContain(MARKER);
});
