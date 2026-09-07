import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultCacheDir, defaultConfigDir, defaultDataDir } from "../../src/util/paths";

let cwd: string;
let home: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "elv-paths-cwd-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "elv-paths-home-")));
  process.chdir(cwd);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ELV_CACHE_DIR", undefined);
  vi.stubEnv("XDG_CACHE_HOME", undefined);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  vi.stubEnv("XDG_DATA_HOME", undefined);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("default Linux paths", () => {
  it("falls back to HOME defaults when no override is set", () => {
    expect(defaultCacheDir()).toBe(join(home, ".cache", "elv"));
    expect(defaultConfigDir()).toBe(join(home, ".config", "elv"));
    expect(defaultDataDir()).toBe(join(home, ".local", "share", "elv"));
  });

  it("honors absolute XDG base directories", () => {
    vi.stubEnv("XDG_CACHE_HOME", "/xdg/cache");
    vi.stubEnv("XDG_CONFIG_HOME", "/xdg/config");
    vi.stubEnv("XDG_DATA_HOME", "/xdg/data");

    expect(defaultCacheDir()).toBe(join("/xdg/cache", "elv"));
    expect(defaultConfigDir()).toBe(join("/xdg/config", "elv"));
    expect(defaultDataDir()).toBe(join("/xdg/data", "elv"));
  });

  it("ignores relative or empty XDG values instead of resolving them against cwd", () => {
    vi.stubEnv("XDG_CACHE_HOME", "relative/cache");
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("XDG_DATA_HOME", "./data");

    expect(defaultCacheDir()).toBe(join(home, ".cache", "elv"));
    expect(defaultConfigDir()).toBe(join(home, ".config", "elv"));
    expect(defaultDataDir()).toBe(join(home, ".local", "share", "elv"));
    for (const dir of [defaultCacheDir(), defaultConfigDir(), defaultDataDir()]) {
      expect(dir.startsWith(cwd)).toBe(false);
    }
  });

  it("gives ELV_CACHE_DIR precedence over XDG_CACHE_HOME and resolves relative values", () => {
    vi.stubEnv("XDG_CACHE_HOME", "/xdg/cache");

    vi.stubEnv("ELV_CACHE_DIR", "/explicit/cache");
    expect(defaultCacheDir()).toBe("/explicit/cache");

    vi.stubEnv("ELV_CACHE_DIR", "local-cache");
    expect(defaultCacheDir()).toBe(join(cwd, "local-cache"));

    vi.stubEnv("ELV_CACHE_DIR", "");
    expect(defaultCacheDir()).toBe(join("/xdg/cache", "elv"));
  });
});
