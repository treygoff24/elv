import { describe, expect, it } from "vitest";
import { success } from "../../src/core/envelope";
import { projectFields } from "../../src/commands/aliases/shared";
import type { SuccessEnvelope } from "../../src/core/types";

function env(data: unknown): SuccessEnvelope {
  return success({ cmd: "elv voices list", data });
}

describe("projectFields", () => {
  it("projects the dominant collection to the requested fields, dropping fat fields", () => {
    const result = projectFields(
      env({
        voices: [
          { voice_id: "v1", name: "Bella", fine_tuning: { state: "x".repeat(500) } },
          { voice_id: "v2", name: "Bill", fine_tuning: { state: "y".repeat(500) } },
        ],
        has_more: false,
        total_count: 2,
      }),
      ["voice_id", "name"],
    );
    expect(result.data).toEqual({
      voices: [
        { voice_id: "v1", name: "Bella" },
        { voice_id: "v2", name: "Bill" },
      ],
      has_more: false,
      total_count: 2,
    });
  });

  it("projects a top-level array directly", () => {
    const result = projectFields(
      env([
        { id: 1, big: "z".repeat(99) },
        { id: 2, big: "z" },
      ]),
      ["id"],
    );
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("picks the longest array when several are present", () => {
    const result = projectFields(
      env({ languages: [{ code: "en" }], voices: [{ name: "Bella" }, { name: "Bill" }] }),
      ["name"],
    );
    expect(result.data).toMatchObject({
      languages: [{ code: "en" }], // untouched
      voices: [{ name: "Bella" }, { name: "Bill" }],
    });
  });

  it("omits fields that are absent on an item rather than emitting undefined", () => {
    const result = projectFields(env({ voices: [{ name: "Bella" }, { id: "v2" }] }), ["name"]);
    expect(result.data).toEqual({ voices: [{ name: "Bella" }, {}] });
  });

  it("leaves non-collection data untouched", () => {
    const result = projectFields(env({ character_count: 40 }), ["name"]);
    expect(result.data).toEqual({ character_count: 40 });
  });
});
