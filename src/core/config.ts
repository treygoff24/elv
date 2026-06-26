import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { success, failure } from "./envelope";
import { ExitCode } from "./types";
import type { Envelope } from "./types";

interface ProfileConfig {
  base_url?: string;
  api_key_env?: string;
  output_dir?: string;
  default_model_id?: string;
  max_credits?: number;
}

interface FileConfig {
  default_profile?: string;
  profiles?: Record<string, ProfileConfig>;
}

export interface ResolvedConfig {
  baseUrl: string;
  apiKeyPresent: boolean;
  outputDir: string;
  defaultModelId?: string;
  maxCredits?: number;
  profile: string;
  residency?: string;
  cacheDir: string;
  specUrl: string;
  debug: boolean;
}

export interface ConfigOverrides {
  profile?: string;
  baseUrl?: string;
  maxCredits?: number;
  debug?: boolean;
}

interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

export interface DoctorResult {
  env: Envelope & { data?: unknown };
  exitCode: ExitCode;
  checks: DoctorCheck[];
}

interface DoctorOptions extends ConfigOverrides {
  network?: boolean;
}

export class ConfigFileError extends Error {
  constructor(
    public readonly path: string,
    cause: unknown,
  ) {
    super(`Invalid JSON in config file ${path}: ${errorMessage(cause)}`);
    this.name = "ConfigFileError";
  }
}

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";
const DEFAULT_SPEC_URL = "https://api.elevenlabs.io/openapi.json";

export function loadConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const file = readConfigFile();
  const profile = overrides.profile ?? process.env.ELV_PROFILE ?? file.default_profile ?? "default";
  const activeProfile = file.profiles?.[profile] ?? {};
  const residency = process.env.ELEVENLABS_API_RESIDENCY;
  const apiKeyEnv = activeProfile.api_key_env ?? "ELEVENLABS_API_KEY";
  const maxCredits =
    overrides.maxCredits ?? numberFromEnv("ELV_MAX_CREDITS") ?? activeProfile.max_credits;
  const cacheDir = absolutePath(process.env.ELV_CACHE_DIR ?? join(homedir(), ".cache", "elv"));
  const outputOverride = process.env.ELV_OUTPUT_DIR || activeProfile.output_dir;
  const outputDir = outputOverride ? absolutePath(outputOverride) : join(cacheDir, "out");

  return {
    baseUrl:
      overrides.baseUrl ??
      process.env.ELEVENLABS_BASE_URL ??
      baseUrlFromResidency(residency) ??
      activeProfile.base_url ??
      DEFAULT_BASE_URL,
    apiKeyPresent: Boolean(process.env[apiKeyEnv]),
    outputDir,
    defaultModelId: activeProfile.default_model_id,
    maxCredits,
    profile,
    residency,
    cacheDir,
    specUrl: process.env.ELV_SPEC_URL ?? DEFAULT_SPEC_URL,
    debug: overrides.debug ?? boolFromEnv("ELV_DEBUG"),
  };
}

export function getApiKey(overrides: ConfigOverrides = {}): string | undefined {
  const file = readConfigFile();
  const profile = overrides.profile ?? process.env.ELV_PROFILE ?? file.default_profile ?? "default";
  const apiKeyEnv = file.profiles?.[profile]?.api_key_env ?? "ELEVENLABS_API_KEY";
  return process.env[apiKeyEnv];
}

export async function configDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const config = loadConfig(options);
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "api_key_present",
    status: config.apiKeyPresent ? "pass" : "fail",
    detail: config.apiKeyPresent
      ? "API key env var is set"
      : "No API key found for the active profile",
  });
  checks.push({
    name: "base_url_set",
    status: config.baseUrl ? "pass" : "fail",
    detail: config.baseUrl || "Base URL is empty",
  });
  checks.push(registryCheck(config.cacheDir));
  checks.push(outputDirCheck(config.outputDir));
  checks.push(nodeVersionCheck());

  if (options.network === false) {
    checks.push({ name: "base_url_reachable", status: "skip", detail: "Network checks disabled" });
    checks.push({ name: "credit_balance", status: "skip", detail: "Network checks disabled" });
  } else {
    checks.push(await baseUrlReachableCheck(config.baseUrl));
    checks.push(await creditBalanceCheck(config));
  }

  const failed = checks.some((check) => check.status === "fail");
  const data = { checks };
  const env = failed
    ? Object.assign(
        failure({
          cmd: "elv config doctor",
          error: {
            type: "config_error",
            code: "config_doctor_failed",
            message: "One or more config checks failed",
            raw: data,
          },
          retry: { recommended: false, after_ms: null },
        }),
        { data },
      )
    : success({ cmd: "elv config doctor", data });

  return { env, exitCode: failed ? ExitCode.ProviderError : ExitCode.Success, checks };
}

