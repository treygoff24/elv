import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/core/config";

let cwd: string;
let home: string;
let xdg: string;
let originalCwd: string;

function writeConfig(path: string, config: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config));
}

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "elv-xdg-cwd-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "elv-xdg-home-")));
  xdg = realpathSync(mkdtempSync(join(tmpdir(), "elv-xdg-base-")));
  process.chdir(cwd);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ELEVENLABS_API_KEY", undefined);
  vi.stubEnv("ELV_CONFIG", undefined);
  vi.stubEnv("ELV_PROFILE", undefined);
  vi.stubEnv("ELEVENLABS_BASE_URL", undefined);
  vi.stubEnv("ELEVENLABS_API_RESIDENCY", undefined);
  vi.stubEnv("ELV_OUTPUT_DIR", undefined);
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
  rmSync(xdg, { recursive: true, force: true });
});

describe("config directory lookup", () => {
  it("reads the XDG user config when XDG_CONFIG_HOME is absolute", () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(xdg, "config"));
    writeConfig(join(xdg, "config", "elv", "config.json"), {
      profiles: { default: { max_credits: 42 } },
    });
    writeConfig(join(home, ".config", "elv", "config.json"), {
      profiles: { default: { max_credits: 7 } },
    });

    expect(loadConfig().maxCredits).toBe(42);
  });

  it("falls back to a preexisting ~/.config/elv config when the XDG target is absent", () => {
    vi.stubEnv("XDG_CONFIG_HOME", join(xdg, "config"));
    writeConfig(join(home, ".config", "elv", "config.json"), {
      profiles: { default: { max_credits: 7 } },
    });

    expect(loadConfig().maxCredits).toBe(7);
  });

  it("keeps the cwd project config ahead of the user config", () => {
    writeConfig(join(cwd, ".elv", "config.json"), { profiles: { default: { max_credits: 1 } } });
    writeConfig(join(home, ".config", "elv", "config.json"), {
      profiles: { default: { max_credits: 7 } },
    });

    expect(loadConfig().maxCredits).toBe(1);
  });
});

describe("cache and output directories", () => {
  it("defaults generated output to the data directory, not the cache directory", () => {
    const config = loadConfig();

    expect(config.cacheDir).toBe(join(home, ".cache", "elv"));
    expect(config.outputDir).toBe(join(home, ".local", "share", "elv", "out"));
  });

  it("follows absolute XDG base directories for cache and output", () => {
    vi.stubEnv("XDG_CACHE_HOME", join(xdg, "cache"));
    vi.stubEnv("XDG_DATA_HOME", join(xdg, "data"));

    const config = loadConfig();

    expect(config.cacheDir).toBe(join(xdg, "cache", "elv"));
    expect(config.outputDir).toBe(join(xdg, "data", "elv", "out"));
  });

  it("keeps ELV_CACHE_DIR and output overrides in charge", () => {
    vi.stubEnv("XDG_CACHE_HOME", join(xdg, "cache"));
    vi.stubEnv("XDG_DATA_HOME", join(xdg, "data"));
    vi.stubEnv("ELV_CACHE_DIR", join(xdg, "explicit-cache"));
    vi.stubEnv("ELV_OUTPUT_DIR", "custom-out");

    const config = loadConfig();

    expect(config.cacheDir).toBe(join(xdg, "explicit-cache"));
    expect(config.outputDir).toBe(join(cwd, "custom-out"));
  });

  it("still honors a profile output_dir from a trusted config", () => {
    vi.stubEnv("ELV_CONFIG", join(home, "explicit.json"));
    writeConfig(join(home, "explicit.json"), {
      profiles: { default: { output_dir: "/var/tmp/elv-profile-out" } },
    });

    expect(loadConfig().outputDir).toBe("/var/tmp/elv-profile-out");
  });
});
