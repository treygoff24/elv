import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { failure } from "./envelope";
import { exitCodeForError, validationError } from "./errors";
import { runOperation } from "./client";
import { ExitCode } from "./types";
import { errorMessage } from "../util/error";
import { parseJson, parseJsonRecord } from "../util/json";
import { readPath } from "../util/jsonpath";
import type { ChildProcess } from "node:child_process";
import type { AgentInput, CommandResult, Envelope, Hint, RunOpts } from "./types";
import type { JsonInputValue, JsonObject } from "../util/json";

export interface WaitOptions extends Pick<RunOpts, "baseUrl" | "profile"> {
  operation?: string;
  json?: string;
  statusPath?: string;
  success?: string;
  failure?: string;
  intervalMs?: string | number;
  timeoutMs?: string | number;
  cmd?: string;
  /** Attached to a wait_timeout envelope so callers re-poll instead of resubmitting. */
  timeoutHints?: Hint[];
}

/** A delay that can be abandoned; `cancel` leaves the promise permanently pending. */
interface CancellableDelay {
  promise: Promise<void>;
  cancel: () => void;
}

interface WaitTimers {
  delay: (ms: number) => CancellableDelay;
}

type WaitSignal = "SIGINT" | "SIGTERM";

interface SignalSource {
  on: (signal: WaitSignal, handler: () => void) => void;
  off: (signal: WaitSignal, handler: () => void) => void;
}

/** Watches for termination so an owned child is reaped instead of orphaned. */
interface Interrupt {
  readonly signal?: WaitSignal;
  readonly promise: Promise<void>;
  onFire: (listener: () => void) => void;
  offFire: (listener: () => void) => void;
  dispose: () => void;
}

interface PollAttempt {
  budgetMs: number;
}

interface ChildRunContext {
  budgetMs: number;
  interrupt: Interrupt;
  timers: WaitTimers;
}

/**
 * One poll attempt. `expired` means the runtime ended the attempt itself because the
 * overall deadline passed, so the envelope (when present) is a diagnostic, not a result.
 */
type RunOutcome =
  | { expired?: undefined; env: Envelope }
  | { expired: "child_terminated" | "poll_abandoned"; env?: Envelope };

interface WaitDeps {
  runOperation?: (
    operationId: string,
    input: AgentInput,
    opts?: Pick<RunOpts, "baseUrl" | "profile" | "signal">,
  ) => Promise<Envelope>;
  runCommand?: (argv: string[], ctx: ChildRunContext) => Promise<RunOutcome>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timers?: WaitTimers;
  signals?: SignalSource;
}

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** SIGTERM -> SIGKILL escalation window for an owned child that ignores termination. */
const CHILD_TERM_GRACE_MS = 250;
/** Hard bound on waiting for a signalled child to close, so the wait always returns. */
const CHILD_REAP_BUDGET_MS = 2 * CHILD_TERM_GRACE_MS;
/** Envelopes are small by contract (large payloads spill to files), so cap what we retain. */
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const WAIT_SIGNALS: WaitSignal[] = ["SIGINT", "SIGTERM"];

type ParsedCommon = {
  statusPath: string;
  success: Set<string>;
  failure: Set<string>;
  intervalMs: number;
  timeoutMs: number;
  timeoutHints: Hint[];
};

type ParsedWait =
  | (ParsedCommon & {
      mode: "operation";
      operation: string;
      input: AgentInput;
      baseUrl?: string;
      profile?: string;
    })
  | (ParsedCommon & {
      mode: "cmd";
      cmd: string[];
    });

interface CappedOutput {
  text: string;
  decoder: StringDecoder;
  bytes: number;
  truncated: boolean;
}

interface ChildRun {
  child: ChildProcess;
  ctx: ChildRunContext;
  stdout: CappedOutput;
  stderr: CappedOutput;
  pending: CancellableDelay[];
  settled: boolean;
  reaped: boolean;
  escalated?: boolean;
  cleaning?: boolean;
  terminated?: "deadline" | "interrupt";
  resolve: (outcome: RunOutcome) => void;
  onInterrupt: () => void;
}

export function waitForOperation(
  options: WaitOptions,
  deps: WaitDeps = {},
): Promise<CommandResult> {
  const result = parseOptions(options);
  if (!result.ok) {
    return Promise.resolve({ env: result.env, exitCode: ExitCode.InputValidation });
  }
  return pollUntilComplete(result.value, waitRuntime(result.value, deps));
}

