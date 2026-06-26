import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression guard for the npm link / npm install -g path. When elv is invoked
// through its bin symlink, process.argv[1] is the symlink while import.meta.url
// resolves to the real module, so the entrypoint guard must realpath both sides.
// Every other spawn test runs `npx tsx src/cli.ts`, where argv[1] already equals
// the real source path, so none of them exercise this case.

const distPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function runNode(scriptPath: string, args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.ELEVENLABS_API_KEY; // offline, deterministic; --version needs no key
    const child = spawn(process.execPath, [scriptPath, ...args], { env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => resolvePromise({ stdout, code }));
  });
}

// Skip on Windows: npm there installs bins as .cmd/.ps1 shims that invoke node
// with the real path, so this symlink-specific failure mode doesn't apply, and
// creating file symlinks needs Developer Mode/admin.
describe.skipIf(process.platform === "win32")("bin symlink invocation (npm link / npm install -g)", () => {
  let dir = "";
  let link = "";

  beforeAll(() => {
    // Always rebuild so the test exercises current source, not a stale dist.
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "ignore" });
    dir = mkdtempSync(join(tmpdir(), "elv-bin-"));
    link = join(dir, "elv");
    symlinkSync(distPath, link);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("emits a JSON envelope when run through a bin symlink", async () => {
    const { stdout, code } = await runNode(link, ["--version"]);
    // Before the realpath fix this was empty (main() silently skipped) with exit 0.
    expect(stdout.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(stdout.trim()) as {
      v: number;
      ok: boolean;
      data: { version: string };
    };
    expect(parsed.v).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.version).toBeTypeOf("string");
    expect(code).toBe(0);
  });
});
