import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { success, failure } from "../core/envelope";
import { getApiKey, loadConfig } from "../core/config";
import { emitAndExit, validationError } from "../core/errors";
import { ExitCode } from "../core/types";
import { resolveOutTarget, OutTargetError } from "../core/files";
import { buildCatalogUrl, getWsCatalogEntry, listWsCatalog, wsUrlFromPath } from "../ws/catalog";
import { parseSendScript, scriptUsesModel } from "../ws/events";
import { runWsSession } from "../ws/session";
import type { Command as CommanderCommand } from "commander";
import type { Envelope } from "../core/types";
import type { WsCatalogEntry } from "../ws/catalog";

export interface RunWsOptions {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
  timeoutMs?: number;
}

interface ParsedWsArgs {
  target?: string;
  list: boolean;
  query: Record<string, string>;
  send?: string;
  out?: string;
  baseUrl?: string;
  profile?: string;
}

export async function runWs(
  args: string[] = process.argv.slice(2),
  options: RunWsOptions = {},
): Promise<{ env: Envelope; exitCode: ExitCode }> {
  const parsed = parseArgs(args);
  if (!parsed.ok) return { env: validationError("elv ws", parsed.error), exitCode: ExitCode.InputValidation };

  const input = parsed.value;
  if (input.list) {
    return {
      env: success({ cmd: "elv ws --list", data: listWsCatalog() }),
      exitCode: ExitCode.Success,
    };
  }
  const target = input.target;
  if (!target) return inputError("Missing WS target");
  if (!input.send) return inputError("Missing --send script.ndjson");

  try {
    const config = loadConfig({ profile: options.profile ?? input.profile, baseUrl: options.baseUrl ?? input.baseUrl });
    const entry = getWsCatalogEntry(target);
    if (entry && !entry.scriptable) {
      return inputError(`${entry.name} is interactive and is not supported by the scripted ws player`);
    }
    const script = parseScriptFile(input.send);
    if (entry && rejectsElevenV3(entry, input.query, script)) {
      return inputError("eleven_v3 is not supported over ElevenLabs WebSocket TTS; use eleven_flash_v2_5");
    }

    const resolved = resolveTargetForInput(target, entry, input.query, config.baseUrl);
    if (!entry && rejectsRawElevenV3(resolved.url, script)) {
      return inputError("eleven_v3 is not supported over ElevenLabs WebSocket TTS; use eleven_flash_v2_5");
    }
    const outDir = resolveOutTarget(input.out ?? config.outputDir, true).dir;
    const apiKey = options.apiKey ?? getApiKey({ profile: options.profile ?? input.profile });
    const headers = authHeaders(apiKey);
    const result = await runWsSession({
      url: resolved.url,
      catalog: entry?.name ?? null,
      path: resolved.path,
      outDir,
      script,
      headers,
      timeoutMs: options.timeoutMs,
      outputFormat: resolved.url.searchParams.get("output_format") ?? input.query.output_format,
    });

    return {
      env: success({ cmd: "elv ws", ws: result.ws, files: result.files }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    return errorEnvelope(error);
  }
}

export async function handleWs(args: string[] = process.argv.slice(2)): Promise<never> {
  const result = await runWs(args);
  emitAndExit(result.env, result.exitCode);
}

export function buildWsCommand(): CommanderCommand {
  return new Command("ws")
    .argument("[target]", "WebSocket catalog name or URL")
    .option("--list", "list WebSocket catalog")
    .option("--query <key=value>", "add query parameter", collect, [])
    .option("--send <path>", "NDJSON send-script")
    .option("--out <dir>", "session output directory")
    .action((target: string | undefined, raw: Record<string, unknown>) => {
      const args = target ? [target] : [];
      if (raw.list) args.push("--list");
      for (const pair of arrayOption(raw.query)) args.push("--query", pair);
      if (typeof raw.send === "string") args.push("--send", raw.send);
      if (typeof raw.out === "string") args.push("--out", raw.out);
      return handleWs(args);
    });
}

function parseArgs(args: string[]): { ok: true; value: ParsedWsArgs } | { ok: false; error: string } {
  const parsed: ParsedWsArgs = { list: false, query: {} };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg === "--list") parsed.list = true;
    else if (arg === "--query") {
      const pair = args[index + 1];
      if (!pair) return { ok: false, error: "--query requires key=value" };
      const parsedPair = parsePair(pair);
      if (!parsedPair) return { ok: false, error: `Expected key=value, got "${pair}"` };
      parsed.query[parsedPair.key] = parsedPair.value;
      index += 1;
    } else if (arg === "--send") {
      const value = args[index + 1];
      if (!value) return { ok: false, error: "--send requires a path" };
      parsed.send = resolve(value);
      index += 1;
    } else if (arg === "--out") {
      const value = args[index + 1];
      if (!value) return { ok: false, error: "--out requires a directory" };
      parsed.out = value;
      index += 1;
    } else if (arg === "--base-url") {
      const value = args[index + 1];
      if (!value) return { ok: false, error: "--base-url requires a URL" };
      parsed.baseUrl = value;
      index += 1;
    } else if (arg === "--profile") {
      const value = args[index + 1];
      if (!value) return { ok: false, error: "--profile requires a name" };
      parsed.profile = value;
      index += 1;
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown option ${arg}` };
    else if (!parsed.target) parsed.target = arg;
    else return { ok: false, error: `Unexpected argument ${arg}` };
  }
  return { ok: true, value: parsed };
}

function resolveTarget(
  target: string,
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  baseUrl: string,
): { url: URL; path: string } {
  if (entry) return { url: buildCatalogUrl(entry, { baseUrl, query }), path: entry.pathTemplate };
  const url = target.startsWith("ws://") || target.startsWith("wss://")
    ? new URL(target)
    : target.startsWith("/")
      ? wsUrlFromPath(target, baseUrl)
      : undefined;
  if (!url) throw new Error(`Unknown WS catalog entry or raw path: ${target}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return { url, path: url.pathname };
}

function resolveTargetForInput(
  target: string,
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  baseUrl: string,
): { url: URL; path: string } {
  try {
    return resolveTarget(target, entry, query, baseUrl);
  } catch (error) {
    throw new ScriptValidationError(error instanceof Error ? error.message : String(error));
  }
}

function rejectsElevenV3(
  entry: WsCatalogEntry,
  query: Record<string, string>,
  script: ReturnType<typeof parseSendScript>,
): boolean {
  if (!entry.name.startsWith("tts-")) return false;
  return query.model_id?.toLowerCase() === "eleven_v3" || scriptUsesModel(script, "eleven_v3");
}

function rejectsRawElevenV3(
  url: URL,
  script: ReturnType<typeof parseSendScript>,
): boolean {
  return url.searchParams.get("model_id")?.toLowerCase() === "eleven_v3" || scriptUsesModel(script, "eleven_v3");
}

function authHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  if (!apiKey) return undefined;
  return { "xi-api-key": apiKey };
}

function parsePair(pair: string): { key: string; value: string } | null {
  const index = pair.indexOf("=");
  if (index <= 0) return null;
  return { key: pair.slice(0, index), value: pair.slice(index + 1) };
}

function inputError(message: string): { env: Envelope; exitCode: ExitCode } {
  return { env: validationError("elv ws", message), exitCode: ExitCode.InputValidation };
}

function parseScriptFile(path: string): ReturnType<typeof parseSendScript> {
  try {
    return parseSendScript(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ScriptValidationError(error instanceof Error ? error.message : String(error));
  }
}

function errorEnvelope(error: unknown): { env: Envelope; exitCode: ExitCode } {
  if (error instanceof ScriptValidationError) return inputError(error.message);
  if (error instanceof OutTargetError) {
    return {
      env: failure({
        cmd: "elv ws",
        error: {
          type: "validation_error",
          code: error.code,
          message: error.message,
          raw: { hint: error.hint },
        },
        retry: { recommended: false, after_ms: null },
        hints: [{ cmd: "elv ws --out <dir>", why: error.hint }],
      }),
      exitCode: ExitCode.InputValidation,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    env: failure({
      cmd: "elv ws",
      error: { type: "runtime_error", code: "internal_error", message },
      retry: { recommended: false, after_ms: null },
    }),
    exitCode: ExitCode.ProviderError,
  };
}

class ScriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptValidationError";
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function arrayOption(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
