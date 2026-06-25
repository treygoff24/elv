import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configDoctor, getApiKey, loadConfig } from "../src/core/config";

let cwd: string;
let home: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "elv-cwd-")));
  home = mkdtempSync(join(tmpdir(), "elv-home-"));
  process.chdir(cwd);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ELEVENLABS_API_KEY", undefined);
  vi.stubEnv("ELEVENLABS_TEST_API_KEY", undefined);
  vi.stubEnv("ELV_CONFIG", undefined);
  vi.stubEnv("ELV_PROFILE", undefined);
  vi.stubEnv("ELEVENLABS_BASE_URL", undefined);
  vi.stubEnv("ELV_OUTPUT_DIR", undefined);
  vi.stubEnv("ELV_CACHE_DIR", undefined);
  vi.stubEnv("ELV_MAX_CREDITS", undefined);
  vi.stubEnv("ELV_DEBUG", undefined);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("config", () => {
  it("resolves the active profile without exposing the raw API key", () => {
    mkdirSync(join(cwd, ".elv"));
    writeFileSync(
      join(cwd, ".elv", "config.json"),
      JSON.stringify({
        default_profile: "prod",
        profiles: {
          prod: {
            base_url: "https://api.example.test",
            api_key_env: "ELEVENLABS_TEST_API_KEY",
            output_dir: "./out",
            default_model_id: "eleven_v3",
            max_credits: 123,
          },
        },
      }),
    );
    vi.stubEnv("ELEVENLABS_TEST_API_KEY", "sk_should_not_leak");

    const config = loadConfig();

    expect(config).toMatchObject({
      baseUrl: "https://api.example.test",
      apiKeyPresent: true,
      outputDir: join(cwd, "out"),
      defaultModelId: "eleven_v3",
      maxCredits: 123,
      profile: "prod",
      cacheDir: join(home, ".cache", "elv"),
      debug: false,
    });
    expect(JSON.stringify(config)).not.toContain("sk_should_not_leak");
    expect(getApiKey()).toBe("sk_should_not_leak");
  });

  it("lets env override file values", () => {
    vi.stubEnv("ELEVENLABS_BASE_URL", "https://override.test");
    vi.stubEnv("ELV_OUTPUT_DIR", "custom-out");
    vi.stubEnv("ELV_MAX_CREDITS", "7");
    vi.stubEnv("ELV_DEBUG", "1");

    expect(loadConfig()).toMatchObject({
      baseUrl: "https://override.test",
      outputDir: join(cwd, "custom-out"),
      maxCredits: 7,
      debug: true,
    });
  });

  it("returns doctor checks and fails only hard local failures", async () => {
    const result = await configDoctor({ network: false });

    expect(result.exitCode).toBe(8);
    expect(result.env).toMatchObject({ ok: false, data: { checks: expect.any(Array) } });
    expect(
      result.checks.some((check) => check.name === "api_key_present" && check.status === "fail"),
    ).toBe(true);
    expect(
      result.checks.some((check) => check.name === "registry_cache" && check.status === "warn"),
    ).toBe(true);
  });
});
