import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { success, failure } from "../core/envelope";
import { ConfigFileError, getApiKey, loadConfig } from "../core/config";
import {
  budgetExceeded,
  configFileError,
  confirmationRequired,
  outTargetError,
  validationError,
} from "../core/errors";
import { ExitCode } from "../core/types";
import { resolveOutTarget, OutTargetError } from "../core/files";
import {
  buildCatalogUrl,
  getWsCatalogEntry,
  listWsCatalog,
  wsBaseHost,
  wsUrlFromPath,
} from "../ws/catalog";
import {
  outboundActionCount,
  parseSendScript,
  redactWs,
  redactWsString,
  scriptUsesModel,
  ttsCharacterEstimate,
  validateBinaryFiles,
  WsProtocolValidator,
} from "../ws/events";
import { writeDuplexEventLine } from "../ws/duplex-sink";
import { runWsSession, WsSessionError } from "../ws/session";
import { errorMessage } from "../util/error";
import { shellArg } from "../util/shell";
import type { BudgetDecision } from "../core/budget";
import type { CommandResult, Hint, RunOpts, Warning } from "../core/types";
import type { WsCatalogEntry, WsProtocol } from "../ws/catalog";
import type { SendScriptAction } from "../ws/events";

export interface RunWsOptions extends Pick<
  RunOpts,
  "apiKey" | "baseUrl" | "profile" | "dryRun" | "yes" | "maxCredits" | "retryPost" | "hash"
> {
  timeoutMs?: number;
  debug?: boolean;
  duplexInput?: NodeJS.ReadableStream;
  duplexEventSink?: (line: string) => void;
}

