import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("multi-file output preflight", () => {
  it.each(["compose_detailed", "compose_detailed_stream"])(
    "validates output shape before spending or returning a dry-run for %s",
    async (operationId) => {
      const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
      vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
      vi.stubEnv("ELV_MAX_CREDITS", undefined);
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      try {
        for (const dryRun of [true, false]) {
          const result = await runOperation(
            operationId,
            { body: { prompt: "Quiet instrumental" } },
            { dryRun, out: join(dir, "audio.mp3") },
          );
          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("Expected invalid output target");
          expect(result.error.message).toContain("--out file");
          expect(fetch).not.toHaveBeenCalled();
        }
        const valid = await runOperation(
          operationId,
          { body: { prompt: "Quiet instrumental" } },
          { dryRun: true, out: join(dir, "output") },
        );
        expect(valid.ok).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
        expect(existsSync(join(dir, "output"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("single-file output preflight", () => {
  it("rejects an unpublishable --save-json target before dry-run or network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
    const blocked = join(dir, "not-a-directory");
    const target = join(blocked, "response.json");
    writeFileSync(blocked, "occupied");
    vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
    vi.stubEnv("ELV_MAX_CREDITS", undefined);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      for (const dryRun of [true, false]) {
        const result = await runOperation("get_models", {}, { dryRun, saveJson: target });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected invalid output target");
        expect(result.error).toMatchObject({
          type: "validation_error",
          code: "invalid_out_target",
        });
        expect(result.retry).toEqual({ recommended: false, after_ms: null });
        expect(result.hints?.[0]).toMatchObject({
          cmd: expect.stringContaining("--save-json ./output.json"),
        });
      }
      expect(fetch).not.toHaveBeenCalled();
      expect(readdirSync(dir).some((name) => name.includes("elv-output-probe"))).toBe(false);

      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "call", "get_models", "--save-json", target, "--dry-run"],
        {
          encoding: "utf8",
          env: { ...process.env, ELV_CACHE_DIR: join(dir, "cli-cache") },
        },
      );
      expect(cli.status).toBe(2);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        ok: false,
        error: { type: "validation_error", code: "invalid_out_target" },
        retry: { recommended: false },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an existing directory for --save-json because the spill derives a filename", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
    const target = join(dir, "reports");
    mkdirSync(target);
    vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
    try {
      const result = await runOperation("get_models", {}, { dryRun: true, saveJson: target });
      expect(result).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights the default output directory for a file-producing operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "occupied");
    vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
    vi.stubEnv("ELV_OUTPUT_DIR", join(blocked, "output"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await runOperation(
        "text_to_speech_full",
        { path: { voice_id: "voice_1" }, body: { text: "hello" } },
        { dryRun: true },
      );
      expect(result).toMatchObject({
        ok: false,
        error: { type: "validation_error", code: "invalid_out_target" },
      });
      if (result.ok) throw new Error("Expected invalid output target");
      expect(result.hints?.[0]).toEqual({
        cmd: "elv config get",
        why: "Show the output_dir / ELV_OUTPUT_DIR that failed the writability check.",
      });
      expect(result.hints?.[1]?.cmd).toBe(
        `elv call text_to_speech_full --json '${JSON.stringify({
          path: { voice_id: "voice_1" },
          body: { text: "hello" },
        })}' --out ./output --dry-run`,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not preflight the default output directory for a non-spending JSON read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "occupied");
    vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
    vi.stubEnv("ELV_OUTPUT_DIR", join(blocked, "output"));
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const result = await runOperation("get_models", {}, { dryRun: true });
      expect(result.ok).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not create nested --out directories before an exit 4 rejection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elv-output-preflight-"));
    const target = join(dir, "new", "nested", "response.json");
    vi.stubEnv("ELV_CACHE_DIR", join(dir, "cache"));
    try {
      const result = await runOperation(
        "delete_voice",
        { path: { voice_id: "voice_1" } },
        { out: target },
      );
      expect(result).toMatchObject({ ok: false, error: { code: "confirmation" } });
      expect(existsSync(join(dir, "new"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
