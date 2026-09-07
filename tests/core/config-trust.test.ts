import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runOperation } from "../../src/core/client";
import { ConfigFileError, getApiKey, loadConfig } from "../../src/core/config";

const SYNTHETIC_KEY = "sk_synthetic_not_a_real_key_CANARY";

let cwd: string;
let home: string;
let originalCwd: string;

function writeProjectConfig(config: unknown): string {
  const dir = join(cwd, ".elv");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function writeUserConfig(config: unknown): string {
  const dir = join(home, ".config", "elv");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function writeExplicitConfig(config: unknown): string {
  const path = join(home, "explicit-config.json");
  writeFileSync(path, JSON.stringify(config));
  return path;
}

function captureThrow(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** Records every attempted request instead of performing it. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ voices: [] }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

beforeEach(() => {
  originalCwd = process.cwd();
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "elv-trust-cwd-")));
  home = realpathSync(mkdtempSync(join(tmpdir(), "elv-trust-home-")));
  process.chdir(cwd);
  vi.stubEnv("HOME", home);
  vi.stubEnv("ELEVENLABS_API_KEY", undefined);
  vi.stubEnv("ELEVENLABS_TEST_API_KEY", undefined);
  vi.stubEnv("ELV_CONFIG", undefined);
  vi.stubEnv("ELV_PROFILE", undefined);
  vi.stubEnv("ELEVENLABS_BASE_URL", undefined);
  vi.stubEnv("ELEVENLABS_API_RESIDENCY", undefined);
  vi.stubEnv("ELV_OUTPUT_DIR", undefined);
  vi.stubEnv("ELV_CACHE_DIR", undefined);
  vi.stubEnv("ELV_MAX_CREDITS", undefined);
  vi.stubEnv("ELV_DEBUG", undefined);
  vi.stubEnv("XDG_CACHE_HOME", undefined);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
  vi.stubEnv("XDG_DATA_HOME", undefined);
});

afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("implicit project config trust", () => {
  it("refuses a cwd config that redirects the credentialed endpoint", () => {
    const path = writeProjectConfig({
      profiles: { default: { base_url: "http://127.0.0.1:8899" } },
    });

    const error = captureThrow(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigFileError);
    expect((error as ConfigFileError).path).toBe(path);
    expect((error as ConfigFileError).message).toContain("profiles.default.base_url");
    expect((error as ConfigFileError).message).toContain("ELV_CONFIG");
    expect((error as ConfigFileError).message).toContain("--base-url");
  });

  it("refuses a cwd config that selects the API key environment variable", () => {
    writeProjectConfig({
      profiles: { default: { api_key_env: "ELEVENLABS_TEST_API_KEY" } },
    });
    vi.stubEnv("ELEVENLABS_TEST_API_KEY", SYNTHETIC_KEY);

    expect(() => loadConfig()).toThrow(/api_key_env/);
    expect(() => getApiKey()).toThrow(ConfigFileError);
  });

  it("refuses privileged fields in a profile the current invocation does not select", () => {
    writeProjectConfig({
      default_profile: "safe",
      profiles: {
        safe: { max_credits: 5 },
        staging: { base_url: "http://127.0.0.1:8899" },
      },
    });

    expect(() => loadConfig()).toThrow(/profiles\.staging\.base_url/);
  });

  it("scans the whole document, not just the profiles it understands today", () => {
    writeProjectConfig({ future: [{ endpoints: { base_url: "http://127.0.0.1:8899" } }] });

    expect(() => loadConfig()).toThrow(/future\.0\.endpoints\.base_url/);
  });

  it("never names a credential value in the refusal", () => {
    writeProjectConfig({
      profiles: { default: { api_key_env: "ELEVENLABS_TEST_API_KEY" } },
    });
    vi.stubEnv("ELEVENLABS_TEST_API_KEY", SYNTHETIC_KEY);

    const error = captureThrow(() => loadConfig());

    expect(error).toBeInstanceOf(ConfigFileError);
    expect((error as Error).message).not.toContain(SYNTHETIC_KEY);
    expect((error as Error).message).toContain("profiles.default.api_key_env");
  });

  it("keeps ordinary workflow settings working from a cwd config", () => {
    writeProjectConfig({
      default_profile: "project",
      profiles: {
        project: { output_dir: "./out", default_model_id: "eleven_v3", max_credits: 123 },
      },
    });

    expect(loadConfig()).toMatchObject({
      baseUrl: "https://api.elevenlabs.io",
      outputDir: join(cwd, "out"),
      defaultTtsModelId: "eleven_v3",
      maxCredits: 123,
      profile: "project",
    });
  });

  it("does not let a cwd config reach a trusted user profile's key env indirectly", () => {
    writeUserConfig({
      profiles: { privileged: { api_key_env: "ELEVENLABS_TEST_API_KEY" } },
    });
    writeProjectConfig({ default_profile: "privileged", profiles: { privileged: {} } });
    vi.stubEnv("ELEVENLABS_TEST_API_KEY", SYNTHETIC_KEY);

    const config = loadConfig();

    expect(config.profile).toBe("privileged");
    expect(config.apiKeyPresent).toBe(false);
    expect(getApiKey()).toBeUndefined();
  });
});

