import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOCUMENTED_FILES = [
  "README.md",
  "AGENTS.md",
  "skills/elv/SKILL.md",
  "docs/agent-setup.md",
  "docs/api-coverage.md",
];

describe("published coverage counts", () => {
  it("keeps shipped documentation tied to snapshot metadata", () => {
    const metadata = JSON.parse(readFileSync("spec/openapi.snapshot.meta.json", "utf8")) as {
      total_operations: number;
      callable_operations: number;
    };

    for (const path of DOCUMENTED_FILES) {
      const text = readFileSync(path, "utf8");
      expect(text, path).toMatch(new RegExp(`\\b${metadata.total_operations}\\b`, "u"));
      expect(text, path).toMatch(new RegExp(`\\b${metadata.callable_operations}\\b`, "u"));
    }
  });

  it("ships the API coverage page linked from the README", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { files: string[] };

    expect(manifest.files).toContain("docs/api-coverage.md");
  });
});