interface WaitRuntime {
  run: (attempt: PollAttempt, interrupt: Interrupt) => Promise<RunOutcome>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  signals: SignalSource;
}

interface PollObservation {
  env: Envelope;
  status: unknown;
}

function realDelay(ms: number): CancellableDelay {
  let settle: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const handle = setTimeout(settle, Math.max(0, ms));
  return { promise, cancel: () => clearTimeout(handle) };
}

const processSignals: SignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.off(signal, handler);
  },
};

/**
 * Installs SIGINT/SIGTERM listeners for the life of one wait. The first signal is
 * handled here (so the command still emits exactly one envelope) and the listeners are
 * removed immediately, restoring default termination for an impatient second signal.
 */
function watchInterrupt(source: SignalSource): Interrupt {
  const listeners = new Set<() => void>();
  const handlers = new Map<WaitSignal, () => void>();
  let signal: WaitSignal | undefined;
  let fire: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    fire = resolve;
  });

  const dispose = (): void => {
    for (const [name, handler] of handlers) source.off(name, handler);
    handlers.clear();
  };

  for (const name of WAIT_SIGNALS) {
    const handler = (): void => {
      if (signal) return;
      signal = name;
      dispose();
      // One-shot: drain before firing so a listener cannot re-enter this set.
      const firing = Array.from(listeners);
      listeners.clear();
      for (const listener of firing) listener();
      fire();
    };
    handlers.set(name, handler);
    source.on(name, handler);
  }

  return {
    get signal() {
      return signal;
    },
    promise,
    onFire: (listener) => {
      listeners.add(listener);
    },
    offFire: (listener) => {
      listeners.delete(listener);
    },
    dispose,
  };
}

function waitRuntime(parsed: ParsedWait, deps: WaitDeps): WaitRuntime {
  const now = deps.now ?? (() => Date.now());
  const timers = deps.timers ?? { delay: realDelay };
  return {
    run: waitRunner(parsed, deps, timers),
    sleep: deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now,
    deadline: now() + parsed.timeoutMs,
    signals: deps.signals ?? processSignals,
  };
}

function waitRunner(
  parsed: ParsedWait,
  deps: WaitDeps,
  timers: WaitTimers,
): (attempt: PollAttempt, interrupt: Interrupt) => Promise<RunOutcome> {
  if (parsed.mode === "cmd") {
    const run = deps.runCommand ?? runCommand;
    return (attempt, interrupt) =>
      run(parsed.cmd, { budgetMs: attempt.budgetMs, interrupt, timers });
  }
  const run = deps.runOperation ?? runOperation;
  return async (attempt, interrupt) => {
    const controller = new AbortController();
    const bound = timers.delay(attempt.budgetMs);
    const abort = () => controller.abort();
    interrupt.onFire(abort);
    const expired: RunOutcome = { expired: "poll_abandoned" };
    try {
      return await Promise.race<RunOutcome>([
        run(parsed.operation, parsed.input, {
          baseUrl: parsed.baseUrl,
          profile: parsed.profile,
          signal: controller.signal,
        }).then((env) => ({ env })),
        bound.promise.then(() => {
          abort();
          return expired;
        }),
        interrupt.promise.then(() => expired),
      ]);
    } finally {
      bound.cancel();
      interrupt.offFire(abort);
    }
  };
}

async function pollUntilComplete(parsed: ParsedWait, runtime: WaitRuntime): Promise<CommandResult> {
  const interrupt = watchInterrupt(runtime.signals);
  try {
    return await pollLoop(parsed, runtime, interrupt);
  } finally {
    interrupt.dispose();
  }
}

async function pollLoop(
  parsed: ParsedWait,
  runtime: WaitRuntime,
  interrupt: Interrupt,
): Promise<CommandResult> {
  let last: PollObservation | undefined;
  for (;;) {
    if (last && remainingMs(runtime) <= 0) {
      return waitTimeout(parsed, last.status, last.env);
    }
    const attempt: PollAttempt = {
      budgetMs: Math.max(remainingMs(runtime), 1),
    };
    const outcome = await safeRun(runtime.run, attempt, interrupt);
    if (interrupt.signal) {
      return waitInterrupted(parsed, interrupt.signal, outcome.env ?? last?.env);
    }
    if (outcome.expired) {
      // Prefer the child's termination diagnostic; otherwise report the last real poll.
      return waitTimeout(parsed, last?.status, outcome.env ?? last?.env, {
        [outcome.expired]: true,
      });
    }

    const poll = runPoll(parsed, runtime, outcome.env);
    if ("result" in poll) return poll.result;
    last = poll;
    const remaining = remainingMs(runtime);
    if (remaining <= 0) {
      return waitTimeout(parsed, poll.status, poll.env);
    }
    const sleepMs = Math.min(parsed.intervalMs, remaining);
    await Promise.race([runtime.sleep(sleepMs), interrupt.promise]);
    if (interrupt.signal) return waitInterrupted(parsed, interrupt.signal, last.env);
    // Sleeping the whole remaining budget is the deadline by construction. Timers can
    // settle a millisecond before Date.now() agrees, and that rounding must not buy
    // one more poll that the deadline would only expire anyway.
    if (sleepMs === remaining) {
      return waitTimeout(parsed, poll.status, poll.env);
    }
  }
}

