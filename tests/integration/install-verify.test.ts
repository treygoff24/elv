import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let root: string;
let repo: string;
let pool: string;
let active: string;
let prefix: string;
let marker: string;
function write(path: string, value: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode });
}
function git(...args: string[]) {
  const result = spawnSync("git", ["-C", pool, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}
function run(...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      join(repo, "scripts/install-verify.mjs"),
      "--prefix",
      prefix,
      "--skill-dir",
      active,
      "--skip-smoke",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: "/var/tmp", PATH: `${join(root, "bin")}:${process.env.PATH}` },
    },
  );
}
function initPool() {
  git("init", "-q");
  git("add", "--", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "elv-install-test-")));
  repo = join(root, "repo");
  pool = join(root, "skill pool");
  active = join(pool, "nested", "elv's skill");
  prefix = join(root, "prefix");
  marker = join(root, "executed.json");
  write(join(repo, "package.json"), JSON.stringify({ name: "fixture-cli", version: "1.0.0" }));
  write(
    join(repo, "scripts/install-verify.mjs"),
    readFileSync(resolve("scripts/install-verify.mjs"), "utf8"),
  );
  copyFileSync(resolve("scripts/no-egress.mjs"), join(repo, "scripts/no-egress.mjs"));
  const cli = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({cache: process.env.ELV_CACHE_DIR, guard: process.env.NODE_OPTIONS})); console.log(JSON.stringify({data:{command_families:[{name:'ops'}],alias_families:[]}}));\n`;
  write(join(repo, "dist/cli.js"), cli, 0o755);
  const installed = join(prefix, "lib/node_modules/fixture-cli");
  write(join(installed, "dist/cli.js"), cli, 0o755);
  write(join(installed, "package.json"), JSON.stringify({ version: "1.0.0" }));
  mkdirSync(join(prefix, "bin"), { recursive: true });
  symlinkSync(join(installed, "dist/cli.js"), join(prefix, "bin/elv"));
  for (const dir of [join(repo, "skills/elv"), join(installed, "skills/elv"), active]) {
    write(join(dir, "SKILL.md"), "## Route map\n| `ops` |\n");
    write(join(dir, "references/calls.md"), "original\n");
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("install verification boundaries", () => {
  it("does not execute a wrong bin target", () => {
    rmSync(join(prefix, "bin/elv"));
    write(join(prefix, "bin/elv"), `#!/bin/sh\ntouch '${marker}'\n`, 0o755);
    const result = run();
    expect(result.status).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });
  it("does not execute a symlink into the wrong artifact", () => {
    rmSync(join(prefix, "bin/elv"));
    const wrong = join(root, "wrong");
    write(wrong, `#!/bin/sh\ntouch '${marker}'\n`, 0o755);
    symlinkSync(wrong, join(prefix, "bin/elv"));
    expect(run().status).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });
  it("guards capabilities and removes its disposable cache", () => {
    const result = run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const called = JSON.parse(readFileSync(marker, "utf8"));
    expect(called.guard).toContain("no-egress.mjs");
    expect(called.cache).toContain("elv-verify-cache-");
    expect(existsSync(called.cache)).toBe(false);
  });
  it("fails closed on a non-Git target", () => {
    write(join(active, "SKILL.md"), "foreign");
    const result = run("--sync-skill");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown Git state");
    expect(readFileSync(join(active, "SKILL.md"), "utf8")).toBe("foreign");
  });
  it("refuses dirty nested files and renames with literal pathspecs", () => {
    initPool();
    write(join(active, "references/calls.md"), "dirty");
    expect(run("--sync-skill").status).not.toBe(0);
    expect(readFileSync(join(active, "references/calls.md"), "utf8")).toBe("dirty");
    git("mv", "--", "nested/elv's skill/SKILL.md", "moved.md");
    expect(run("--sync-skill").status).not.toBe(0);
    expect(existsSync(join(active, "SKILL.md"))).toBe(false);
  });
  it("refuses ignored existing files unless force is explicit", () => {
    initPool();
    write(join(pool, ".git/info/exclude"), "nested/elv's skill/local-note\n");
    write(join(active, "local-note"), "foreign ignored file");
    expect(run("--sync-skill").status).not.toBe(0);
    expect(readFileSync(join(active, "local-note"), "utf8")).toBe("foreign ignored file");
  });
  it("refuses a rename out of the skill with no other dirty files", () => {
    initPool();
    git("mv", "--", "nested/elv's skill/SKILL.md", "moved.md");
    expect(run("--sync-skill").status).not.toBe(0);
    expect(existsSync(join(active, "SKILL.md"))).toBe(false);
  });
  it("retains extra symlinks during explicit forced sync and reports final drift", () => {
    symlinkSync(join(root, "absent"), join(active, "extra"));
    write(join(active, "references/calls.md"), "foreign");
    const result = run("--sync-skill", "--force-skill");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unexpected extra");
    expect(readFileSync(join(active, "references/calls.md"), "utf8")).toBe("original\n");
  });
  it.each(["file", "directory", "root"])("never follows a %s symlink even with force", (kind) => {
    const canary = join(root, "outside");
    write(join(canary, "SKILL.md"), "canary");
    write(join(canary, "calls.md"), "canary");
    const target =
      kind === "file"
        ? join(active, "SKILL.md")
        : kind === "directory"
          ? join(active, "references")
          : active;
    rmSync(target, { recursive: true });
    symlinkSync(kind === "file" ? join(canary, "SKILL.md") : canary, target);
    const result = run("--sync-skill", "--force-skill");
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(canary, "SKILL.md"), "utf8")).toBe("canary");
    expect(readFileSync(join(canary, "calls.md"), "utf8")).toBe("canary");
  });
  it("reports and retains extra symlink drift", () => {
    symlinkSync(join(root, "absent"), join(active, "extra"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unexpected extra");
  });
  it("syncs a clean nested target, verifies afterward, and names only copied files", () => {
    initPool();
    write(join(repo, "skills/elv/references/calls.md"), "new");
    // Keep the packaged source identical so any remaining drift is the active sync.
    write(join(prefix, "lib/node_modules/fixture-cli/skills/elv/references/calls.md"), "new");
    write(join(pool, "unrelated"), "dirty foreign file");
    const result = run("--sync-skill");
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(readFileSync(join(active, "references/calls.md"), "utf8")).toBe("new");
    expect(result.stdout).toContain("add -- 'nested/elv'\\''s skill/references/calls.md'");
    expect(result.stdout).not.toContain("add -- 'nested/elv'\\''s skill/SKILL.md'");
    expect(readFileSync(join(pool, "unrelated"), "utf8")).toBe("dirty foreign file");
  });
  it("uses offline ignore-scripts installation (synthetic npm only)", () => {
    const argsFile = join(root, "npm-args");
    write(
      join(root, "bin/npm"),
      `#!/bin/sh\nif [ "$1" = pack ]; then touch "$3/fixture-cli-1.0.0.tgz"; else printf '%s\\n' "$@" > '${argsFile}'; fi\n`,
      0o755,
    );
    const result = run("--install");
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const args = readFileSync(argsFile, "utf8").split("\n");
    expect(args).toContain("--ignore-scripts");
    expect(args).toContain("--offline");
  });
});
