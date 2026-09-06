import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { fileRecord, writeManifest } from "../core/files";
import { errorMessage } from "../util/error";
import { isRecord } from "../util/json";
import {
  MAX_RTC_LINE_BYTES,
  parseRtcActionLine,
  parseRtcScript,
  validateRtcFiles,
  type RtcAction,
} from "./actions";
import {
  emptyRtcInfo,
  RTC_WORKER_EXIT_GRACE_MS,
  RTC_WORKER_KILL_GRACE_MS,
  RTC_SUPERVISOR_GRACE_MS,
  type OpenArtifact,
  type ParentMessage,
  type RtcInfo,
  type RtcSessionOptions,
  type RtcSessionResult,
  type WorkerMessage,
  type WorkerOptions,
} from "./types";
import { RtcLogCollector, redactRtcText, redactRtcValue } from "./logs";
import type { JsonValue } from "../util/json";
import type { FileRecord } from "../core/types";

export { parseRtcScript, validateRtcAction } from "./actions";
export type { RtcAction } from "./actions";
export type { RtcSessionOptions, RtcSessionResult } from "./types";

export class RtcSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly rtc: RtcInfo,
    readonly files: FileRecord[],
  ) {
    super(message);
    this.name = "RtcSessionError";
  }
}

function workerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", ELV_RTC_WORKER: "1" };
  for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function bound(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647)
    throw new Error(`${label} must be a positive integer no greater than 2147483647`);
  return result;
}

function inside(directory: string, path: string): boolean {
  const child = relative(directory, path);
  return (
    child.length > 0 &&
    !isAbsolute(child) &&
    child !== ".." &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  );
}

async function recoverArtifacts(
  directory: string,
  opened: OpenArtifact[],
  files: Map<string, FileRecord>,
): Promise<void> {
  for (const artifact of opened) {
    if (!inside(directory, artifact.path) || !inside(directory, artifact.temporary_path)) continue;
    if (files.has(artifact.path)) continue;
    try {
      let path = artifact.path;
      if (!existsSync(path)) {
        const temporary = await lstat(artifact.temporary_path);
        if (!temporary.isFile() || temporary.size === 0) continue;
        await link(artifact.temporary_path, path);
        await rm(artifact.temporary_path);
      }
      if (!(await lstat(path)).isFile()) continue;
      files.set(path, {
        ...(await fileRecord(path, { hash: true })),
        mime: artifact.mime,
        partial: true,
      });
    } catch {
      /* Do not replace occupied paths or invent missing partial output. */
    }
  }
}