function remainingMs(runtime: WaitRuntime): number {
  return runtime.deadline - runtime.now();
}

function runPoll(
  parsed: ParsedWait,
  runtime: WaitRuntime,
  env: Envelope,
): PollObservation | { result: CommandResult } {
  if (!env.ok) {
    return {
      result: { env, exitCode: exitCodeForError(env.error, env.http?.status) },
    };
  }
  return statusObservation(parsed, env, remainingMs(runtime) <= 0);
}

async function safeRun(
  run: WaitRuntime["run"],
  attempt: PollAttempt,
  interrupt: Interrupt,
): Promise<RunOutcome> {
  try {
    return await run(attempt, interrupt);
  } catch (error) {
    return { env: commandEnvelopeError(errorMessage(error)) };
  }
}

function statusObservation(
  parsed: ParsedWait,
  env: Envelope,
  expired: boolean,
): PollObservation | { result: CommandResult } {
  try {
    const status = readPath(env, parsed.statusPath);
    const result = terminalStatusResult(parsed, env, status, expired);
    return result ? { result } : { env, status };
  } catch (error) {
    return {
      result: {
        env: validationError("elv wait", errorMessage(error)),
        exitCode: ExitCode.InputValidation,
      },
    };
  }
}

function terminalStatusResult(
  parsed: ParsedWait,
  env: Envelope,
  status: unknown,
  expired: boolean,
): CommandResult | undefined {
  if (!isScalar(status)) return undefined;
  const value = String(status);
  if (parsed.success.has(value)) {
    // A success observed after the deadline is not a success this wait can report:
    // the caller's budget already expired. Failures stay reportable — they are
    // definitive and more useful than a generic timeout.
    return expired
      ? waitTimeout(parsed, status, env, { late_success: true })
      : { env, exitCode: ExitCode.Success };
  }
  if (parsed.failure.has(value)) return waitFailure(value, env);
  return undefined;
}

function parseOptions(
  options: WaitOptions,
): { ok: true; value: ParsedWait } | { ok: false; env: ReturnType<typeof validationError> } {
  const cmd = "elv wait";
  const statusPath = options.statusPath;
  if (!statusPath) return { ok: false, env: validationError(cmd, "--status-path is required") };
  if (!options.success) return { ok: false, env: validationError(cmd, "--success is required") };
  if (options.cmd && (options.operation || options.json !== undefined)) {
    return {
      ok: false,
      env: validationError(cmd, "--cmd cannot be combined with --operation or --json"),
    };
  }

  try {
    readPath({}, statusPath);
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, errorMessage(error)),
    };
  }

  let common: ParsedCommon;
  try {
    common = {
      statusPath,
      success: csvSet(options.success),
      failure: csvSet(options.failure ?? ""),
      intervalMs: positiveMs(options.intervalMs, DEFAULT_INTERVAL_MS, "--interval-ms"),
      timeoutMs: positiveMs(options.timeoutMs, DEFAULT_TIMEOUT_MS, "--timeout-ms"),
      timeoutHints: options.timeoutHints ?? [],
    };
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, errorMessage(error)),
    };
  }

  if (options.cmd) {
    try {
      const parsed = parseJson(options.cmd, "--cmd");
      if (!isStringArray(parsed)) {
        throw new Error("--cmd must be a JSON string array");
      }
      return { ok: true, value: { mode: "cmd", cmd: parsed, ...common } };
    } catch (error) {
      return {
        ok: false,
        env: validationError(cmd, errorMessage(error)),
      };
    }
  }

  if (!options.operation)
    return { ok: false, env: validationError(cmd, "--operation is required") };
  try {
    const input = options.json === undefined ? {} : parseJsonObject(options.json);
    return {
      ok: true,
      value: {
        mode: "operation",
        operation: options.operation,
        input,
        baseUrl: options.baseUrl,
        profile: options.profile,
        ...common,
      },
    };
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, errorMessage(error)),
    };
  }
}