function readConfigFile(): FileConfig {
  const path = findConfigPath();
  if (!path) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigFileError(path, error);
  }
  if (!parsed || typeof parsed !== "object") return {};
  return parsed as FileConfig;
}

function findConfigPath(): string | undefined {
  const envPath = process.env.ELV_CONFIG;
  const candidates = [
    envPath,
    join(process.cwd(), ".elv", "config.json"),
    join(homedir(), ".config", "elv", "config.json"),
  ];
  return candidates.find((candidate): candidate is string =>
    Boolean(candidate && existsSync(candidate)),
  );
}

function absolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function boolFromEnv(name: string): boolean {
  const raw = process.env[name];
  return Boolean(raw && raw !== "0" && raw.toLowerCase() !== "false");
}

function baseUrlFromResidency(residency: string | undefined): string | undefined {
  if (!residency) return undefined;
  const normalized = residency.toLowerCase();
  if (normalized === "us") return "https://api.us.elevenlabs.io";
  if (["eu", "in", "sg"].includes(normalized))
    return `https://api.${normalized}.residency.elevenlabs.io`;
  return undefined;
}

function registryCheck(cacheDir: string): DoctorCheck {
  const direct = join(cacheDir, "openapi.compact.json");
  const nested = existsSync(cacheDir)
    ? readdirSync(cacheDir, { withFileTypes: true }).some((entry) => {
        if (!entry.isDirectory()) return false;
        return existsSync(join(cacheDir, entry.name, "openapi.compact.json"));
      })
    : false;
  if (existsSync(direct) || nested) {
    return { name: "registry_cache", status: "pass", detail: "Registry cache exists" };
  }
  return {
    name: "registry_cache",
    status: "warn",
    detail: "Registry not yet compiled; run `elv spec update --offline` to build it",
  };
}

function outputDirCheck(outputDir: string): DoctorCheck {
  try {
    mkdirSync(outputDir, { recursive: true });
    const testFile = join(outputDir, `.elv-doctor-${process.pid}.tmp`);
    writeFileSync(testFile, "ok");
    rmSync(testFile, { force: true });
    return { name: "output_dir_writable", status: "pass", detail: outputDir };
  } catch (error) {
    return { name: "output_dir_writable", status: "fail", detail: errorMessage(error) };
  }
}

function nodeVersionCheck(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  return major >= 22
    ? { name: "node_version", status: "pass", detail: process.versions.node }
    : { name: "node_version", status: "fail", detail: `Node ${process.versions.node}; need >=22` };
}

async function baseUrlReachableCheck(baseUrl: string): Promise<DoctorCheck> {
  try {
    const response = await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return response.status < 500
      ? {
          name: "base_url_reachable",
          status: "pass",
          detail: `${baseUrl} returned ${response.status}`,
        }
      : {
          name: "base_url_reachable",
          status: "skip",
          detail: `${baseUrl} returned ${response.status}`,
        };
  } catch (error) {
    return { name: "base_url_reachable", status: "skip", detail: errorMessage(error) };
  }
}

async function creditBalanceCheck(config: ResolvedConfig): Promise<DoctorCheck> {
  const apiKey = getApiKey({ profile: config.profile });
  if (!apiKey) return { name: "credit_balance", status: "skip", detail: "No API key" };

  try {
    const response = await fetch(new URL("/v1/user/subscription", config.baseUrl), {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok)
      return {
        name: "credit_balance",
        status: "skip",
        detail: `Subscription check returned ${response.status}`,
      };
    const body = asRecord(await response.json());
    return {
      name: "credit_balance",
      status: "pass",
      detail: `character_count=${String(body.character_count ?? "unknown")}; character_limit=${String(body.character_limit ?? "unknown")}`,
    };
  } catch (error) {
    return { name: "credit_balance", status: "skip", detail: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