export async function runRtcSession(options: RtcSessionOptions): Promise<RtcSessionResult> {
  const timeoutMs = bound(options.timeoutMs, 20_000, "RTC timeout");
  const maxAudioBytes = bound(options.maxAudioBytes, 64 * 1024 * 1024, "RTC audio byte limit");
  const maxEventBytes = bound(options.maxEventBytes, 4 * 1024 * 1024, "RTC event byte limit");
  const maxTracks = bound(options.maxTracks, 8, "RTC track limit");
  const url = new URL(options.serverUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "wss:" &&
      !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error(
      "RTC server requires wss:// or loopback ws://, without URL credentials or query parameters",
    );
  if (!options.token.trim()) throw new Error("RTC token is required");
  const script = parseRtcScript(options.script.map((action) => JSON.stringify(action)).join("\n"));
  validateRtcFiles(script);
  if (options.signal?.aborted)
    throw new RtcSessionError(
      "rtc_aborted",
      "RTC session was aborted before connecting",
      { ...emptyRtcInfo(), closed: true, reason: "aborted" },
      [],
    );
  // Prove a private output workspace can be created before loading native code or joining.
  await mkdir(options.outDir, { recursive: true });
  const directory = await mkdtemp(join(options.outDir, "rtc-"));
  if (options.signal?.aborted)
    throw new RtcSessionError(
      "rtc_aborted",
      "RTC session was aborted before connecting",
      { ...emptyRtcInfo(), closed: true, reason: "aborted" },
      [],
    );
  const ownPath = fileURLToPath(import.meta.url);
  const source = ownPath.endsWith(".ts");
  const workerPath = source
    ? join(dirname(ownPath), "worker.ts")
    : join(dirname(ownPath), "rtc-worker.js");
  if (!existsSync(workerPath))
    throw new Error("RTC worker is missing; rebuild or reinstall the CLI");
  const child = fork(workerPath, [], {
    execArgv: source ? ["--import", "tsx"] : [],
    env: workerEnvironment(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const inputAbort = new AbortController();
  const files = new Map<string, FileRecord>();
  const opened: OpenArtifact[] = [];
  let rtc = emptyRtcInfo();
  let response: Extract<WorkerMessage, { type: "result" }> | undefined;
  let failure: { code: string; message: string } | undefined;
  let exited = false;
  let stopReason: string | undefined;
  const stdoutLogs = new RtcLogCollector(options.token);
  const stderrLogs = new RtcLogCollector(options.token);
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let supervisorTimer: NodeJS.Timeout | undefined;
  let resolveSupervisor!: () => void;
  const supervisorDeadline = new Promise<void>((resolve) => {
    resolveSupervisor = resolve;
  });
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => undefined);
  const writeMessage = (message: ParentMessage) =>
    new Promise<void>((resolve, reject) => {
      if (!child.connected) {
        reject(new Error("RTC worker IPC is closed"));
        return;
      }
      child.send(message, (error) => (error ? reject(error) : resolve()));
    });
  const superviseExit = () => {
    if (termTimer || exited) return;
    termTimer = setTimeout(() => {
      if (exited) return;
      failure ??= {
        code: "rtc_cleanup_error",
        message: "RTC worker did not exit after its final receipt",
      };
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, RTC_WORKER_KILL_GRACE_MS);
    }, RTC_WORKER_EXIT_GRACE_MS);
    supervisorTimer = setTimeout(resolveSupervisor, RTC_SUPERVISOR_GRACE_MS);
  };
  const stop = (reason: string, error?: { code: string; message: string }) => {
    if (stopReason || exited) return;
    stopReason = reason;
    inputAbort.abort();
    failure = error ?? {
      code: reason === "timeout" ? "rtc_timeout" : "rtc_aborted",
      message:
        reason === "timeout" ? "RTC session reached its deadline" : "RTC session was aborted",
    };
    void writeMessage({ type: "stop", reason }).catch(() => undefined);
    superviseExit();
  };
  const deadline = setTimeout(() => stop("timeout"), timeoutMs);
  const aborted = () => stop("aborted");
  options.signal?.addEventListener("abort", aborted, { once: true });
  if (options.signal?.aborted) aborted();
  child.stdout!.on("data", (chunk: Buffer) => stdoutLogs.write(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderrLogs.write(chunk));
  child.on("message", (raw: unknown) => {
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    const message = raw as unknown as WorkerMessage;
    switch (message.type) {
      case "ready":
        resolveReady();
        break;
      case "ack":
        pending.get(message.id)?.resolve();
        pending.delete(message.id);
        break;
      case "event":
        try {
          options.duplex?.onEvent(
            JSON.stringify(redactRtcValue(JSON.parse(message.line) as JsonValue, options.token)),
          );
        } catch {
          stop("event_sink_failed", {
            code: "rtc_event_sink_failed",
            message: "RTC event sink failed",
          });
        }
        break;
      case "open_artifact":
        opened.push(message.artifact);
        break;
      case "artifact":
        files.set(message.file.path, message.file);
        if (message.audio)
          rtc.audio_tracks = [
            ...rtc.audio_tracks.filter((track) => track.path !== message.audio!.path),
            message.audio,
          ];
        break;
      case "progress":
        rtc = message.rtc;
        break;
      case "result":
        response = message;
        rtc = message.result.rtc;
        for (const file of message.result.files) files.set(file.path, file);
        superviseExit();
        break;
    }
  });
  const exit = new Promise<void>((resolve) => {
    child.once("error", (error) => {
      failure = { code: "rtc_worker_error", message: errorMessage(error) };
    });
    child.once("close", (code, signal) => {
      exited = true;
      if ((code !== 0 || signal) && !failure && !response?.error) {
        failure = {
          code: "rtc_worker_error",
          message: signal
            ? `RTC worker terminated by ${signal}`
            : `RTC worker exited with code ${code}`,
        };
      }
      inputAbort.abort();
      const error = new Error("RTC session ended");
      rejectReady(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      resolve();
    });
  });
  let inputTask: Promise<void> | undefined;
  try {
    const workerOptions: WorkerOptions = {
      serverUrl: url.href,
      token: options.token,
      outDir: directory,
      script,
      duplex: Boolean(options.duplex),
      timeoutMs,
      maxAudioBytes,
      maxEventBytes,
      maxTracks,
    };
    try {
      await Promise.race([
        writeMessage({ type: "start", options: workerOptions }),
        exit.then(() => {
          throw new Error("RTC worker exited during startup");
        }),
        supervisorDeadline.then(() => {
          throw new Error("RTC worker startup could not be stopped");
        }),
      ]);
    } catch (problem) {
      stop("worker_error", { code: "rtc_worker_error", message: errorMessage(problem) });
      failure ??= { code: "rtc_worker_error", message: errorMessage(problem) };
    }
    if (options.duplex)
      inputTask = (async () => {
        await ready;
        let id = 0;
        let closed = false;
        for await (const action of readRtcActions(options.duplex!.input, inputAbort.signal)) {
          if (exited || stopReason) break;
          validateRtcFiles([action]);
          id += 1;
          const ack = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
          await writeMessage({ type: "action", id, action });
          await ack;
          if (action.type === "close") {
            closed = true;
            break;
          }
        }
        if (!closed && !exited && !stopReason) await writeMessage({ type: "input_end" });
      })().catch((error: unknown) => {
        if (!exited && !response)
          stop("input_error", { code: "rtc_input_error", message: errorMessage(error) });
      });
    await Promise.race([exit, supervisorDeadline]);
    if (!exited) {
      child.kill("SIGKILL");
      child.unref();
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) child.disconnect();
      throw new RtcSessionError(
        "rtc_cleanup_incomplete",
        "RTC worker exit could not be verified",
        { ...rtc, reason: "cleanup_incomplete", closed: false, partial: true },
        [...files.values()],
      );
    }
    await inputTask;
    if (!response || failure || response.error) await recoverArtifacts(directory, opened, files);
    let issue =
      failure ??
      response?.error ??
      (!response
        ? { code: "rtc_worker_error", message: "RTC worker exited without a final receipt" }
        : undefined);
    rtc = {
      ...rtc,
      closed: true,
      timed_out: stopReason === "timeout" || rtc.timed_out,
      partial: Boolean(issue) || rtc.partial,
      reason: stopReason ?? rtc.reason,
    };
    const finalFiles = [...files.values()].map((file) =>
      rtc.partial ? { ...file, partial: true } : file,
    );
    try {
      const manifest = await writeManifest(directory, {
        rtc,
        files: finalFiles,
      } as unknown as JsonValue);
      finalFiles.push({
        ...(await fileRecord(manifest, { hash: true })),
        mime: "application/json",
        ...(rtc.partial ? { partial: true } : {}),
      });
    } catch (problem) {
      issue ??= {
        code: "rtc_manifest_error",
        message: `Could not finalize RTC manifest: ${errorMessage(problem)}`,
      };
      rtc.partial = true;
      for (const file of finalFiles) file.partial = true;
    }
    if (issue) {
      const logs = [stdoutLogs.finish(), stderrLogs.finish()].filter(Boolean).join("\n");
      const diagnostics = logs ? `; native diagnostics: ${logs}` : "";
      throw new RtcSessionError(
        issue.code,
        redactRtcText(issue.message, options.token) + diagnostics,
        rtc,
        finalFiles,
      );
    }
    return { rtc, files: finalFiles };
  } finally {
    clearTimeout(deadline);
    if (supervisorTimer) clearTimeout(supervisorTimer);
    inputAbort.abort();
    if (termTimer) clearTimeout(termTimer);
    if (killTimer) clearTimeout(killTimer);
    options.signal?.removeEventListener("abort", aborted);
    if (!exited) child.kill("SIGKILL");
  }
}

export async function* readRtcActions(
  input: NodeJS.ReadableStream,
  signal: AbortSignal,
): AsyncGenerator<RtcAction> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 0;
  try {
    for (;;) {
      const chunk = await nextChunk(input, signal);
      if (signal.aborted) return;
      if (chunk === undefined) {
        pending += decoder.end();
        if (pending.trim()) yield parseRtcActionLine(pending, lineNumber + 1);
        return;
      }
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lineNumber += 1;
        if (line.trim()) yield parseRtcActionLine(line, lineNumber);
      }
      if (Buffer.byteLength(pending) > MAX_RTC_LINE_BYTES)
        throw new Error("RTC input line exceeds 1 MiB");
    }
  } finally {
    input.pause();
  }
}

function nextChunk(
  input: NodeJS.ReadableStream,
  signal: AbortSignal,
): Promise<Buffer | string | undefined> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      input.removeListener("data", data);
      input.removeListener("end", end);
      input.removeListener("close", end);
      input.removeListener("error", error);
      signal.removeEventListener("abort", end);
      input.pause();
    };
    const data = (chunk: Buffer | string) => {
      cleanup();
      resolve(chunk);
    };
    const end = () => {
      cleanup();
      resolve(undefined);
    };
    const error = () => {
      cleanup();
      reject(new Error("RTC input stream failed"));
    };
    const state = input as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
    if (signal.aborted || state.readableEnded || state.destroyed) {
      resolve(undefined);
      return;
    }
    input.once("data", data);
    input.once("end", end);
    input.once("close", end);
    input.once("error", error);
    signal.addEventListener("abort", end, { once: true });
    input.resume();
  });
}
