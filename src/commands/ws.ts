import { readFileSync } from "node:fs";
import { success, failure } from "../core/envelope";
import { ConfigFileError, getApiKey, loadConfig } from "../core/config";
import { configFileError, validationError } from "../core/errors";
import { ExitCode } from "../core/types";
import { resolveOutTarget, OutTargetError } from "../core/files";
import { buildCatalogUrl, getWsCatalogEntry, listWsCatalog, wsUrlFromPath } from "../ws/catalog";
import { parseSendScript, scriptUsesModel } from "../ws/events";
import { runWsSession } from "../ws/session";
import type { Envelope } from "../core/types";
import type { WsCatalogEntry } from "../ws/catalog";

export interface RunWsOptions {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
  timeoutMs?: number;
}

export interface WsCommandInput {
  target?: string;
  list?: boolean;
  query: Record<string, string>;
  send?: string;
  out?: string;
}

export async function runWs(
  input: WsCommandInput,
  options: RunWsOptions = {},
): Promise<{ env: Envelope; exitCode: ExitCode }> {
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
    const config = loadConfig({
      profile: options.profile,
      baseUrl: options.baseUrl,
    });
    const entry = getWsCatalogEntry(target);
    if (entry && !entry.scriptable) {
      return inputError(
        `${entry.name} is interactive and is not supported by the scripted ws player`,
      );
    }
    const script = parseScriptFile(input.send);
    if (entry && rejectsElevenV3(entry, input.query, script)) {
      return inputError(
        "eleven_v3 is not supported over ElevenLabs WebSocket TTS; use eleven_flash_v2_5",
      );
    }

    const resolved = resolveTargetForInput(target, entry, input.query, config.baseUrl);
    if (!entry && rejectsRawElevenV3(resolved.url, script)) {
      return inputError(
        "eleven_v3 is not supported over ElevenLabs WebSocket TTS; use eleven_flash_v2_5",
      );
    }
    const outDir = resolveOutTarget(input.out ?? config.outputDir, true).dir;
    const headers = resolved.usesProfileAuth
      ? authHeaders(options.apiKey ?? getApiKey({ profile: options.profile }))
      : undefined;
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

function resolveTarget(
  target: string,
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  baseUrl: string,
): { url: URL; path: string; usesProfileAuth: boolean } {
  if (entry)
    return {
      url: buildCatalogUrl(entry, { baseUrl, query }),
      path: entry.pathTemplate,
      usesProfileAuth: true,
    };
  const rawAbsolute = target.startsWith("ws://") || target.startsWith("wss://");
  const rawPath = target.startsWith("/");
  const url = rawAbsolute ? new URL(target) : rawPath ? wsUrlFromPath(target, baseUrl) : undefined;
  if (!url) throw new Error(`Unknown WS catalog entry or raw path: ${target}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return { url, path: url.pathname, usesProfileAuth: rawPath };
}

function resolveTargetForInput(
  target: string,
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  baseUrl: string,
): { url: URL; path: string; usesProfileAuth: boolean } {
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

function rejectsRawElevenV3(url: URL, script: ReturnType<typeof parseSendScript>): boolean {
  return (
    url.searchParams.get("model_id")?.toLowerCase() === "eleven_v3" ||
    scriptUsesModel(script, "eleven_v3")
  );
}

function authHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  if (!apiKey) return undefined;
  return { "xi-api-key": apiKey };
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
  if (error instanceof ConfigFileError) {
    return {
      env: configFileError("elv ws", error.message, { raw: { path: error.path } }),
      exitCode: ExitCode.InputValidation,
    };
  }
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
      error: { type: "network_error", code: "ws_session_failed", message },
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
