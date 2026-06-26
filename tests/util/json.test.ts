import { describe, expect, it } from "vitest";
import { isRecord, parseJson, parseJsonRecord } from "../../src/util/json";

describe("json utilities", () => {
  it("parses records and labels malformed JSON", () => {
    expect(parseJsonRecord('{"ok":true}')).toEqual({ ok: true });
    expect(() => parseJson("{bad", "payload")).toThrow(/payload is not valid JSON/u);
  });

  it("distinguishes records from arrays", () => {
    expect(isRecord({ ok: true })).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(() => parseJsonRecord("[]", "payload")).toThrow(/payload must be an object/u);
  });
});
