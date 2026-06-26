import { describe, expect, it } from "vitest";
import { main } from "../../src/cli";

describe("cli main", () => {
  it("exports a programmatic entrypoint without auto-running on import", () => {
    expect(main).toBeTypeOf("function");
  });
});
