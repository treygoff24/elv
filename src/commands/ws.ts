import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { success, failure } from "../core/envelope";
import { ConfigFileError, getApiKey, loadConfig } from "../core/config";
import {
  budgetExceeded,
  configFileError,
  confirmationRequired,
  validationError,
} from "../core/errors";
import { ExitCode } from "../core/types";
import { resolveOutTarget, OutTargetError } from "../core/files";
import { buildCatalogUrl, getWsCatalogEntry, listWsCatalog, wsUrlFromPath } from "../ws/catalog";
import {
  outboundActionCount,
  parseSendScript,
  redactWs,
  redactWsString,
  scriptUsesModel,
  ttsCharacterEstimate,
  validateBinaryFiles,
} from "../ws/events";
import { runWsSession, WsSessionError } from "../ws/session";
import { shellArg } from "../util/shell";
import type { CommandResult, RunOpts } from "../core/types";
import type { WsCatalogEntry, WsProtocol } from "../ws/catalog";
import type { SendScriptAction } from "../ws/events";

export interface RunWsOptions extends Pick<
  RunOpts,
  "apiKey" | "baseUrl" | "profile" | "dryRun" | "yes" | "maxCredits" | "retryPost" | "hash"
> {
  timeoutMs?: number;
  debug?: boolean;
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
): Promise<CommandResult> {
  if (input.list) return listCatalogResult();
  const validated = validateWsInput(input);
  if (!validated.ok) return validated.result;

  try {
    return await runScriptedWs(validated.input, options);
  } catch (error) {
    return errorEnvelope(error);
  }
}

type ValidatedWsInput = WsCommandInput & Required<Pick<WsCommandInput, "target">>;

function listCatalogResult(): CommandResult {
  return {
    env: success({ cmd: "elv ws --list", data: listWsCatalog() }),
    exitCode: ExitCode.Success,
  };
}

function validateWsInput(
  input: WsCommandInput,
): { ok: true; input: ValidatedWsInput } | { ok: false; result: CommandResult } {
  if (!input.target) return { ok: false, result: inputError("Missing WS target") };
  return { ok: true, input: { ...input, target: input.target } };
}

async function runScriptedWs(
  input: ValidatedWsInput,
  options: RunWsOptions,
): Promise<CommandResult> {
  const config = loadConfig({
    profile: options.profile,
    baseUrl: options.baseUrl,
    maxCredits: options.maxCredits,
  });
  if (
    config.maxCredits !== undefined &&
    (!Number.isFinite(config.maxCredits) || config.maxCredits < 0)
  ) {
    return inputError("--max-credits must be a non-negative number");
  }
  const namedEntry = getWsCatalogEntry(input.target);
  const entry = namedEntry ?? catalogEntryForRawPath(input.target);
  const protocol = entry?.protocol ?? "raw";
  if (!input.send && protocol !== "monitor") {
    return inputError("Missing --send script.ndjson");
  }
  const baseQuery = namedEntry ? input.query : { ...entry?.defaultQuery, ...input.query };
  const query = withConfiguredTtsModel(baseQuery, entry, config.defaultModelId);
  const script = input.send ? parseScriptFile(input.send, protocol) : [];
  validateScriptFiles(script);
  const resolved = resolveTargetForInput(input.target, namedEntry, query, config.baseUrl);
  const validationErrorResult = validateScriptedTarget(entry, query, script);
  if (validationErrorResult) return validationErrorResult;
  const preflight = wsPreflight(entry, script, resolved.url, config.maxCredits);
  const headers = headersForTarget(resolved.usesProfileAuth, options);

  if (options.dryRun) {
    return dryRunResult(entry, protocol, script, resolved, headers, preflight);
  }
  if (preflight.requiresYes && !options.yes) {
    return {
      env: confirmationRequired("elv ws", "Outbound agent or monitor actions require --yes", {
        raw: { catalog: entry?.name, outbound_actions: preflight.outboundActions },
      }),
      exitCode: ExitCode.ConfirmationRequired,
    };
  }
  const budgetError = enforceWsBudget(preflight, config.maxCredits);
  if (budgetError) return budgetError;

  const result = await runWsSession({
    url: resolved.url,
    catalog: entry?.name ?? null,
    path: resolved.path,
    outDir: resolveOutTarget(input.out ?? config.outputDir, true).dir,
    script,
    headers,
    timeoutMs: options.timeoutMs,
    outputFormat: resolved.url.searchParams.get("output_format") ?? input.query.output_format,
  });

  return {
    env: success({
      cmd: "elv ws",
      ws: result.ws,
      files: result.files,
      cost: {
        credits_estimated: preflight.creditsEstimated,
        credits_charged: null,
        credits_source: preflight.creditsEstimated === null ? "none" : "estimate",
      },
    }),
    exitCode: ExitCode.Success,
  };
}

