import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildViewResult } from "../src/commands/view";
import { ExitCode } from "../src/core/types";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "elv-view-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("view command", () => {
  it("returns small JSON inline as data", () => {
    const file = join(dir, "small.json");
    writeFileSync(file, JSON.stringify({ ok: true, count: 2 }), "utf8");

    const { env, exitCode } = buildViewResult(file);
    expect(exitCode).toBe(ExitCode.Success);
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toEqual({ ok: true, count: 2 });
    expect(env.data_summary).toBeUndefined();
  });

  it("drills into a dotted path", () => {
    const file = join(dir, "nested.json");
    writeFileSync(file, JSON.stringify({ data: { x: [{ name: "alpha" }, { name: "beta" }] } }), "utf8");

    const { env, exitCode } = buildViewResult(file, { path: "data.x.0" });
    expect(exitCode).toBe(ExitCode.Success);
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toEqual({ name: "alpha" });
  });

  it("returns not_found for a missing file", () => {
    const { env, exitCode } = buildViewResult(join(dir, "missing.json"));
    expect(exitCode).toBe(ExitCode.NotFound);
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.code).toBe("not_found");
    expect(env.error.type).toBe("not_found_error");
  });

  it("returns validation_error when a dotted path is missing", () => {
    const file = join(dir, "doc.json");
    writeFileSync(file, JSON.stringify({ data: { x: [] } }), "utf8");

    const { env, exitCode } = buildViewResult(file, { path: "data.missing" });
    expect(exitCode).toBe(ExitCode.InputValidation);
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.code).toBe("validation_error");
    expect(env.error.message).toContain('path "data.missing" not found');
  });

  it("summarizes large JSON with a narrow --path hint", () => {
    const file = join(dir, "large.json");
    const payload = {
      voices: Array.from({ length: 30 }, (_, index) => ({ index, value: "x".repeat(1200) })),
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThanOrEqual(32 * 1024);

    const { env, exitCode } = buildViewResult(file);
    expect(exitCode).toBe(ExitCode.Success);
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.data_summary).toMatchObject({ type: "object", count: 1, preview: ["voices"] });
    expect(env.truncated).toBe(true);
    expect(env.hints?.[0]?.cmd).toContain("elv view");
    expect(env.hints?.[0]?.cmd).toContain("--path 'voices'");
  });

  it("hints toward the first item (converging) when a path resolves to a large array", () => {
    const file = join(dir, "arr.json");
    const payload = {
      voices: Array.from({ length: 30 }, (_, index) => ({ index, value: "x".repeat(1200) })),
    };
    writeFileSync(file, JSON.stringify(payload), "utf8");

    const { env, exitCode } = buildViewResult(file, { path: "voices" });
    expect(exitCode).toBe(ExitCode.Success);
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.data_summary?.type).toBe("array");
    // The hint must drill into an element (which always shrinks), not loop on --limit.
    expect(env.hints?.[0]?.cmd).toContain("--path 'voices.0'");
    // The summary itself must stay small (size-bounded preview).
    expect(Buffer.byteLength(JSON.stringify(env.data_summary))).toBeLessThanOrEqual(8 * 1024);
  });

  it("parses NDJSON into an array", () => {
    const file = join(dir, "events.ndjson");
    writeFileSync(file, '{"id":1}\n\n{"id":2}\n', "utf8");

    const { env, exitCode } = buildViewResult(file);
    expect(exitCode).toBe(ExitCode.Success);
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
