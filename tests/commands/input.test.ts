import { describe, expect, it } from "vitest";
import { addFiles, addPairs } from "../../src/commands/input";

describe("command input helpers", () => {
  it("adds query/path pairs and accumulates array file fields", () => {
    const input: Record<string, unknown> = {};

    addPairs(input, "query", ["page=2"]);
    addPairs(input, "path", ["voice_id=v1"]);
    addFiles(input, ["files[]=a.wav", "files[]=b.wav"]);

    expect(input.query).toEqual({ page: "2" });
    expect(input.path).toEqual({ voice_id: "v1" });
    expect(input.files).toMatchObject({
      files: [expect.stringContaining("a.wav"), expect.stringContaining("b.wav")],
    });
  });

  it("rejects malformed key-value pairs", () => {
    expect(() => addPairs({}, "query", ["missing-equals"])).toThrow(/key=value/u);
  });
});