describe("explicit trust", () => {
  it("allows a custom endpoint and key env from ELV_CONFIG", () => {
    const path = writeExplicitConfig({
      profiles: {
        default: { base_url: "http://127.0.0.1:8899", api_key_env: "ELEVENLABS_TEST_API_KEY" },
      },
    });
    vi.stubEnv("ELV_CONFIG", path);
    vi.stubEnv("ELEVENLABS_TEST_API_KEY", SYNTHETIC_KEY);

    const config = loadConfig();

    expect(config.baseUrl).toBe("http://127.0.0.1:8899");
    expect(config.apiKeyPresent).toBe(true);
    expect(getApiKey()).toBe(SYNTHETIC_KEY);
  });

  it("allows a custom endpoint from the user config", () => {
    writeUserConfig({ profiles: { default: { base_url: "https://api.example.test" } } });

    expect(loadConfig().baseUrl).toBe("https://api.example.test");
  });

  it("keeps an explicit --base-url override working over a cwd config", () => {
    writeProjectConfig({ profiles: { default: { max_credits: 5 } } });

    expect(loadConfig({ baseUrl: "http://127.0.0.1:8899" }).baseUrl).toBe("http://127.0.0.1:8899");
  });
});

describe("explicit ELV_CONFIG failures never fall back silently", () => {
  it("fails when ELV_CONFIG names a file that does not exist", () => {
    writeProjectConfig({ profiles: { default: { max_credits: 5 } } });
    writeUserConfig({ profiles: { default: { max_credits: 9 } } });
    const missing = join(home, "absent.json");
    vi.stubEnv("ELV_CONFIG", missing);

    expect(() => loadConfig()).toThrow(ConfigFileError);
    expect(() => loadConfig()).toThrow(new RegExp(missing.replaceAll(/[.]/g, "\\.")));
  });

  it("fails when ELV_CONFIG names an unparsable file", () => {
    const path = join(home, "broken.json");
    writeFileSync(path, "{not json");
    vi.stubEnv("ELV_CONFIG", path);

    expect(() => loadConfig()).toThrow(ConfigFileError);
  });
});

describe("credential redirect refusal end to end", () => {
  it("does not send the API key to a localhost endpoint chosen by an untrusted cwd config", async () => {
    writeProjectConfig({
      profiles: {
        default: { base_url: "http://127.0.0.1:8899", api_key_env: "ELEVENLABS_API_KEY" },
      },
    });
    vi.stubEnv("ELEVENLABS_API_KEY", SYNTHETIC_KEY);
    const fetchSpy = stubFetch();

    const env = await runOperation("get_voices", {}, { cmd: "elv voices list" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected an error envelope");
    expect(env.error.type).toBe("config_error");
    expect(env.error.message).toContain("base_url");
    expect(JSON.stringify(env)).not.toContain(SYNTHETIC_KEY);
  });

  it("still calls a custom endpoint that the user trusted explicitly", async () => {
    const path = writeExplicitConfig({
      profiles: {
        default: { base_url: "http://127.0.0.1:8899", api_key_env: "ELEVENLABS_API_KEY" },
      },
    });
    vi.stubEnv("ELV_CONFIG", path);
    vi.stubEnv("ELEVENLABS_API_KEY", SYNTHETIC_KEY);
    const fetchSpy = stubFetch();

    const env = await runOperation("get_voices", {}, { cmd: "elv voices list" });

    expect(env.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(String(url).startsWith("http://127.0.0.1:8899/")).toBe(true);
    expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(SYNTHETIC_KEY);
  });
});
