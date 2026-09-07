import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildViewResult } from "../../src/commands/view";
import { ExitCode } from "../../src/core/types";
import type { CommandResult, SuccessEnvelope } from "../../src/core/types";
import type { JsonValue } from "../../src/util/json";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-view-stream-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ndjson(name: string, lines: string[]): string {
  const file = join(dir, name);
  writeFileSync(file, lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
  return file;
}

function rows(items: JsonValue[], name = "rows.ndjson"): string {
  return ndjson(
    name,
    items.map((item) => JSON.stringify(item)),
  );
}

function successEnv(result: CommandResult): SuccessEnvelope {
  if (!result.env.ok) throw new Error(`expected success, got ${JSON.stringify(result.env)}`);
  return result.env;
}

function data(result: CommandResult): unknown {
  return successEnv(result).data;
}

function errorMessageOf(result: CommandResult): string {
  if (result.env.ok) throw new Error(`expected failure, got ${JSON.stringify(result.env)}`);
  return result.env.error.message;
}

/**
 * Whole-document `.json` reading is untouched, so it is the reference implementation for
 * every NDJSON selection: the same array, viewed both ways, must produce the same
 * envelope once the differing file path is normalized out.
 */
function expectSameAsWholeFile(items: JsonValue[], options: { path?: string; limit?: string }) {
  const nd = rows(items, "parity.ndjson");
  const whole = join(dir, "parity.json");
  writeFileSync(whole, JSON.stringify(items), "utf8");

  const streamed = buildViewResult(nd, options);
  const reference = buildViewResult(whole, options);

  const normalize = (result: CommandResult, file: string) =>
    JSON.stringify(result.env).split(JSON.stringify(file).slice(1, -1)).join("<FILE>");

  expect(normalize(streamed, nd)).toBe(normalize(reference, whole));
  expect(streamed.exitCode).toBe(reference.exitCode);
  return streamed;
}

describe("view streams NDJSON without loading the whole file", () => {
  it("refuses a credential that appears after the rows the caller asked for", () => {
    const file = ndjson("late-secret.ndjson", [
      ...Array.from({ length: 200 }, (_, index) => JSON.stringify({ id: index })),
      JSON.stringify({ token: "SECRET_LATE_LINE_CANARY" }),
    ]);

    const result = buildViewResult(file, { limit: "1" });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(JSON.stringify(result.env)).not.toContain("SECRET_LATE_LINE_CANARY");
    expect(errorMessageOf(result)).toContain("Refusing to render sensitive");
  });

  it("refuses a credential on the final line of a file that is otherwise clean", () => {
    const file = ndjson("tail-secret.ndjson", [
      JSON.stringify({ id: 1 }),
      JSON.stringify({ nested: [{ xi_api_key: "TAIL_CANARY" }] }),
    ]);

    const result = buildViewResult(file, { path: "0" });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(JSON.stringify(result.env)).not.toContain("TAIL_CANARY");
  });

  it("reports a malformed line that follows the selected rows", () => {
    const file = ndjson("late-malformed.ndjson", [
      ...Array.from({ length: 50 }, (_, index) => JSON.stringify({ id: index })),
      "{not json",
    ]);

    const result = buildViewResult(file, { limit: "1" });

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(errorMessageOf(result)).toContain("Use cat to inspect raw contents.");
  });

  it("keeps a malformed line ahead of a credential refusal, as whole-file parsing did", () => {
    const file = ndjson("both.ndjson", [
      JSON.stringify({ token: "PRECEDENCE_CANARY" }),
      JSON.stringify({ id: 2 }),
      "{not json",
    ]);

    const result = buildViewResult(file);

    expect(result.exitCode).toBe(ExitCode.InputValidation);
    expect(errorMessageOf(result)).toContain("File is not valid JSON");
    expect(JSON.stringify(result.env)).not.toContain("PRECEDENCE_CANARY");
  });

  it("bounds the envelope and flags truncation when --limit is smaller than the file", () => {
    const file = rows(Array.from({ length: 5000 }, (_, index) => ({ id: index })));

    const result = buildViewResult(file, { limit: "2" });

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(data(result)).toEqual([{ id: 0 }, { id: 1 }]);
    expect(successEnv(result).truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.env))).toBeLessThan(1024);
  });

  it("does not flag truncation when --limit exceeds the row count", () => {
    const file = rows([{ id: 0 }, { id: 1 }]);

    const result = buildViewResult(file, { limit: "10" });

    expect(data(result)).toEqual([{ id: 0 }, { id: 1 }]);
    expect(successEnv(result).truncated).toBeUndefined();
  });

  it("summarizes instead of inlining once the selected rows exceed the inline limit", () => {
    const file = rows(
      Array.from({ length: 40 }, (_, index) => ({ index, blob: "y".repeat(1200) })),
    );

    const result = buildViewResult(file);
    const env = successEnv(result);

    expect(result.exitCode).toBe(ExitCode.Success);
    expect(env.data).toBeUndefined();
    expect(env.data_summary).toMatchObject({ type: "array", count: 40 });
    expect(env.truncated).toBe(true);
    expect(env.hints?.[0]?.cmd).toContain("--path '0'");
    expect(Buffer.byteLength(JSON.stringify(result.env))).toBeLessThanOrEqual(8 * 1024);
  });

  it("reads records that straddle the read-chunk boundary, including multi-byte characters", () => {
    // The first line plus its newline is 65529 bytes, so the 3-byte character at offset
    // 65535 is split across the 64 KiB chunk boundary.
    const filler = "x".repeat(65520);
    const file = ndjson("chunked.ndjson", [
      JSON.stringify({ a: filler }),
      JSON.stringify({ b: "日本" }),
      JSON.stringify({ c: "tail" }),
    ]);
    expect(Buffer.byteLength(`${JSON.stringify({ a: filler })}\n`)).toBe(65529);

    expect(data(buildViewResult(file, { path: "1" }))).toEqual({ b: "日本" });
    expect(data(buildViewResult(file, { path: "2" }))).toEqual({ c: "tail" });
    expect(data(buildViewResult(file, { path: "[].b" }))).toEqual([undefined, "日本", undefined]);
  });

  it("treats a file of only blank lines as an empty array", () => {
    const file = join(dir, "blank.ndjson");
    writeFileSync(file, "\n\n   \n", "utf8");

    expect(data(buildViewResult(file))).toEqual([]);
  });

  it("reads a final record that has no trailing newline", () => {
    const file = join(dir, "no-newline.ndjson");
    writeFileSync(file, '{"id":1}\n{"id":2}', "utf8");

    expect(data(buildViewResult(file))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  describe("selection matches whole-file readPath semantics", () => {
    const items: JsonValue[] = [
      { name: "alpha", tags: ["a", "b"], nested: { id: 1 } },
      { name: "beta", tags: [], nested: { id: 2 } },
      { name: "gamma", nested: { id: 3 } },
    ];

    it.each([
      ["no path", undefined],
      ["array index", "0"],
      ["index then field", "1.name"],
      ["index then nested field", "2.nested.id"],
      ["index past the end", "9"],
      ["bare projection", "[]"],
      ["projection of a field", "[].name"],
      ["projection of a missing field", "[].missing"],
      ["nested projection", "[].tags[]"],
      ["$-prefixed index", "$.0.name"],
      ["non-index head", "name"],
      ["object-style head", "nested.id"],
      ["trailing empty segment after an index", "0."],
      ["trailing empty segment after a projection", "[]."],
      ["leading empty segment", ".name"],
      ["recursive descent", "a..b"],
      ["wildcard", "items.*"],
      ["malformed bracket segment", "foo[]bar.name"],
    ])("%s", (_label, path) => {
      expectSameAsWholeFile(items, path === undefined ? {} : { path });
    });

    it.each(["1", "2", "10"])("matches under --limit %s", (limit) => {
      expectSameAsWholeFile(items, { limit });
      expectSameAsWholeFile(items, { path: "[].name", limit });
    });

    it("matches for an empty document", () => {
      expectSameAsWholeFile([], {});
      expectSameAsWholeFile([], { path: "0" });
      expectSameAsWholeFile([], { path: "[].name" });
      expectSameAsWholeFile([], { path: "0." });
    });

    it("matches when rows are arrays or scalars rather than objects", () => {
      expectSameAsWholeFile([[1, 2], [3], "text", null, 7], {});
      expectSameAsWholeFile([[1, 2], [3], "text", null, 7], { path: "0" });
      expectSameAsWholeFile([[1, 2], [3], "text", null, 7], { path: "3" });
      expectSameAsWholeFile([[1, 2], [3], "text", null, 7], { path: "[]" });
    });
  });

  it("rejects an invalid --limit only after the file scans clean", () => {
    const clean = buildViewResult(rows([{ id: 1 }]), { limit: "0" });
    expect(clean.exitCode).toBe(ExitCode.InputValidation);
    expect(errorMessageOf(clean)).toContain("--limit must be a positive integer");

    // A credential still outranks the bad flag, exactly as whole-file ordering did.
    const secret = ndjson("secret-limit.ndjson", [
      JSON.stringify({ id: 1 }),
      JSON.stringify({ token: "LIMIT_ORDER_CANARY" }),
    ]);
    const result = buildViewResult(secret, { limit: "0" });
    expect(errorMessageOf(result)).toContain("Refusing to render sensitive");
    expect(JSON.stringify(result.env)).not.toContain("LIMIT_ORDER_CANARY");
  });

  it("maps a missing NDJSON file to not_found", () => {
    const result = buildViewResult(join(dir, "missing.ndjson"));
    expect(result.exitCode).toBe(ExitCode.NotFound);
    expect(result.env.ok ? "" : result.env.error.code).toBe("not_found");
  });
});
