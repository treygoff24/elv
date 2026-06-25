import { describe, expect, it } from "vitest";
import { readPath } from "../src/util/jsonpath";

describe("dotted JSONPath reader", () => {
  it("reads dotted keys, numeric array indices, and leading $.", () => {
    expect(readPath({ data: { items: [{ state: "queued" }, { state: "done" }] } }, "$.data.items.1.state")).toBe("done");
  });

  it("returns undefined for missing segments", () => {
    expect(readPath({ data: {} }, "data.missing.status")).toBeUndefined();
  });

  it("rejects unsupported JSONPath syntax clearly", () => {
    expect(() => readPath({ data: { items: [] } }, "data.items[*].state")).toThrow(/dotted path/i);
    expect(() => readPath({ data: { items: [] } }, "data..state")).toThrow(/recursive/i);
  });
});