function validateScriptedTarget(
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  script: ReturnType<typeof parseSendScript>,
): CommandResult | undefined {
  if (entry && !entry.scriptable) {
    return inputError(
      `${entry.name} is interactive and is not supported by the scripted ws player`,
    );
  }
  if (entry && rejectsElevenV3(entry, query, script)) {
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
  const rawPath = target.startsWith("/") && !target.startsWith("//");
  const url = rawAbsolute ? new URL(target) : rawPath ? wsUrlFromPath(target, baseUrl) : undefined;
  if (!url) throw new Error(`Unknown WS catalog entry or raw path: ${target}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return { url, path: url.pathname, usesProfileAuth: rawPath };
}

function catalogEntryForRawPath(target: string): WsCatalogEntry | undefined {
  if (!target.startsWith("/") || target.startsWith("//")) return undefined;
  const path = target.replace(/\?.*$/u, "");
  return listWsCatalog().find((entry) => wsPathMatches(entry.pathTemplate, path));
}

function wsPathMatches(template: string, path: string): boolean {
  const templateParts = template.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  return (
    templateParts.length === pathParts.length &&
    templateParts.every(
      (part, index) => (part.startsWith("{") && part.endsWith("}")) || part === pathParts[index],
    )
  );
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

interface ResolvedWsTarget {
  url: URL;
  path: string;
  usesProfileAuth: boolean;
}

interface WsPreflight {
  outboundActions: number;
  requiresYes: boolean;
  creditsEstimated: number | null;
  budgetPolicy: "not_configured" | "bounded" | "estimate_unavailable" | "unknown_unbounded";
  wouldExceedBudget: boolean | null;
}

function withConfiguredTtsModel(
  query: Record<string, string>,
  entry: WsCatalogEntry | undefined,
  defaultModelId: string | undefined,
): Record<string, string> {
  if (entry?.protocol !== "tts" || query.model_id || !defaultModelId) return query;
  return { ...query, model_id: defaultModelId };
}

function wsPreflight(
  entry: WsCatalogEntry | undefined,
  script: SendScriptAction[],
  url: URL,
  maxCredits: number | undefined,
): WsPreflight {
  const outboundActions = outboundActionCount(script);
  const protocol = entry?.protocol ?? "raw";
  const creditsEstimated =
    protocol === "tts"
      ? ttsCharacterEstimate(
          script,
          url.searchParams.get("model_id") ?? entry?.defaultQuery?.model_id ?? "",
        )
      : null;
  const estimateUnavailable = protocol === "stt" || protocol === "convai";
  const budgetPolicy =
    maxCredits === undefined
      ? "not_configured"
      : creditsEstimated !== null
        ? "bounded"
        : estimateUnavailable
          ? "estimate_unavailable"
          : "unknown_unbounded";
  const wouldExceedBudget =
    maxCredits === undefined
      ? false
      : creditsEstimated !== null
        ? creditsEstimated > maxCredits
        : estimateUnavailable
          ? true
          : null;
  return {
    outboundActions,
    requiresYes: outboundActions > 0 && entry?.outboundRisk !== undefined,
    creditsEstimated,
    budgetPolicy,
    wouldExceedBudget,
  };
}

function dryRunResult(
  entry: WsCatalogEntry | undefined,
  protocol: WsProtocol | "raw",
  script: SendScriptAction[],
  resolved: ResolvedWsTarget,
  headers: Record<string, string> | undefined,
  preflight: WsPreflight,
): CommandResult {
  return {
    env: success({
      cmd: "elv ws",
      cost: {
        credits_estimated: preflight.creditsEstimated,
        credits_charged: null,
        credits_source: preflight.creditsEstimated === null ? "none" : "estimate",
      },
      data: redactWs({
        dry_run: true,
        request: {
          catalog: entry?.name ?? null,
          protocol,
          path: resolved.path,
          connection_url: redactWsString(resolved.url.toString()),
          headers: headers ?? {},
          script,
        },
        risk: preflight.requiresYes ? entry?.outboundRisk : "read",
        outbound_actions: preflight.outboundActions,
        credits_estimated: preflight.creditsEstimated,
        budget_policy: preflight.budgetPolicy,
        would_require_yes: preflight.requiresYes,
        would_exceed_budget: preflight.wouldExceedBudget,
      }),
    }),
    exitCode: ExitCode.Success,
  };
}

function enforceWsBudget(
  preflight: WsPreflight,
  maxCredits: number | undefined,
): CommandResult | undefined {
  if (maxCredits === undefined) return undefined;
  if (!Number.isFinite(maxCredits) || maxCredits < 0) {
    return inputError("--max-credits must be a non-negative number");
  }
  if (preflight.budgetPolicy === "estimate_unavailable") {
    return {
      env: failure({
        cmd: "elv ws",
        error: {
          type: "budget_exceeded",
          code: "budget_estimate_unavailable",
          message: "WebSocket session cost cannot be bounded before connecting",
          raw: { estimated: null, max: maxCredits },
        },
        cost: {
          credits_estimated: null,
          credits_charged: null,
          credits_source: "none",
        },
        retry: { recommended: false, after_ms: null },
        hints: [
          {
            cmd: "elv ws ... --dry-run",
            why: "Inspect the session before deliberately removing the credit ceiling.",
          },
        ],
      }),
      exitCode: ExitCode.BudgetCeiling,
    };
  }
  if (preflight.wouldExceedBudget) {
    return {
      env: budgetExceeded("elv ws", preflight.creditsEstimated, maxCredits),
      exitCode: ExitCode.BudgetCeiling,
    };
  }
  return undefined;
}

function inputError(message: string): CommandResult {
  return { env: validationError("elv ws", message), exitCode: ExitCode.InputValidation };
}

function parseScriptFile(
  path: string,
  protocol: WsProtocol | "raw",
): ReturnType<typeof parseSendScript> {
  try {
    return parseSendScript(readFileSync(path, "utf8"), protocol).map((action) =>
      action.type === "send_binary_file" && !isAbsolute(action.path)
        ? { ...action, path: resolve(dirname(path), action.path) }
        : action,
    );
  } catch (error) {
    throw new ScriptValidationError(error instanceof Error ? error.message : String(error));
  }
}

function validateScriptFiles(script: SendScriptAction[]): void {
  try {
    validateBinaryFiles(script);
  } catch (error) {
    throw new ScriptValidationError(error instanceof Error ? error.message : String(error));
  }
}

function errorEnvelope(error: unknown): CommandResult {
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
  if (error instanceof WsSessionError) {
    const partial = error.files.length > 0;
    return {
      env: failure({
        cmd: "elv ws",
        error: {
          type: "network_error",
          code: error.code,
          message: error.message,
          raw: partial ? { partial: true } : undefined,
        },
        retry: {
          recommended: error.code === "ws_connect_timeout",
          after_ms: error.code === "ws_connect_timeout" ? 1_000 : null,
        },
        files: partial ? error.files : undefined,
        ws: error.ws,
        hints: partial
          ? [
              {
                cmd: `elv view ${shellArg(error.files[0]!.path)}`,
                why: "Inspect preserved partial output; provider credits may already have been consumed.",
              },
            ]
          : [],
      }),
      exitCode: ExitCode.ProviderError,
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