export interface WsCommandInput {
  target?: string;
  list?: boolean;
  query: Record<string, string>;
  send?: string;
  out?: string;
  tokenEnv?: string;
  urlEnv?: string;
  duplex?: boolean;
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

type ValidatedWsInput = WsCommandInput;

function listCatalogResult(): CommandResult {
  return {
    env: success({ cmd: "elv ws --list", data: listWsCatalog() }),
    exitCode: ExitCode.Success,
  };
}

function validateWsInput(
  input: WsCommandInput,
): { ok: true; input: ValidatedWsInput } | { ok: false; result: CommandResult } {
  if (!input.target && !input.urlEnv) {
    return {
      ok: false,
      result: inputError("Missing WS target or --url-env", [
        CATALOG_HINT,
        {
          cmd: "elv ws --url-env SIGNED_WS_URL",
          why: "Reads a signed WebSocket URL from an environment variable instead of argv.",
        },
      ]),
    };
  }
  return { ok: true, input };
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
  const urlOverride = input.urlEnv ? environmentValue(input.urlEnv, "--url-env") : undefined;
  const target = input.target ?? urlOverride!;
  const namedEntry = input.target ? getWsCatalogEntry(input.target) : undefined;
  const actualEntry = catalogEntryForRawTarget(urlOverride ?? target, config.baseUrl);
  if (namedEntry && urlOverride && actualEntry && actualEntry.name !== namedEntry.name) {
    return inputError(
      `Named WebSocket target ${namedEntry.name} does not match the known WebSocket route ${actualEntry.name} from --url-env`,
      [
        {
          cmd: `elv ws ${actualEntry.name} --url-env <name>`,
          why: "Name the route the signed URL actually points at.",
        },
        {
          cmd: "elv ws --url-env <name>",
          why: "Or drop the named target and let the signed URL decide the route.",
        },
      ],
    );
  }
  const entry = namedEntry ?? actualEntry;
  const protocol = entry?.protocol ?? "raw";
  const baseHost = wsBaseHost(config.baseUrl);
  const targetHost = namedEntry
    ? baseHost
    : rawTargetUrl(urlOverride ?? target, config.baseUrl)?.host;
  // Two separate decisions about a raw target whose path matches a known route:
  //   * safety and budget metadata (protocol rules, outbound risk, cost model) is inherited
  //     whatever the host, so an agent-shaped route still fails closed behind --yes;
  //   * the catalog NAME is only reported when the user asked for it by name or the target
  //     resolves to the configured API host, so the envelope never tells an agent it is on a
  //     known ElevenLabs route when it is talking to some other host.
  const catalogName = namedEntry?.name ?? (targetHost === baseHost ? actualEntry?.name : undefined);
  if (!input.send && !input.duplex && protocol !== "monitor") {
    return inputError("Missing --send script.ndjson", [SEND_SCRIPT_HINT, DUPLEX_HINT]);
  }
  const defaultQuery = withConfiguredTtsModel(
    { ...entry?.defaultQuery },
    entry,
    config.defaultTtsModelId,
  );
  const embeddedQuery = embeddedQueryForRawTarget(urlOverride ?? target, config.baseUrl);
  const query = withTokenEnvironment({
    query: { ...defaultQuery, ...embeddedQuery, ...input.query },
    tokenEnv: input.tokenEnv,
    entry,
    urlOverride,
    targetHost,
    baseHost,
  });
  const modelId = query.model_id ?? entry?.defaultQuery?.model_id;
  const script = input.send ? parseScriptFile(input.send, protocol, modelId) : [];
  validateScriptFiles(script);
  if (input.duplex && script.some((action) => action.type === "close")) {
    // playScript stops at the close without closing the socket and the duplex reader stops
    // seeding the validator, so the session would keep streaming stdin into a socket the
    // seed asked to close. Reject the combination instead of ignoring the close.
    return inputError(
      'A --send seed script cannot contain {"type":"close"} under --duplex; send that line on stdin to end the session',
      [DUPLEX_HINT],
    );
  }
  let resolved: ResolvedWsTarget;
  try {
    resolved = resolveTarget(target, namedEntry, query, config.baseUrl, urlOverride);
  } catch (error) {
    // buildCatalogUrl and wsUrlFromPath report missing parameters and off-host paths as
    // plain errors; every one of them is a bad invocation, not a session failure.
    throw new ScriptValidationError(errorMessage(error));
  }
  const validationErrorResult = validateScriptedTarget(entry, resolved.url, script);
  if (validationErrorResult) return validationErrorResult;
  const preflight = wsPreflight(
    entry,
    script,
    resolved.url,
    config.maxCredits,
    input.duplex === true,
  );
  const headers = headersForTarget(resolved.usesProfileAuth, options);

  if (options.dryRun) {
    return dryRunResult(entry, catalogName, protocol, script, resolved, headers, preflight);
  }
  const budgetError = enforceWsBudget(preflight, config.maxCredits);
  if (budgetError) return budgetError;
  if (preflight.requiresYes && !options.yes) {
    return {
      env: confirmationRequired(
        "elv ws",
        preflight.budget.unbounded
          ? "Configured max-credits cannot bound this raw WebSocket session; rerun with --yes to accept that limit"
          : "Outbound agent or monitor actions require --yes",
        { raw: { catalog: catalogName, outbound_actions: preflight.outboundActions } },
      ),
      exitCode: ExitCode.ConfirmationRequired,
    };
  }

  const result = await runWsSession({
    url: resolved.url,
    catalog: catalogName ?? null,
    path: resolved.path,
    outDir: resolveOutTarget(input.out ?? config.outputDir, true).dir,
    script,
    headers,
    timeoutMs: options.timeoutMs,
    outputFormat: resolved.url.searchParams.get("output_format") ?? entry?.defaultAudioFormat,
    duplex: input.duplex
      ? {
          input: options.duplexInput ?? process.stdin,
          protocol,
          modelId,
          onEvent: options.duplexEventSink ?? writeDuplexEventLine,
        }
      : undefined,
  });

  return {
    env: success({
      cmd: "elv ws",
      ws: result.ws,
      files: result.files,
      cost: {
        credits_estimated: preflight.budget.creditsEstimated,
        credits_charged: null,
        credits_source: preflight.budget.creditsEstimated === null ? "none" : "estimate",
      },
      warnings: sessionWarnings(preflight, result.warnings),
    }),
    exitCode: ExitCode.Success,
  };
}

function sessionWarnings(
  preflight: WsPreflight,
  sessionWarnings: Warning[],
): Warning[] | undefined {
  const warnings: Warning[] = preflight.budget.unbounded
    ? [
        {
          code: "budget_unbounded",
          message:
            "Configured max-credits could not bound this raw WebSocket session; --yes accepted the unbounded request.",
        },
      ]
    : [];
  warnings.push(...sessionWarnings);
  return warnings.length > 0 ? warnings : undefined;
}

function validateScriptedTarget(
  entry: WsCatalogEntry | undefined,
  url: URL,
  script: ReturnType<typeof parseSendScript>,
): CommandResult | undefined {
  if (entry && !entry.scriptable) {
    return inputError(
      `${entry.name} is interactive and is not supported by the scripted ws player`,
    );
  }
  if (entry && rejectsElevenV3(entry, url, script)) {
    return inputError(
      "eleven_v3 is not supported over ElevenLabs WebSocket TTS; use eleven_flash_v2_5",
      [
        {
          cmd: `elv ws ${entry.name} --query model_id=eleven_flash_v2_5`,
          why: "Realtime TTS runs on the flash models.",
        },
      ],
    );
  }
  if (entry?.protocol === "ttd" || entry?.protocol === "ttd-multi") {
    try {
      new WsProtocolValidator(entry.protocol, {
        modelId: url.searchParams.get("model_id") ?? entry.defaultQuery?.model_id ?? "",
      });
    } catch (error) {
      return inputError(errorMessage(error), [
        {
          cmd: `elv ws ${entry.name} --query model_id=eleven_v3_conversational`,
          why: "Text to Dialogue WebSockets require an eleven_v3 model.",
        },
      ]);
    }
  }
  return undefined;
}

function resolveTarget(
  target: string,
  entry: WsCatalogEntry | undefined,
  query: Record<string, string>,
  baseUrl: string,
  urlOverride?: string,
): { url: URL; path: string; usesProfileAuth: boolean } {
  if (urlOverride) {
    const url = new URL(urlOverride);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error("--url-env must contain a ws:// or wss:// URL");
    }
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return { url, path: url.pathname, usesProfileAuth: false };
  }
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

function catalogEntryForRawTarget(target: string, baseUrl: string): WsCatalogEntry | undefined {
  const url = rawTargetUrl(target, baseUrl);
  if (!url) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw new ScriptValidationError("WebSocket path has invalid percent-encoding");
  }
  return listWsCatalog().find((entry) => wsPathMatches(entry.pathTemplate, path));
}

