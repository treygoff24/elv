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
    expect(() => readPath({ data: { items: [] } }, "data.items[*].state")).toThrow(/\* is not supported/i);
    expect(() => readPath({ data: { items: [] } }, "voices[*]")).toThrow(/\* is not supported/i);
    expect(() => readPath({ data: { items: [] } }, "data.items[0].state")).toThrow(/\[\] array projection/i);
    expect(() => readPath({ data: { items: [] } }, "foo[]bar.x")).toThrow(/\[\] array projection/i);
    expect(() => readPath({ data: { items: [] } }, "foo[")).toThrow(/\[\] array projection/i);
    expect(() => readPath({ data: { items: [] } }, "foo]")).toThrow(/\[\] array projection/i);
    expect(() => readPath({ data: { items: [] } }, "data..state")).toThrow(/recursive/i);
  });

  it("groups per level for nested [] wildcards (array-of-arrays, not flattened)", () => {
    const obj = {
      voices: [
        { samples: [{ id: "a" }, { id: "b" }] },
        { samples: [{ id: "c" }] },
      ],
    };
    expect(readPath(obj, "voices[].samples[].id")).toEqual([["a", "b"], ["c"]]);
  });

  it("projects a field across an array with [] (returns names, preserves order)", () => {
    const obj = { voices: [{ name: "Bella" }, { name: "Bill" }, { name: "Rachel" }] };
    expect(readPath(obj, "voices[].name")).toEqual(["Bella", "Bill", "Rachel"]);
  });

  it("returns the whole array when [] has no trailing field", () => {
    const obj = { voices: [{ name: "Bella" }, { name: "Bill" }] };
    expect(readPath(obj, "voices[]")).toEqual([{ name: "Bella" }, { name: "Bill" }]);
  });

  it("drills nested paths after []", () => {
    const obj = { voices: [{ ft: { state: "fine_tuned" } }, { ft: { state: "draft" } }] };
    expect(readPath(obj, "voices[].ft.state")).toEqual(["fine_tuned", "draft"]);
  });

  it("yields undefined elements for missing keys under []", () => {
    const obj = { voices: [{ name: "Bella" }, { id: 2 }] };
    expect(readPath(obj, "voices[].name")).toEqual(["Bella", undefined]);
  });

  it("returns undefined when [] targets a non-array", () => {
    expect(readPath({ voices: { name: "Bella" } }, "voices[].name")).toBeUndefined();
  });
});
