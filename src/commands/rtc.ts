import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Command } from "commander";
import { ConfigFileError, loadConfig } from "../core/config";
import { runOperation } from "../core/client";
import { failure, success } from "../core/envelope";
import {
  configFileError,
  confirmationRequired,
  emitAndExit,
  exitCodeForError,
  validationError,
} from "../core/errors";
import { OutTargetError, resolveOutTarget } from "../core/files";
import { ExitCode, type CommandResult, type FileRecord, type RunOpts } from "../core/types";
import { runRtcSession, RtcSessionError } from "../rtc/session";
import { parseRtcScript, validateRtcFiles } from "../rtc/actions";
import { errorMessage } from "../util/error";
import { isRecord } from "../util/json";
import { redactWsString } from "../ws/events";
import { numberValue, runOptsFromCommand } from "./options";

const CMD = "elv rtc";

interface RtcFlags {
  agentId?: string;
  participantName?: string;
  branchId?: string;
  environment?: string;
  debugEvents?: boolean;
  serverUrl?: string;
  tokenEnv?: string;
  tokenFile?: string;
  send?: string;
  duplex?: boolean;
  timeoutMs?: string;
  maxAudioBytes?: string;
  maxEventBytes?: string;
  maxTracks?: string;
}

interface RtcRunOptions extends RunOpts {
  duplexInput?: NodeJS.ReadableStream;
  duplexEventSink?: (line: string) => void;
  signal?: AbortSignal;
}