function embeddedQueryForRawTarget(target: string, baseUrl: string): Record<string, string> {
  const url = rawTargetUrl(target, baseUrl);
  return url ? Object.fromEntries(url.searchParams.entries()) : {};
}

function rawTargetUrl(target: string, baseUrl: string): URL | undefined {
  try {
    if (target.startsWith("/") && !target.startsWith("//")) {
      return wsUrlFromPath(target, baseUrl);
    }
    if (target.startsWith("ws://") || target.startsWith("wss://")) return new URL(target);
  } catch {
    return undefined;
  }
  return undefined;
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

function rejectsElevenV3(
  entry: WsCatalogEntry,
  url: URL,
  script: ReturnType<typeof parseSendScript>,
): boolean {
  if (entry.rejectsV3 !== true) return false;
  return (
    url.searchParams.get("model_id")?.toLowerCase().startsWith("eleven_v3") === true ||
    scriptUsesModel(script, "eleven_v3") ||
    scriptUsesModel(script, "eleven_v3_conversational")
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

interface ResolvedWsTarget {
  url: URL;
  path: string;
  usesProfileAuth: boolean;
}

interface WsBudgetOutcome {
  policy: BudgetDecision["policy"];
  creditsEstimated: number | null;
  /** null when nothing can be said either way, which only --yes can accept. */
  wouldExceed: boolean | null;
  /** A raw session a configured ceiling cannot bind; --yes accepts it with a warning. */
  unbounded: boolean;
  /** A live session whose cost the provider decides as it runs. */
  dynamicCost: boolean;
}

interface WsPreflight {
  outboundActions: number;
  requiresYes: boolean;
  duplex: boolean;
  budget: WsBudgetOutcome;
}

function withConfiguredTtsModel(
  query: Record<string, string>,
  entry: WsCatalogEntry | undefined,
  defaultTtsModelId: string | undefined,
): Record<string, string> {
  if (
    (entry?.protocol !== "tts" && entry?.protocol !== "tts-multi") ||
    query.model_id ||
    !defaultTtsModelId
  )
    return query;
  return { ...query, model_id: defaultTtsModelId };
}

interface TokenEnvironmentInput {
  query: Record<string, string>;
  tokenEnv: string | undefined;
  entry: WsCatalogEntry | undefined;
  urlOverride: string | undefined;
  targetHost: string | undefined;
  baseHost: string;
}

function withTokenEnvironment(input: TokenEnvironmentInput): Record<string, string> {
  const { query, tokenEnv, entry, urlOverride, targetHost, baseHost } = input;
  if (!tokenEnv) return query;
  if (urlOverride) {
    throw new ScriptValidationError("--token-env cannot be combined with --url-env", [
      {
        cmd: "elv ws --url-env SIGNED_WS_URL",
        why: "A signed URL already carries its credential; drop --token-env.",
      },
      {
        cmd: "elv ws <catalog-name> --token-env WS_TOKEN",
        why: "Or name a catalog route and let --token-env add the token parameter.",
      },
    ]);
  }
  // The token travels in the connection URL, so it is only safe on the host the
  // profile is configured for -- the same rule wsUrlFromPath enforces for profile auth.
  if (targetHost !== undefined && targetHost !== baseHost) {
    throw new ScriptValidationError(
      `--token-env sends the token to the connection host, and ${targetHost} is not the configured API host ${baseHost}`,
      [
        {
          cmd: "elv ws --url-env SIGNED_WS_URL",
          why: "Reach another host through a signed URL, which carries its own credential.",
        },
        CATALOG_HINT,
      ],
    );
  }
  const parameter = entry?.tokenParam;
  if (!parameter) {
    throw new ScriptValidationError(
      "--token-env is supported only for named TTS, Text to Dialogue, and realtime STT protocols",
      [CATALOG_HINT],
    );
  }
  if (query.token !== undefined || query.single_use_token !== undefined) {
    throw new ScriptValidationError(
      "Use --token-env or an explicit token query parameter, not both",
      [{ cmd: "elv ws <target> --token-env WS_TOKEN", why: "Keep the token out of argv." }],
    );
  }
  return { ...query, [parameter]: environmentValue(tokenEnv, "--token-env") };
}

function environmentValue(name: string, flag: "--token-env" | "--url-env"): string {
  const value = process.env[name];
  if (!value)
    throw new ScriptValidationError(`${flag} ${name} is unset or empty; set it and retry`);
  return value;
}

function wsPreflight(
  entry: WsCatalogEntry | undefined,
  script: SendScriptAction[],
  url: URL,
  maxCredits: number | undefined,
  duplex: boolean,
): WsPreflight {
  const outboundActions = outboundActionCount(script);
  const protocol = entry?.protocol ?? "raw";
  const budget = wsBudget(entry, script, url, maxCredits, duplex, outboundActions);
  const dynamicAgentActions = duplex && (protocol === "convai" || protocol === "monitor");
  return {
    outboundActions,
    requiresYes:
      (outboundActions > 0 && entry?.outboundRisk !== undefined) ||
      dynamicAgentActions ||
      budget.unbounded,
    duplex,
    budget,
  };
}

function wsBudget(
  entry: WsCatalogEntry | undefined,
  script: SendScriptAction[],
  url: URL,
  maxCredits: number | undefined,
  duplex: boolean,
  outboundActions: number,
): WsBudgetOutcome {
  const costModel = entry?.costModel ?? "unknown";
  // A live session on a metered route bills for whatever the provider generates, so a
  // send-script estimate stops meaning anything the moment stdin can add to it.
  const dynamicCost = duplex && costModel !== "unknown";
  const creditsEstimated =
    !dynamicCost && costModel === "tts_characters"
      ? ttsCharacterEstimate(
          script,
          url.searchParams.get("model_id") ?? entry?.defaultQuery?.model_id ?? "",
        )
      : null;
  const estimateUnavailable = dynamicCost || costModel === "unbounded";
  const unbounded =
    entry === undefined && maxCredits !== undefined && (outboundActions > 0 || duplex);
  return {
    ...budgetVerdict(maxCredits, creditsEstimated, estimateUnavailable),
    creditsEstimated,
    unbounded,
    dynamicCost,
  };
}

function budgetVerdict(
  maxCredits: number | undefined,
  creditsEstimated: number | null,
  estimateUnavailable: boolean,
): Pick<WsBudgetOutcome, "policy" | "wouldExceed"> {
  if (maxCredits === undefined) return { policy: "not_configured", wouldExceed: false };
  if (creditsEstimated !== null) {
    return { policy: "bounded", wouldExceed: creditsEstimated > maxCredits };
  }
  if (estimateUnavailable) return { policy: "estimate_unavailable", wouldExceed: true };
  return { policy: "unknown_unbounded", wouldExceed: null };
}

function dryRunResult(
  entry: WsCatalogEntry | undefined,
  catalogName: string | undefined,
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
        credits_estimated: preflight.budget.creditsEstimated,
        credits_charged: null,
        credits_source: preflight.budget.creditsEstimated === null ? "none" : "estimate",
      },
      data: redactWs({
        dry_run: true,
        request: {
          catalog: catalogName ?? null,
          protocol,
          path: resolved.path,
          connection_url: redactWsString(resolved.url.toString()),
          headers: headers ?? {},
          script,
        },
        risk: entry?.outboundRisk ?? (preflight.budget.unbounded ? "unknown_unbounded" : "read"),
        outbound_actions: preflight.outboundActions,
        credits_estimated: preflight.budget.creditsEstimated,
        budget_policy: preflight.budget.policy,
        would_require_yes: preflight.requiresYes,
        would_exceed_budget: preflight.budget.wouldExceed,
        unbounded_budget: preflight.budget.unbounded,
        dynamic_cost_unbounded: preflight.budget.dynamicCost,
        duplex: preflight.duplex,
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
  if (preflight.budget.policy === "estimate_unavailable") {
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
  if (preflight.budget.wouldExceed) {
    return {
      env: budgetExceeded("elv ws", preflight.budget.creditsEstimated, maxCredits),
      exitCode: ExitCode.BudgetCeiling,
    };
  }
  return undefined;
}

function inputError(message: string, hints?: Hint[]): CommandResult {
  return { env: validationError("elv ws", message, { hints }), exitCode: ExitCode.InputValidation };
}

const SEND_SCRIPT_HINT: Hint = {
  cmd: "elv ws <target> --send script.ndjson",
  why: 'One NDJSON action per line, for example {"type":"send","data":{"text":" "}}.',
};

const DUPLEX_HINT: Hint = {
  cmd: "elv ws <target> --duplex",
  why: "Stream actions on stdin and read received events on stderr instead of scripting a file.",
};

const CATALOG_HINT: Hint = {
  cmd: "elv ws --list",
  why: "Lists every route with its protocol, first message, terminal rule, and duplex support.",
};

function parseScriptFile(
  path: string,
  protocol: WsProtocol | "raw",
  modelId?: string,
): ReturnType<typeof parseSendScript> {
  try {
    return parseSendScript(readFileSync(path, "utf8"), protocol, { modelId }).map((action) =>
      (action.type === "send_binary_file" || action.type === "send_audio_file") &&
      !isAbsolute(action.path)
        ? { ...action, path: resolve(dirname(path), action.path) }
        : action,
    );
  } catch (error) {
    throw new ScriptValidationError(errorMessage(error), [SEND_SCRIPT_HINT, CATALOG_HINT]);
  }
}

function validateScriptFiles(script: SendScriptAction[]): void {
  try {
    validateBinaryFiles(script);
  } catch (error) {
    throw new ScriptValidationError(errorMessage(error));
  }
}

function errorEnvelope(error: unknown): CommandResult {
  if (error instanceof ScriptValidationError) return inputError(error.message, error.hints);
  if (error instanceof ConfigFileError) {
    return {
      env: configFileError("elv ws", error.message, { raw: { path: error.path } }),
      exitCode: ExitCode.InputValidation,
    };
  }
  if (error instanceof OutTargetError) {
    return {
      env: outTargetError("elv ws", error, { hintCmd: "elv ws --out <dir>" }),
      exitCode: ExitCode.InputValidation,
    };
  }
  if (error instanceof WsSessionError) {
    const partial = error.files.length > 0;
    const duplexInputError = error.code.startsWith("ws_duplex_");
    return {
      env: failure({
        cmd: "elv ws",
        error: {
          type: duplexInputError ? "validation_error" : "network_error",
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
      exitCode: duplexInputError ? ExitCode.InputValidation : ExitCode.ProviderError,
    };
  }
  const message = errorMessage(error);
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
  constructor(
    message: string,
    readonly hints: Hint[] = [],
  ) {
    super(message);
    this.name = "ScriptValidationError";
  }
}
