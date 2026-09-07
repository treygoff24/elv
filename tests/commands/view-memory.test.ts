import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// Roughly 64 MiB of NDJSON: large enough that reading it as one string cannot fit in
// the heap cap below, small enough to generate in well under a second.
const ROWS = 64_000;
const ROW_PADDING = 980;
const HEAP_CAP_MB = 64;

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-view-memory-"));
  file = join(dir, "large.ndjson");
  const fd = openSync(file, "w");
  try {
    let batch = "";
    for (let index = 0; index < ROWS; index += 1) {
      batch += `${JSON.stringify({ id: index, blob: "x".repeat(ROW_PADDING) })}\n`;
      if (batch.length > 1 << 20) {
        writeSync(fd, batch);
        batch = "";
      }
    }
    writeSync(fd, batch);
  } finally {
    closeSync(fd);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runCapped(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [`--max-old-space-size=${HEAP_CAP_MB}`, "--import", "tsx", "src/cli.ts", ...args],
    { cwd: repoRoot, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("view memory is bounded by the selection, not the file", () => {
  it("cannot hold the same file the way whole-file reading did", () => {
    // The cap only proves something if the previous approach fails under it. This is the
    // control: read the file as one string and parse every line, as `view` used to.
    expect(statSync(file).size).toBeGreaterThan(48 * 1024 * 1024);
    const control = spawnSync(
      process.execPath,
      [
        `--max-old-space-size=${HEAP_CAP_MB}`,
        "-e",
        'const { readFileSync } = require("node:fs");' +
          'const rows = readFileSync(process.argv[1], "utf8").split("\\n")' +
          ".filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));" +
          "process.stdout.write(String(rows.length));",
        file,
      ],
      { encoding: "utf-8" },
    );
    expect(control.status).not.toBe(0);
    expect(control.stderr).toContain("heap out of memory");
  });

  it("views the first row of a 64 MiB NDJSON file under that heap cap", () => {
    const result = runCapped(["view", file, "--limit", "1"]);

    expect(result.stderr).not.toContain("heap out of memory");
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      data: { id: number }[];
      truncated?: boolean;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toHaveLength(1);
    expect(envelope.data[0]?.id).toBe(0);
    expect(envelope.truncated).toBe(true);
    // The whole scan happened, but only the requested row reached stdout.
    expect(result.stdout.length).toBeLessThan(4 * 1024);
  });

  it("summarizes the same file without a --limit, still under the heap cap", () => {
    const result = runCapped(["view", file]);

    expect(result.stderr).not.toContain("heap out of memory");
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim()) as {
      ok: boolean;
      data?: unknown;
      data_summary?: { type: string; count: number };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toBeUndefined();
    expect(envelope.data_summary).toMatchObject({ type: "array", count: ROWS });
    expect(result.stdout.length).toBeLessThan(16 * 1024);
  });

  it("projects one field across every row under that heap cap", () => {
    const result = runCapped(["view", file, "--path", "[].id", "--limit", "3"]);

    expect(result.stderr).not.toContain("heap out of memory");
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout.trim()) as { ok: boolean; data: number[] };
    expect(envelope.data).toEqual([0, 1, 2]);
  });
});
