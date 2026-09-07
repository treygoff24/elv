// Local install verification for elv, and — only when asked — the install and
// skill propagation themselves.
//
//   node scripts/install-verify.mjs                 # read-only: report drift
//   node scripts/install-verify.mjs --install       # pack + install to --prefix
//   node scripts/install-verify.mjs --sync-skill    # copy repo skill into the pool
//
// Why this exists: the devbox global elv is a packed install, not a link, so a
// rebuilt dist/cli.js does not reach the runtime agents actually use. The
// shipped skill has the same problem one layer out — the repo tree, the tree
// inside the installed package, and the active tree in the skill-library pool
// can all disagree, and on 2026-09-06 they did: the active copy still taught a
// command that had been removed.
//
// Default mode writes nothing. --install and --sync-skill are the only modes
// that touch anything outside this repo, and neither commits, pushes, bumps a
// version, or deletes a file. Skill propagation precedes verification so the
// final report describes the resulting state.
//
// Options:
//   --prefix DIR       npm global prefix to check (default $ELV_INSTALL_PREFIX,
//                      else ~/.local)
//   --skill-dir DIR    active skill tree (default $ELV_ACTIVE_SKILL_DIR, else
//                      ~/.agents/skill-library/elv)
//   --allow-network    let --install resolve dependencies online; the default is
//                      a cache-only offline install
//   --force-skill      let --sync-skill overwrite an active file that has
//                      uncommitted local edits
//   --skip-smoke       skip the installed-binary smoke run

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const argv = process.argv.slice(2);
function flag(name) {
  return argv.includes(name);
}
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value`);
  return value;
}
function fail(message) {
  process.stderr.write(`install-verify: ${message}\n`);
  process.exit(2);
}

for (const arg of argv) {
  const known = [
    "--install",
    "--sync-skill",
    "--prefix",
    "--skill-dir",
    "--allow-network",
    "--force-skill",
    "--skip-smoke",
  ];
  if (arg.startsWith("--") && !known.includes(arg)) fail(`unknown option ${arg}`);
}

const doInstall = flag("--install");
const doSyncSkill = flag("--sync-skill");
const prefix = resolve(
  option("--prefix", process.env.ELV_INSTALL_PREFIX ?? join(homedir(), ".local")),
);
const activeSkillDir = resolve(
  option(
    "--skill-dir",
    process.env.ELV_ACTIVE_SKILL_DIR ?? join(homedir(), ".agents", "skill-library", "elv"),
  ),
);

const packageDir = join(prefix, "lib", "node_modules", manifest.name);
const installedBin = join(prefix, "bin", "elv");
const repoDist = join(repoRoot, "dist", "cli.js");
const repoSkillDir = join(repoRoot, "skills", "elv");

const problems = [];
const notes = [];
function problem(message) {
  problems.push(message);
  process.stdout.write(`  DRIFT  ${message}\n`);
}
function ok(message) {
  process.stdout.write(`  ok     ${message}\n`);
}
function note(message) {
  notes.push(message);
  process.stdout.write(`  note   ${message}\n`);
}
function section(title) {
  process.stdout.write(`\n${title}\n`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Relative path -> sha256 for every file under `root`, recursively. */
function treeManifest(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(relative(root, full), sha256(full));
      else
        files.set(
          relative(root, full),
          `unsupported:${entry.isSymbolicLink() ? "symlink" : "special"}`,
        );
    }
  };
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) {
    files.set(".", "unsupported:root");
    return files;
  }
  walk(root);
  return files;
}

function compareTrees(label, expected, actualRoot) {
  if (!existsSync(actualRoot)) {
    problem(`${label}: missing tree at ${actualRoot}`);
    return;
  }
  const actual = treeManifest(actualRoot);
  const missing = [...expected.keys()].filter((path) => !actual.has(path));
  const extra = [...actual.keys()].filter((path) => !expected.has(path));
  const differing = [...expected.entries()]
    .filter(([path, hash]) => actual.has(path) && actual.get(path) !== hash)
    .map(([path]) => path);

  if (missing.length) problem(`${label}: missing ${missing.join(", ")}`);
  if (extra.length) problem(`${label}: unexpected ${extra.join(", ")}`);
  if (differing.length) problem(`${label}: differs from the repo: ${differing.join(", ")}`);
  if (!missing.length && !extra.length && !differing.length) {
    ok(`${label}: ${expected.size} files identical to the repo`);
  }
}

/**
 * Backticked identifiers in the skill's Route map table. This is the drift that
 * actually happened: the table kept naming a command after it was removed.
 */
function routeMapCommands(skillFile) {
  const text = readFileSync(skillFile, "utf8");
  const start = text.indexOf("## Route map");
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const block = end === -1 ? rest : rest.slice(0, end);
  const names = new Set();
  for (const match of block.matchAll(/`([^`]+)`/g)) {
    // A cell holds either a bare name (`tts`) or a whole invocation
    // (`elv rtc --agent-id ID`); in both cases the command is the first token
    // after the binary. Trailing forms like `ops search|get|schema` keep their
    // parent, which is the name we can check.
    const tokens = match[1].trim().split(/\s+/);
    const candidate = tokens[0] === "elv" ? tokens[1] : tokens[0];
    if (candidate && /^[a-z][a-z0-9-]*$/.test(candidate)) names.add(candidate);
  }
  names.delete("elv");
  return names;
}