function waitFailure(status: string, env: Envelope): CommandResult {
  return {
    env: failure({
      cmd: "elv wait",
      operation_id: env.operation_id,
      error: {
        type: "wait_failure",
        code: "wait_failure",
        message: `Operation reached failure status: ${status}`,
        raw: { status, envelope: env },
      },
      retry: { recommended: false, after_ms: null },
    }),
    exitCode: ExitCode.ProviderError,
  };
}

function waitTimeout(
  parsed: ParsedCommon,
  status: unknown,
  env?: Envelope,
  extra?: JsonObject,
): CommandResult {
  return {
    env: failure({
      cmd: "elv wait",
      operation_id: env?.operation_id,
      error: {
        type: "wait_timeout",
        code: "wait_timeout",
        message: `Timed out waiting for ${parsed.statusPath} after ${parsed.timeoutMs}ms`,
        raw: { status: (status ?? null) as JsonInputValue, envelope: env ?? null, ...extra },
      },
      retry: { recommended: true, after_ms: null },
      ...(parsed.timeoutHints.length ? { hints: parsed.timeoutHints } : {}),
    }),
    exitCode: ExitCode.TransientExhausted,
  };
}

/**
 * Exit 7 (transient/retryable) rather than 128+signal: the documented exit-code
 * dictionary in AGENTS.md is the contract agents branch on, and the command still
 * emits exactly one envelope. Any child this wait owned has already been terminated.
 */
function waitInterrupted(parsed: ParsedWait, signal: WaitSignal, env?: Envelope): CommandResult {
  return {
    env: failure({
      cmd: "elv wait",
      operation_id: env?.operation_id,
      error: {
        type: "wait_interrupted",
        code: "wait_interrupted",
        message:
          `Interrupted by ${signal} before ${parsed.statusPath} resolved` +
          (parsed.mode === "cmd" ? "; any child command started by this wait was terminated" : ""),
        raw: { signal, envelope: env ?? null },
      },
      retry: { recommended: false, after_ms: null },
      ...(parsed.timeoutHints.length ? { hints: parsed.timeoutHints } : {}),
    }),
    exitCode: ExitCode.TransientExhausted,
  };
}

function parseJsonObject(raw: string): JsonObject {
  return parseJsonRecord(raw, "--json", "--json must be a JSON object");
}

function csvSet(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function positiveMs(value: string | number | undefined, fallback: number, label: string): number {
  return parseWaitMs(value, label) ?? fallback;
}

/**
 * Validates a millisecond flag without applying a default, so alias commands can
 * reject a bad `--timeout-ms` before they submit a paid create request.
 */
export function parseWaitMs(value: string | number | undefined, label: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return Math.trunc(parsed);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function runCommand(argv: string[], ctx: ChildRunContext): Promise<RunOutcome> {
  const [command, ...args] = argv;
  if (!command) return Promise.reject(new Error("--cmd must not be empty"));
  return new Promise<RunOutcome>((resolve, reject) => {
    startChild(command, args, ctx, resolve, reject);
  });
}

function startChild(
  command: string,
  args: string[],
  ctx: ChildRunContext,
  resolve: (outcome: RunOutcome) => void,
  reject: (reason?: unknown) => void,
): void {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so a stalled child's own children are reaped with it and
    // nothing outside this wait is ever signalled.
    detached: process.platform !== "win32",
  });
  const run: ChildRun = {
    child,
    ctx,
    stdout: emptyOutput(),
    stderr: emptyOutput(),
    pending: [],
    settled: false,
    reaped: false,
    resolve,
    onInterrupt: () => {},
  };

  run.onInterrupt = () => terminateChild(run, "interrupt");
  ctx.interrupt.onFire(run.onInterrupt);
  const deadline = ctx.timers.delay(ctx.budgetMs);
  void deadline.promise.then(() => terminateChild(run, "deadline"));
  run.pending.push(deadline);

  // Keep draining after the cap so the child never blocks on a full pipe.
  child.stdout.on("data", (chunk: Buffer | string) =>
    appendOutput(run.stdout, chunk, MAX_STDOUT_BYTES),
  );
  child.stderr.on("data", (chunk: Buffer | string) =>
    appendOutput(run.stderr, chunk, MAX_STDERR_BYTES),
  );
  child.on("error", (error: Error) => {
    if (run.settled) return;
    run.settled = true;
    cleanupChild(run);
    reject(error);
  });
  child.on("exit", () => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, 0);
        beginGroupCleanup(run);
      } catch {
        /* The owned group is already gone. */
      }
    }
  });
  child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
    run.reaped = true;
    run.stdout.text += run.stdout.decoder.end();
    run.stderr.text += run.stderr.decoder.end();
    settleChild(run, code, signal);
  });
}

