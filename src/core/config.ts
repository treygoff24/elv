import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { success, failure } from "./envelope";
import { ExitCode } from "./types";
import { errorMessage } from "../util/error";
import { isRecord, parseJson } from "../util/json";
import {
  absolutePath,
  defaultCacheDir,
  defaultConfigDir,
  defaultDataDir,
  legacyConfigDir,
} from "../util/paths";
import type { CommandResult } from "./types";
import type { JsonValue } from "../util/json";

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

interface ResolvedConfig {
  baseUrl: string;
  apiKeyPresent: boolean;
  outputDir: string;
  defaultTtsModelId?: string;
  maxCredits?: number;
  profile: string;
  residency?: string;
  cacheDir: string;
  specUrl: string;
  debug: boolean;
}

export type ConfigOverrides = Partial<
  Pick<ResolvedConfig, "profile" | "baseUrl" | "maxCredits" | "debug">
>;

interface DoctorCheck {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

interface DoctorResult extends CommandResult {
  checks: DoctorCheck[];
}

interface DoctorOptions extends ConfigOverrides {
  network?: boolean;
}

export class ConfigFileError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigFileError";
  }
}

const HTTPS_SCHEME = "https:";
const DEFAULT_API_HOST = "api.elevenlabs.io";
const RESIDENCY_API_HOSTS: Record<string, string> = {
  us: "api.us.elevenlabs.io",
  eu: "api.eu.residency.elevenlabs.io",
  in: "api.in.residency.elevenlabs.io",
  sg: "api.sg.residency.elevenlabs.io",
};
const DEFAULT_BASE_URL = httpsUrl(DEFAULT_API_HOST);
const DEFAULT_SPEC_URL = httpsUrl(DEFAULT_API_HOST, "/openapi.json");

export function loadConfig(overrides: ConfigOverrides = {}): ResolvedConfig {
  const file = readConfigFile();
  const profile = resolveProfileName(file, overrides);
  const activeProfile = resolveProfileConfig(file, profile);
  const residency = process.env.ELEVENLABS_API_RESIDENCY;
  const apiKeyEnv = apiKeyEnvForProfile(activeProfile);
  const cacheDir = configuredCacheDir();

  return {
    baseUrl: configuredBaseUrl(activeProfile, residency, overrides),
    apiKeyPresent: Boolean(process.env[apiKeyEnv]),
    outputDir: configuredOutputDir(activeProfile),
    defaultTtsModelId: activeProfile.default_model_id,
    maxCredits: configuredMaxCredits(activeProfile, overrides),
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

function resolveProfileName(file: FileConfig, overrides: ConfigOverrides): string {
  return overrides.profile ?? process.env.ELV_PROFILE ?? file.default_profile ?? "default";
}

function resolveProfileConfig(file: FileConfig, profile: string): ProfileConfig {
  return file.profiles?.[profile] ?? {};
}

function apiKeyEnvForProfile(profile: ProfileConfig): string {
  return profile.api_key_env ?? "ELEVENLABS_API_KEY";
}

function configuredMaxCredits(
  profile: ProfileConfig,
  overrides: ConfigOverrides,
): number | undefined {
  return overrides.maxCredits ?? numberFromEnv("ELV_MAX_CREDITS") ?? profile.max_credits;
}

function configuredCacheDir(): string {
  return defaultCacheDir();
}

function configuredOutputDir(profile: ProfileConfig): string {
  const outputOverride = process.env.ELV_OUTPUT_DIR || profile.output_dir;
  return outputOverride ? absolutePath(outputOverride) : join(defaultDataDir(), "out");
}

function configuredBaseUrl(
  profile: ProfileConfig,
  residency: string | undefined,
  overrides: ConfigOverrides,
): string {
  return (
    overrides.baseUrl ??
    process.env.ELEVENLABS_BASE_URL ??
    baseUrlFromResidency(residency) ??
    profile.base_url ??
    DEFAULT_BASE_URL
  );
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

  if (options.network !== true) {
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
  const source = findConfigSource();
  if (!source) return {};
  let parsed: JsonValue;
  try {
    parsed = parseJson(readFileSync(source.path, "utf8"), source.path);
  } catch (error) {
    throw new ConfigFileError(
      source.path,
      `Invalid JSON in config file ${source.path}: ${errorMessage(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") return {};
  if (!source.trusted) rejectPrivilegedFields(source.path, parsed);
  return parsed as FileConfig;
}

interface ConfigSource {
  path: string;
  /**
   * True when the user pointed at this file (ELV_CONFIG) or it lives in their
   * own config directory. A `.elv/config.json` discovered in the current
   * directory is whatever checkout the agent happens to be standing in, so it
   * is untrusted.
   */
  trusted: boolean;
}

function findConfigSource(): ConfigSource | undefined {
  const envPath = process.env.ELV_CONFIG;
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new ConfigFileError(
        envPath,
        `ELV_CONFIG points at ${envPath}, which does not exist. Create that file or unset ELV_CONFIG; elv will not silently fall back to another config.`,
      );
    }
    return { path: envPath, trusted: true };
  }
  const projectPath = join(process.cwd(), ".elv", "config.json");
  if (existsSync(projectPath)) return { path: projectPath, trusted: false };
  const userPath = userConfigPaths().find((candidate) => existsSync(candidate));
  return userPath ? { path: userPath, trusted: true } : undefined;
}

/** XDG location first, then a preexisting pre-XDG file so upgrades keep working. */
function userConfigPaths(): string[] {
  const paths = [join(defaultConfigDir(), "config.json"), join(legacyConfigDir(), "config.json")];
  return [...new Set(paths)];
}

/**
 * Fields that choose where credentials are sent or which credential is used.
 * An untrusted project config may set ordinary workflow options, but selecting
 * an endpoint or a key environment variable needs the user's own say-so.
 */
const PRIVILEGED_CONFIG_FIELDS = new Set(["base_url", "api_key_env"]);

function rejectPrivilegedFields(path: string, parsed: JsonValue): void {
  const found = privilegedFieldPaths(parsed, []);
  if (found.length === 0) return;
  throw new ConfigFileError(
    path,
    `Untrusted project config ${path} sets ${found.join(", ")}. Those fields choose the endpoint that receives your API key and which environment variable holds it, so elv honors them only from a trusted config. Move them to ${join(defaultConfigDir(), "config.json")}, run with ELV_CONFIG=${path} to trust this file, or pass --base-url on the command line.`,
  );
}

/** Scans the whole document, so a later schema cannot reopen this quietly. */
function privilegedFieldPaths(value: JsonValue, trail: string[]): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => privilegedFieldPaths(item, [...trail, String(index)]));
  }
  if (!isRecord(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const here = [...trail, key];
    if (PRIVILEGED_CONFIG_FIELDS.has(key)) found.push(here.join("."));
    else found.push(...privilegedFieldPaths(child, here));
  }
  return found;
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
  const host = RESIDENCY_API_HOSTS[residency.toLowerCase()];
  return host ? httpsUrl(host) : undefined;
}

function httpsUrl(host: string, path = ""): string {
  return `${HTTPS_SCHEME}//${host}${path}`;
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
  const major = Number(process.versions.node.split(".")[0]!);
  return major >= 22
    ? { name: "node_version", status: "pass", detail: process.versions.node }
    : { name: "node_version", status: "fail", detail: `Node ${process.versions.node}; need >=22` };
}

async function baseUrlReachableCheck(baseUrl: string): Promise<DoctorCheck> {
  try {
    const response = await fetch(baseUrl, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    });
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
      redirect: "error",
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

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