// ---------------------------------------------------------------- install ----

if (doInstall) {
  section(`Install into ${prefix}`);
  const work = mkdtempSync(join(tmpdir(), "elv-install-"));
  try {
    const packed = spawnSync("npm", ["pack", "--pack-destination", work], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (packed.status !== 0) {
      process.stderr.write(packed.stderr ?? "");
      fail("npm pack failed");
    }
    const tarball = join(
      work,
      `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`,
    );
    if (!existsSync(tarball)) fail(`npm pack produced no ${tarball}`);

    const installArgs = [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
    ];
    if (!flag("--allow-network")) installArgs.push("--offline");
    installArgs.push(tarball);
    const installed = spawnSync("npm", installArgs, { cwd: repoRoot, encoding: "utf8" });
    process.stdout.write(installed.stdout ?? "");
    if (installed.status !== 0) {
      process.stderr.write(installed.stderr ?? "");
      fail(
        "install failed. If the log shows a cache miss, either populate the npm " +
          "cache (npm ci) or re-run with --allow-network.",
      );
    }
    ok(`installed ${manifest.name}@${manifest.version} from ${tarball}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- verify ----

section("Paths");
for (const [label, path] of [
  ["repo", repoRoot],
  ["built cli", repoDist],
  ["installed package", packageDir],
  ["installed bin", installedBin],
  ["repo skill", repoSkillDir],
  ["active skill", activeSkillDir],
]) {
  if (existsSync(path)) ok(`${label}: ${path}`);
  else problem(`${label}: not found at ${path}`);
}

if (!existsSync(repoDist)) {
  process.stderr.write("install-verify: dist/cli.js is missing; run `npm run build` first.\n");
  process.exit(1);
}

section("Installed binary");
let binVerified = false;
const installedDist = join(packageDir, "dist", "cli.js");
if (existsSync(installedBin)) {
  if (lstatSync(installedBin).isSymbolicLink()) {
    const target = resolve(dirname(installedBin), readlinkSync(installedBin));
    if (existsSync(installedDist) && realpathSync(target) === realpathSync(installedDist)) {
      binVerified = true;
      ok(`bin symlink resolves into the installed package: ${target}`);
    } else {
      problem(`bin symlink points at ${target}, expected ${installedDist}`);
    }
  } else {
    problem(`${installedBin} is not the expected npm bin symlink`);
  }
}

if (existsSync(installedDist)) {
  const repoHash = sha256(repoDist);
  const installedHash = sha256(installedDist);
  if (repoHash === installedHash) {
    ok(`dist/cli.js bytes identical (sha256 ${repoHash.slice(0, 16)}…)`);
  } else {
    binVerified = false;
    problem(
      `dist/cli.js differs: repo ${repoHash.slice(0, 16)}… vs installed ${installedHash.slice(0, 16)}…. ` +
        `Rebuilding does not update a packed install; re-run with --install.`,
    );
  }
  const installedManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (installedManifest.version === manifest.version) ok(`version ${manifest.version}`);
  else
    problem(`version differs: repo ${manifest.version} vs installed ${installedManifest.version}`);
}

// Refuse symlink roots and children before any write, including broken links.
function assertSafeDestination(path) {
  let current = resolve(path);
  for (;;) {
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) fail(`refusing symlink destination ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function shellArg(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

const repoSkill = treeManifest(repoSkillDir);
if (doSyncSkill) {
  section("Skill propagation (copy only, never delete, never commit)");
  assertSafeDestination(activeSkillDir);
  const existing = existsSync(activeSkillDir);
  const parent = dirname(activeSkillDir);
  const gitRoot = spawnSync(
    "git",
    ["-C", existing ? activeSkillDir : parent, "rev-parse", "--show-toplevel"],
    { encoding: "utf8" },
  );
  const libraryRoot = gitRoot.status === 0 ? gitRoot.stdout.trim() : parent;
  const skillName = relative(libraryRoot, activeSkillDir);
  const gitStatus =
    gitRoot.status === 0
      ? spawnSync(
          "git",
          [
            "-C",
            libraryRoot,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--",
            `:(literal)${skillName}`,
          ],
          { encoding: "utf8" },
        )
      : null;
  if (
    existing &&
    (!gitStatus || gitStatus.status !== 0 || gitStatus.stdout.length > 0) &&
    !flag("--force-skill")
  ) {
    fail(
      "active skill has uncommitted edits or unknown Git state; inspect it or explicitly use --force-skill",
    );
  }
  const active = existing ? treeManifest(activeSkillDir) : new Map();
  // Preflight every destination before copying any file. Force never permits escapes.
  for (const [rel, hash] of repoSkill) {
    if (hash.startsWith("unsupported:")) fail(`unsupported source skill entry ${rel}`);
    const destination = join(activeSkillDir, rel);
    assertSafeDestination(destination);
    if (existsSync(destination) && !lstatSync(destination).isFile())
      fail(`destination is not a file: ${destination}`);
  }
  const copied = [];
  for (const [rel, hash] of repoSkill) {
    if (active.get(rel) === hash) continue;
    const destination = join(activeSkillDir, rel);
    mkdirSync(dirname(destination), { recursive: true });
    assertSafeDestination(destination);
    copyFileSync(join(repoSkillDir, rel), destination);
    copied.push(rel);
  }
  ok(`copied ${copied.length} file(s): ${copied.join(", ")}`);
  const stale = [...active.keys()].filter((rel) => !repoSkill.has(rel));
  if (stale.length) note(`foreign entries retained: ${stale.join(", ")}`);
  if (copied.length)
    process.stdout.write(
      `\n  Review copied files, then deliberately stage:\n    git -C ${shellArg(libraryRoot)} add -- ${copied.map((rel) => shellArg(join(skillName, rel))).join(" ")}\n`,
    );
}

section("Skill trees");
ok(`repo skill tree: ${repoSkill.size} files under ${repoSkillDir}`);
compareTrees("installed package skill", repoSkill, join(packageDir, "skills", "elv"));
compareTrees("active skill", repoSkill, activeSkillDir);

section("Documented commands");
// Every top-level command the skill's Route map advertises must exist in the
// installed runtime. Checking the active copy as well as the repo's is the
// point: the active copy is what an agent actually loads, and it is the one
// that went stale.
if (!binVerified) {
  note("installed bin unverified; refusing to execute it for documented commands");
} else {
  const cache = mkdtempSync(join(tmpdir(), "elv-verify-cache-"));
  let capabilities;
  try {
    capabilities = spawnSync(installedBin, ["capabilities"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ELEVENLABS_API_KEY: "",
        ELV_CACHE_DIR: cache,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(repoRoot, "scripts", "no-egress.mjs")).href}`,
      },
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  if (capabilities.status !== 0) {
    problem(`\`elv capabilities\` exited ${capabilities.status}: ${capabilities.stderr?.trim()}`);
  } else {
    const data = JSON.parse(capabilities.stdout).data;
    const known = new Set([
      ...data.command_families.map((entry) => entry.name),
      ...data.alias_families.map((entry) => entry.name),
    ]);
    for (const [label, skillFile] of [
      ["repo", join(repoSkillDir, "SKILL.md")],
      ["installed package", join(packageDir, "skills", "elv", "SKILL.md")],
      ["active", join(activeSkillDir, "SKILL.md")],
    ]) {
      if (!existsSync(skillFile)) {
        problem(`${label} skill: no SKILL.md at ${skillFile}`);
        continue;
      }
      if (lstatSync(skillFile).isSymbolicLink() || lstatSync(dirname(skillFile)).isSymbolicLink()) {
        problem(`${label} skill: refusing symlink Route map at ${skillFile}`);
        continue;
      }
      const documented = routeMapCommands(skillFile);
      if (!documented) {
        problem(`${label} skill: no Route map section to check`);
        continue;
      }
      const unknown = [...documented].filter((name) => !known.has(name));
      if (unknown.length) {
        problem(
          `${label} skill Route map names commands the installed CLI does not have: ${unknown.join(", ")}`,
        );
      } else {
        ok(`${label} skill: all ${documented.size} Route map commands exist in the installed CLI`);
      }
    }
  }
}

// ------------------------------------------------------------------ smoke ----

if (!flag("--skip-smoke")) {
  section("Installed-binary smoke");
  if (!binVerified) {
    problem("no verified installed bin to smoke");
  } else {
    const smoke = spawnSync("sh", [join(repoRoot, "scripts", "smoke.sh")], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ELV_BIN: installedBin },
      maxBuffer: 32 * 1024 * 1024,
    });
    const summary = (smoke.stdout ?? "").trim().split("\n").pop();
    if (smoke.status === 0) ok(`${summary} (${installedBin})`);
    else {
      process.stderr.write(smoke.stdout ?? "");
      process.stderr.write(smoke.stderr ?? "");
      problem("installed-binary smoke failed");
    }
  }
}

section("Summary");
if (problems.length === 0) {
  process.stdout.write(
    `  no drift found${notes.length ? `; ${notes.length} note(s) above` : ""}\n`,
  );
  process.exit(0);
}
process.stdout.write(`  ${problems.length} drift finding(s):\n`);
for (const message of problems) process.stdout.write(`    - ${message}\n`);
process.exit(1);