function emptyOutput(): CappedOutput {
  return { text: "", decoder: new StringDecoder("utf8"), bytes: 0, truncated: false };
}

function appendOutput(out: CappedOutput, chunk: Buffer | string, cap: number): void {
  if (out.bytes >= cap) {
    out.truncated = true;
    return;
  }
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const room = cap - out.bytes;
  if (buffer.length <= room) {
    out.text += out.decoder.write(buffer);
    out.bytes += buffer.length;
    return;
  }
  out.text += out.decoder.write(buffer.subarray(0, room));
  out.bytes = cap;
  out.truncated = true;
}

/** Terminates only the process group this wait created, then escalates on a fixed grace. */
function terminateChild(run: ChildRun, reason: "deadline" | "interrupt"): void {
  if (run.settled || run.terminated) return;
  run.terminated = reason;
  beginGroupCleanup(run);
}

function beginGroupCleanup(run: ChildRun): void {
  if (run.cleaning || run.settled) return;
  run.cleaning = true;
  signalOwned(run.child, "SIGTERM");
  const escalate = run.ctx.timers.delay(CHILD_TERM_GRACE_MS);
  void escalate.promise.then(() => {
    signalOwned(run.child, "SIGKILL");
    run.escalated = true;
    if (run.reaped) settleChild(run, run.child.exitCode, run.child.signalCode);
  });
  const abandon = run.ctx.timers.delay(CHILD_REAP_BUDGET_MS);
  void abandon.promise.then(() => settleChild(run, null, null));
  run.pending.push(escalate, abandon);
}

function signalOwned(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  const pid = child.pid;
  if (pid === undefined || pid <= 0) return;
  try {
    // Negative pid addresses exactly the group spawned above — never a broader sweep.
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-pid, signal);
  } catch {
    /* The owned group is already gone; never fall back to a potentially reused PID. */
  }
}

function cleanupChild(run: ChildRun): void {
  for (const delay of run.pending) delay.cancel();
  run.pending = [];
  run.ctx.interrupt.offFire(run.onInterrupt);
}

function settleChild(run: ChildRun, code: number | null, signal: NodeJS.Signals | null): void {
  if (run.settled || (run.cleaning && !run.escalated)) return;
  run.settled = true;
  cleanupChild(run);
  run.resolve(childOutcome(run, code, signal));
}

function childOutcome(
  run: ChildRun,
  code: number | null,
  signal: NodeJS.Signals | null,
): RunOutcome {
  if (run.terminated) {
    return {
      expired: "child_terminated",
      env: commandEnvelopeError(
        run.terminated === "deadline"
          ? "Child command exceeded the remaining --timeout-ms and was terminated"
          : "Child command was terminated because the wait was interrupted",
        childDiagnostics(run, code, signal),
      ),
    };
  }
  try {
    if (run.stdout.truncated) throw new Error("Truncated stdout");
    return { env: parseJson(run.stdout.text.trim(), "command stdout") as unknown as Envelope };
  } catch {
    return {
      env: commandEnvelopeError(
        "Command did not emit a JSON envelope",
        childDiagnostics(run, code, signal),
      ),
    };
  }
}

function childDiagnostics(
  run: ChildRun,
  code: number | null,
  signal: NodeJS.Signals | null,
): JsonObject {
  return {
    exit_code: code,
    signal: signal ?? null,
    terminated: run.terminated ?? null,
    reaped: run.reaped,
    stdout: preview(run.stdout.text),
    stderr: preview(run.stderr.text),
    stdout_truncated: run.stdout.truncated,
    stderr_truncated: run.stderr.truncated,
  };
}

function commandEnvelopeError(message: string, raw?: JsonInputValue): Envelope {
  return failure({
    cmd: "elv wait",
    error: {
      type: "runtime_error",
      code: "command_output_invalid",
      message,
      raw,
    },
    retry: { recommended: false, after_ms: null },
  });
}

function preview(value: string): string {
  const text = value.trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
