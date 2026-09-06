import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface SnapshotMetadata {
  source: string;
  retrieved_at: string;
  sha256: string;
  paths: number;
  total_operations: number;
  callable_operations: number;
  skipped_operations: number;
  schemas: number;
}

function metadata(): SnapshotMetadata {
  return JSON.parse(readFileSync("spec/openapi.snapshot.meta.json", "utf8")) as SnapshotMetadata;
}

/** Documentation writes 1507 as "1,507"; accept either grouping of the same number. */
function count(value: number): string {
  return `(?:${value.toLocaleString("en-US")}|${value})`;
}

function literal(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Each entry states the sentence a file actually uses, so deleting the sentence
 * fails the test instead of matching an unrelated digit somewhere in the file.
 */
const DOCUMENTED_FILES: { path: string; patterns: (meta: SnapshotMetadata) => string[] }[] = [
  {
    path: "README.md",
    patterns: (meta) => [
      `contains ${count(meta.total_operations)} operations; \`elv\` compiles ${count(meta.callable_operations)} of them`,
      `invoke all ${count(meta.callable_operations)} operations compiled`,
    ],
  },
  {
    path: "AGENTS.md",
    patterns: (meta) => [
      `contains ${count(meta.total_operations)} documented operations`,
      `${count(meta.callable_operations)} are callable`,
    ],
  },
  {
    path: "skills/elv/SKILL.md",
    patterns: (meta) => [
      `registry documents ${count(meta.total_operations)} operations: ${count(meta.callable_operations)} callable`,
    ],
  },
  {
    path: "docs/agent-setup.md",
    patterns: (meta) => [
      `document contains ${count(meta.total_operations)} operations\\. \`elv\` compiles ${count(meta.callable_operations)}`,
    ],
  },
  {
    path: "docs/api-coverage.md",
    patterns: (meta) => [
      `\\| SHA-256 \\| \`${literal(meta.sha256)}\` \\|`,
      `\\| Paths \\| ${count(meta.paths)} \\|`,
      `\\| Documented operations \\| ${count(meta.total_operations)} \\|`,
      `\\| Callable operations \\| ${count(meta.callable_operations)} \\|`,
      `\\| Skipped operations \\| ${count(meta.skipped_operations)} \\|`,
      `\\| Schemas \\| ${count(meta.schemas)} \\|`,
      `retrieved from \`${literal(meta.source)}\``,
      `at \`${literal(meta.retrieved_at)}\``,
    ],
  },
];

describe("published coverage counts", () => {
  it("states the snapshot counts in the sentence each file uses", () => {
    const meta = metadata();

    for (const { path, patterns } of DOCUMENTED_FILES) {
      const text = readFileSync(path, "utf8");
      for (const pattern of patterns(meta)) {
        expect(text, `${path}: ${pattern}`).toMatch(new RegExp(pattern, "u"));
      }
    }
  });

  it("pins the metadata digest to the vendored snapshot bytes", () => {
    const meta = metadata();
    const bytes = readFileSync("spec/openapi.snapshot.json");

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
  });

  it("ships the API coverage page linked from the README", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };

    expect(manifest.files).toContain("docs/api-coverage.md");
  });

  it("does not ship the obsolete bare-parent exit-2 guidance", () => {
    const text = readFileSync("skills/elv/SKILL.md", "utf8");

    expect(text).toContain("Bare parent commands are discovery");
    expect(text).not.toMatch(/Parent alias commands need a subcommand|elv voices` alone exits 2/u);
  });
});