function serverUrl(value: string | undefined, apiBaseUrl: string): string {
  if (!value) {
    const host = new URL(apiBaseUrl).hostname;
    const hosts: Record<string, string> = {
      "api.elevenlabs.io": "livekit.rtc.elevenlabs.io",
      "api.us.elevenlabs.io": "livekit.rtc.elevenlabs.io",
      "api.eu.residency.elevenlabs.io": "livekit.rtc.eu.residency.elevenlabs.io",
      "api.in.residency.elevenlabs.io": "livekit.rtc.in.residency.elevenlabs.io",
    };
    if (!hosts[host])
      throw new Error(
        "--server-url is required for this API host; no documented LiveKit server mapping is available",
      );
    value = `wss://${hosts[host]}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--server-url must be a valid WebSocket URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
    throw new Error("--server-url requires wss://, or ws:// for a loopback test server");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "--server-url cannot contain credentials, query parameters, or a fragment; use --token-env or --token-file",
    );
  return url.href;
}

function boundedFile(path: string, maxBytes: number, label: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes)
      throw new Error(`${label} must be a regular file of at most ${maxBytes} bytes`);
    const bytes = Buffer.alloc(Math.min(stats.size + 1, maxBytes + 1));
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
      if (length === bytes.length) throw new Error(`${label} changed or exceeds its size limit`);
    }
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readToken(flags: RtcFlags): { token: string; conversationId?: string } {
  if (flags.tokenEnv && flags.tokenFile)
    throw new Error("Use only one of --token-env and --token-file");
  let token: unknown;
  let conversationId: string | undefined;
  if (flags.tokenEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(flags.tokenEnv))
      throw new Error("--token-env requires an environment variable name");
    token = process.env[flags.tokenEnv];
  } else if (flags.tokenFile) {
    let value: unknown;
    try {
      value = JSON.parse(boundedFile(flags.tokenFile, 64 * 1024, "--token-file"));
    } catch {
      throw new Error("--token-file must be a JSON object containing token, at most 65536 bytes");
    }
    if (!isRecord(value) || typeof value.token !== "string")
      throw new Error("--token-file must contain a token string");
    token = value.token;
    if (
      typeof value.conversation_id === "string" &&
      /^conv_[A-Za-z0-9_-]{1,240}$/u.test(value.conversation_id)
    )
      conversationId = value.conversation_id;
  }
  if (token === undefined) return { token: "" };
  if (typeof token !== "string" || Buffer.byteLength(token) > 64 * 1024 || /[\r\n]/u.test(token))
    throw new Error("The session token must be a single-line string of at most 65536 bytes");
  return { token: token.trim(), conversationId };
}

function positive(
  value: string | undefined,
  fallback: number,
  label: string,
  maximum = 2_147_483_647,
): number {
  const number = numberValue(value) ?? fallback;
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum)
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  return number;
}

export async function runRtc(flags: RtcFlags, options: RtcRunOptions = {}): Promise<CommandResult> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let token = "";
  let conversationId: string | undefined;
  let tokenFiles: FileRecord[] = [];
  try {
    const config = loadConfig({
      profile: options.profile,
      baseUrl: options.baseUrl,
      maxCredits: options.maxCredits,
    });
    if (
      config.maxCredits !== undefined &&
      (!Number.isFinite(config.maxCredits) || config.maxCredits < 0)
    )
      throw new Error("--max-credits must be a non-negative number");
    if (flags.agentId && (flags.tokenEnv || flags.tokenFile))
      throw new Error("Use --agent-id or an existing token, not both");
    if (
      !flags.agentId &&
      (flags.participantName || flags.branchId || flags.environment || flags.debugEvents)
    )
      throw new Error(
        "Participant, branch, environment and debug-event options require --agent-id",
      );
    const url = serverUrl(flags.serverUrl, config.baseUrl);
    ({ token, conversationId } = readToken(flags));
    const script = flags.send
      ? parseRtcScript(boundedFile(flags.send, 4 * 1024 * 1024, "--send"))
      : [];
    for (const action of script) {
      if (action.type === "send_audio_file") {
        action.path = resolve(
          flags.send ? dirname(resolve(flags.send)) : process.cwd(),
          action.path,
        );
      }
    }
    validateRtcFiles(script);
    const limits = {
      timeoutMs: positive(flags.timeoutMs, 600_000, "--timeout-ms", 2_147_483_647),
      maxAudioBytes: positive(flags.maxAudioBytes, 256 * 1024 * 1024, "--max-audio-bytes"),
      maxEventBytes: positive(flags.maxEventBytes, 16 * 1024 * 1024, "--max-event-bytes"),
      maxTracks: positive(flags.maxTracks, 16, "--max-tracks"),
    };
    const outDir = resolveOutTarget(options.out ?? config.outputDir, true).dir;
    if (options.dryRun)
      return {
        env: success({
          cmd: CMD,
          data: {
            dry_run: true,
            transport: "webrtc",
            server_url: url,
            token_present: Boolean(token),
            token_from_api: Boolean(flags.agentId),
            actions: script.length,
            duplex: flags.duplex === true,
            would_require_yes: true,
            would_exceed_budget: config.maxCredits !== undefined,
            ...limits,
          },
        }),
        exitCode: ExitCode.Success,
      };
    if (config.maxCredits !== undefined)
      return {
        env: failure({
          cmd: CMD,
          error: {
            type: "budget_exceeded",
            code: "budget_estimate_unavailable",
            message:
              "WebRTC session credits cannot be bounded; remove the configured ceiling only if unbounded session cost is acceptable",
          },
          retry: { recommended: false, after_ms: null },
        }),
        exitCode: ExitCode.BudgetCeiling,
      };
    if (!options.yes)
      return {
        env: confirmationRequired(
          CMD,
          "Joining a WebRTC conversation can start a paid agent session and requires --yes",
        ),
        exitCode: ExitCode.ConfirmationRequired,
      };
    if (flags.agentId) {
      const query = Object.fromEntries(
        Object.entries({
          agent_id: flags.agentId,
          participant_name: flags.participantName,
          branch_id: flags.branchId,
          environment: flags.environment,
          debug_events_request: flags.debugEvents || undefined,
        }).filter(([, value]) => value !== undefined),
      );
      const result = await runOperation(
        "get_livekit_token",
        { query },
        { ...options, cmd: CMD, out: outDir },
      );
      if (!result.ok)
        return { env: result, exitCode: exitCodeForError(result.error, result.http?.status) };
      tokenFiles = result.files ?? [];
      const privateToken = tokenFiles.find(
        (file) => file.sensitive && file.mime === "application/json",
      );
      if (!privateToken)
        throw new Error("The token endpoint did not return a private token artifact");
      ({ token, conversationId } = readToken({ tokenFile: privateToken.path }));
    }
    if (!token)
      return {
        env: failure({
          cmd: CMD,
          error: {
            type: "authentication_error",
            code: "missing_session_token",
            message:
              "Supply --agent-id, --token-env, or the private JSON file from get_livekit_token using --token-file",
          },
          files: tokenFiles,
        }),
        exitCode: ExitCode.AuthPermission,
      };
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const result = await runRtcSession({
      serverUrl: url,
      token,
      outDir,
      script,
      ...limits,
      signal: controller.signal,
      duplex: flags.duplex
        ? {
            input: options.duplexInput ?? process.stdin,
            onEvent:
              options.duplexEventSink ??
              ((line) => {
                process.stderr.write(`${line}\n`);
              }),
          }
        : undefined,
    });
    return {
      env: success({
        cmd: CMD,
        data: { ...result.rtc, transport: "webrtc", conversation_id: conversationId },
        files: [...tokenFiles, ...result.files],
      }),
      exitCode: ExitCode.Success,
    };
  } catch (error) {
    const message = redactWsString(
      token ? errorMessage(error).split(token).join("[REDACTED]") : errorMessage(error),
    );
    if (error instanceof RtcSessionError)
      return {
        env: failure({
          cmd: CMD,
          error: {
            type: "webrtc_error",
            code: error.code,
            message,
            raw: { conversation_id: conversationId, rtc: error.rtc },
          },
          files: [...tokenFiles, ...error.files],
          retry: { recommended: false, after_ms: null },
        }),
        exitCode: ExitCode.ProviderError,
      };
    return {
      env: {
        ...(error instanceof ConfigFileError
          ? configFileError(CMD, message)
          : validationError(
              CMD,
              error instanceof OutTargetError ? "WebRTC output requires a directory" : message,
            )),
        files: tokenFiles,
      },
      exitCode: ExitCode.InputValidation,
    };
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function registerRtcCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  addCommonFlags(
    program
      .command("rtc")
      .description("Join an ElevenAgents or Speech Engine WebRTC session through LiveKit")
      .option("--agent-id <id>", "fetch a token for agent_ or seng_ after safety gates")
      .option("--participant-name <name>", "participant name when fetching a token")
      .option("--branch-id <id>", "agent branch when fetching a token")
      .option("--environment <name>", "agent environment when fetching a token")
      .option("--debug-events", "request editor-authorized debug events when fetching a token")
      .option(
        "--server-url <url>",
        "override the documented regional LiveKit server (ws:// only on loopback)",
      )
      .option("--token-env <name>", "read the LiveKit session token from an environment variable")
      .option("--token-file <path>", "private JSON token response from get_livekit_token")
      .option(
        "--send <path>",
        "NDJSON actions: send, send_audio, send_audio_file, send_data, wait, close",
      )
      .option("--duplex", "read live actions on stdin and write redacted events on stderr")
      .option("--timeout-ms <ms>", "session deadline, including connection (default 600000)")
      .option("--max-audio-bytes <n>", "maximum audio bytes per direction (default 268435456)")
      .option("--max-event-bytes <n>", "maximum saved event bytes (default 16777216)")
      .option("--max-tracks <n>", "maximum received media tracks (default 16)")
      .action(async (flags: RtcFlags, command: Command) => {
        let options: RunOpts;
        try {
          options = runOptsFromCommand(command);
        } catch (error) {
          emitAndExit(validationError(CMD, errorMessage(error)), ExitCode.InputValidation);
        }
        const result = await runRtc(flags, options);
        emitAndExit(result.env, result.exitCode);
      }),
  );
}
