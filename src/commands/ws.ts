import { readFileSync } from "node:fs";
import { success, failure } from "../core/envelope";
import { ConfigFileError, getApiKey, loadConfig } from "../core/config";
import { configFileError, validationError } from "../core/errors";
import { ExitCode } from "../core/types";
import { resolveOutTarget, OutTargetError } from "../core/files";
import { buildCatalogUrl, getWsCatalogEntry, listWsCatalog, wsUrlFromPath } from "../ws/catalog";
import { parseSendScript, scriptUsesModel } from "../ws/events";
import { runWsSession } from "../ws/session";
import type { Envelope, RunOpts } from "../core/types";
import type { WsCatalogEntry } from "../ws/catalog";

export interface RunWsOptions extends Pick<RunOpts, "apiKey" | "baseUrl" | "profile"> {
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
  if (input.list) return listCatalogResult();
  const validated = validateWsInput(input);
  if (!validated.ok) return validated.result;

  try {
    return await runScriptedWs(validated.input, options);
  } catch (error) {
    return errorEnvelope(error);
  }
}

type ValidatedWsInput = WsCommandInput & Required<Pick<WsCommandInput, "target" | "send">>;

function listCatalogResult(): { env: Envelope; exitCode: ExitCode } {
  return {
    env: success({ cmd: "elv ws --list", data: listWsCatalog() }),
    exitCode: ExitCode.Success,
  };
}

function validateWsInput(
  input: WsCommandInput,
):
  | { ok: true; input: ValidatedWsInput }
  | { ok: false; result: { env: Envelope; exitCode: ExitCode } } {
  if (!input.target) return { ok: false, result: inputError("Missing WS target") };
  if (!input.send) return { ok: false, result: inputError("Missing --send script.ndjson") };
  return { ok: true, input: { ...input, target: input.target, send: input.send } };
}

async function runScriptedWs(
  input: ValidatedWsInput,
  options: RunWsOptions,
): Promise<{ env: Envelope; exitCode: ExitCode }> {
  const config = loadConfig({
    profile: options.profile,
    baseUrl: options.baseUrl,
  });
  const entry = getWsCatalogEntry(input.target);
  const script = parseScriptFile(input.send);
  const resolved = resolveTargetForInput(input.target, entry, input.query, config.baseUrl);
  const validationErrorResult = validateScriptedTarget(entry, input.query, script, resolved.url);
  if (validationErrorResult) return validationErrorResult;

  const result = await runWsSession({
    url: resolved.url,
    catalog: entry?.name ?? null,
    path: resolved.path,
    outDir: resolveOutTarget(input.out ?? config.outputDir, true).dir,
    script,
    headers: headersForTarget(resolved.usesProfileAuth, options),
    timeoutMs: options.timeoutMs,
    outputFormat: resolved.url.searchParams.get("output_format") ?? input.query.output_format,
  });

  return {
    env: success({ cmd: "elv ws", ws: result.ws, files: result.files }),
    exitCode: ExitCode.Success,
  };
}

function validateScriptedTarget(
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  script: ReturnType<typeof parseSendScript>,
  url: URL,
): { env: Envelope; exitCode: ExitCode } | undefined {
  if (entry && !entry.scriptable) {
    return inputError(
      `${entry.name} is interactive and is not supported by the scripted ws player`,
    );
  }
  if (rejectsElevenV3Target(entry, query, script, url)) {
    return inputError(
      "eleven_v3 is not supported over ElevenLabs WebSocket TTS; use eleven_flash_v2_5",
    );
  }
  return undefined;
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

function rejectsElevenV3Target(
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  script: ReturnType<typeof parseSendScript>,
  url: URL,
): boolean {
  return entry ? rejectsElevenV3(entry, query, script) : rejectsRawElevenV3(url, script);
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

function headersForTarget(
  usesProfileAuth: boolean,
  options: RunWsOptions,
): Record<string, string> | undefined {
  if (!usesProfileAuth) return undefined;
  return authHeaders(options.apiKey ?? getApiKey({ profile: options.profile }));
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
