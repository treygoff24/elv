import { execFile } from "node:child_process";
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
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const run = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));
it("runs the actual smoke matrix from a checkout path with spaces and punctuation", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "elv-smoke-path-")));
  const checkout = join(root, "checkout with spaces & 'quotes' #hash");
  const scripts = join(checkout, "scripts");
  const log = join(root, "options.ndjson");
  try {
    expect(
      existsSync(join(repo, "dist", "cli.js")),
      "prebuilt CLI required; this fixture must not build",
    ).toBe(true);
    mkdirSync(scripts, { recursive: true });
    for (const file of ["smoke.sh", "no-egress.mjs", "assert-envelope.mjs", "smoke-matrix.tsv"]) {
      copyFileSync(join(repo, "scripts", file), join(scripts, file));
    }
    symlinkSync(join(repo, "dist"), join(checkout, "dist"), "dir");
    symlinkSync(join(repo, "spec"), join(checkout, "spec"), "dir");
    symlinkSync(join(repo, "node_modules"), join(checkout, "node_modules"), "dir");
    copyFileSync(join(repo, "package.json"), join(checkout, "package.json"));
    const config = join(root, "config.json");
    writeFileSync(config, "{}");
    const recorder = join(root, "record-options.mjs");
    writeFileSync(
      recorder,
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.env.NODE_OPTIONS)+'\\n');`,
    );
    const synthetic = new URL("../fixtures/synthetic-transports.mjs", import.meta.url).href;
    const inherited = `--import=${synthetic} --import=${pathToFileURL(recorder).href} --no-warnings`;
    const { stdout, stderr } = await run("sh", [join(scripts, "smoke.sh")], {
      cwd: checkout,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        HOME: root,
        ELV_CONFIG: config,
        ELV_PROFILE: "default",
        ELV_OUTPUT_DIR: join(root, "out"),
        TMPDIR: "/var/tmp",
        NODE_OPTIONS: inherited,
        ELV_BIN: "",
        ELV_CACHE_DIR: "",
        ELV_NO_EGRESS_ALLOW: "",
      },
    });
    const rows = readFileSync(join(scripts, "smoke-matrix.tsv"), "utf8")
      .split("\n")
      .filter((line) => /^\d+\t/.test(line)).length;
    expect(rows).toBeGreaterThan(0);
    expect(stdout.match(/^ok    elv /gm)).toHaveLength(rows);
    expect(stdout).toContain(`smoke: ${rows} passed`);
    expect(stderr).toBe("");
    const expected = pathToFileURL(join(scripts, "no-egress.mjs")).href;
    expect(expected).toContain("%20");
    const options = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string);
    expect(
      options.some((value) => value.includes(`--import=${expected}`) && value.includes(inherited)),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 35000);
