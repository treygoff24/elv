import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Regression guard for the npm link / npm install -g path. When elv is invoked
// through its bin symlink, process.argv[1] is the symlink while import.meta.url
// resolves to the real module, so the entrypoint guard in src/cli.ts must
// realpath both sides. Every other spawn test passes the real source path as
// argv[1], so none of them exercise this case.
//
// This runs against src/cli.ts under tsx rather than dist/cli.js, so `npm test`
// never builds. The same guard is checked against the real built artifact by
// scripts/pack-smoke.sh, which installs the tarball into a throwaway prefix and
// smokes it through the npm-created bin symlink — the shape a user actually
// gets. Keep both: this one fails fast during development, that one proves the
// shipped bytes.

const sourcePath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function runThroughLink(linkPath: string, args: string[]): Promise<CliRun> {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env };
    delete env.ELEVENLABS_API_KEY; // offline, deterministic; --version needs no key
    const child = spawn(process.execPath, ["--import", "tsx", linkPath, ...args], {
      cwd: repoRoot,
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => resolvePromise({ stdout, stderr, code }));
  });
}

interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
}

// Skip on Windows: npm there installs bins as .cmd/.ps1 shims that invoke node
// with the real path, so this symlink-specific failure mode doesn't apply, and
// creating file symlinks needs Developer Mode/admin.
describe.skipIf(process.platform === "win32")(
  "bin symlink invocation (npm link / npm install -g)",
  () => {
    let dir = "";
    let link = "";

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "elv-bin-"));
      // The basename must stay "elv": src/cli.ts only realpaths argv[1] for the
      // names npm can install it under.
      link = join(dir, "elv");
      symlinkSync(sourcePath, link);
    });

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("invokes the module through a path that differs from its real location", () => {
      // Precondition for the assertion below: without this the test would pass
      // even if the guard compared raw paths.
      expect(link).not.toBe(realpathSync(link));
      expect(realpathSync(link)).toBe(realpathSync(sourcePath));
    });

    it("emits a JSON envelope when run through a bin symlink", async () => {
      const { stdout, stderr, code } = await runThroughLink(link, ["--version"]);
      expect(stdout.trim().length, `no stdout; stderr was: ${stderr}`).toBeGreaterThan(0);
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
  },
);
