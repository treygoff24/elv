import { setTimeout as delay } from "node:timers/promises";
import { normalizeProviderError } from "./error-normalizer";
import type { HttpRequest } from "./request-builder";
import type { JsonValue } from "../util/json";
import type { NormalizedError, RetryInfo } from "./types";
import type { OperationCard } from "../openapi/types";

interface RetryContext {
  signal?: AbortSignal;
  retryPost?: boolean;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  /** Test seam: cap on the 429 error body read (default {@link ERROR_BODY_MAX_BYTES}). */
  errorBodyMaxBytes?: number;
  /** Test seam: stall budget for that read (default {@link ERROR_BODY_TIMEOUT_MS}). */
  errorBodyTimeoutMs?: number;
}

export const DEFAULT_RETRY_ATTEMPTS = 3;

/**
 * A provider error envelope is a few hundred bytes. Reading a retryable 429 body must be
 * bounded in both directions: a stream that never ends and a stream that never advances
 * are both possible from a load balancer under pressure, and either one would otherwise
 * park `sendWithRetry` forever.
 */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
const ERROR_BODY_TIMEOUT_MS = 2_000;

export class NetworkRetryError extends Error {
  readonly normalizedError: NormalizedError;
  readonly retry: RetryInfo;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "NetworkRetryError";
    this.normalizedError = {
      type: "network_error",
      code: "internal_error",
      message: this.message,
      raw: cause,
    };
    this.retry = { recommended: true, after_ms: null };
  }
}

const NEVER_RETRY = new Set([400, 401, 402, 403, 404, 409, 422]);
const RETRY_HTTP = new Set([429, 500, 502, 503, 504]);
const CONCURRENT_429 = new Set(["concurrent_limit_exceeded", "too_many_concurrent_requests"]);
const REDIRECT_HTTP = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export async function sendWithRetry(
  req: HttpRequest,
  _op: OperationCard,
  ctx: RetryContext = {},
): Promise<Response> {
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_RETRY_ATTEMPTS;
  const sleep = ctx.sleep ?? ((ms: number) => delay(ms, undefined, { signal: ctx.signal }));
  const jitter = ctx.jitter ?? (() => Math.floor(Math.random() * 100));
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      ctx.signal?.throwIfAborted();
      const res = await fetchSameOrigin(req, ctx.signal);
      const decision = await retryDecision(res, req, ctx, attempt, maxAttempts, jitter);
      // The returned response is the caller's to read; only an abandoned one is disposed,
      // and it is disposed before the backoff so the socket is not held across the sleep.
      if (!decision.retry) return res;
      await disposeBody(res);
      await sleep(decision.afterMs);
    } catch (error) {
      ctx.signal?.throwIfAborted();
      lastNetworkError = error;
      if (!methodCanRetry(req, ctx) || attempt >= maxAttempts) break;
      await sleep(backoffMs(attempt, undefined, jitter));
    }
  }

  throw new NetworkRetryError(lastNetworkError);
}

async function fetchSameOrigin(req: HttpRequest, signal?: AbortSignal): Promise<Response> {
  const origin = new URL(req.url).origin;
  let url = req.url;
  let method = req.method;
  let body = req.body as RequestInit["body"];
  let headers = req.headers;

  for (let redirects = 0; ; redirects += 1) {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal,
      ...(req.duplex ? { duplex: req.duplex } : {}),
    } as RequestInit & { duplex?: "half" });
    if (!REDIRECT_HTTP.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    if (redirects >= MAX_REDIRECTS) {
      await disposeBody(res);
      throw new Error(`Too many redirects from ${req.url}`);
    }

    const next = new URL(location, url);
    if (next.origin !== origin) {
      await disposeBody(res);
      throw new Error(`Refusing cross-origin redirect from ${origin} to ${next.origin}`);
    }
    await disposeBody(res);

    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      headers = { ...headers };
      delete headers["content-type"];
    }
    url = next.href;
  }
}

async function retryDecision(
  res: Response,
  req: HttpRequest,
  ctx: RetryContext,
  attempt: number,
  maxAttempts: number,
  jitter: () => number,
): Promise<{ retry: false } | { retry: true; afterMs: number }> {
  if (NEVER_RETRY.has(res.status)) return { retry: false };
  if (!RETRY_HTTP.has(res.status)) return { retry: false };
  if (!methodCanRetry(req, ctx)) return { retry: false };
  if (attempt >= maxAttempts) return { retry: false };

  // Past this point the response is always abandoned, so its body can be consumed
  // directly. Cloning would tee the stream and leave the untouched branch buffering the
  // whole body in memory, with no bound on an endless one.
  const retryAfter = retryAfterMs(res.headers);
  if (res.status === 429) {
    const code = await responseCode(res, ctx);
    if (CONCURRENT_429.has(code)) {
      return { retry: true, afterMs: retryAfter ?? 250 };
    }
    return { retry: true, afterMs: backoffMs(attempt, retryAfter, jitter) };
  }

  return { retry: true, afterMs: backoffMs(attempt, retryAfter, jitter) };
}

function methodCanRetry(req: HttpRequest, ctx: RetryContext): boolean {
  return (
    req.method === "GET" ||
    req.method === "HEAD" ||
    (req.method === "POST" && Boolean(ctx.retryPost))
  );
}

async function responseCode(res: Response, ctx: RetryContext): Promise<string> {
  const text = await readBoundedBody(
    res,
    ctx.errorBodyMaxBytes ?? ERROR_BODY_MAX_BYTES,
    ctx.errorBodyTimeoutMs ?? ERROR_BODY_TIMEOUT_MS,
  );
  if (text === null) return "";
  try {
    const body = JSON.parse(text) as JsonValue;
    return normalizeProviderError(body, res.status, res.headers).code;
  } catch {
    return "";
  }
}

/**
 * Reads at most `maxBytes` of a body within one total `timeoutMs` deadline,
 * and always cancels the stream afterwards. Returns null when the body is
 * absent, oversized, stalled, or errored — every one of which means "no usable error
 * code", not "wait".
 */
async function readBoundedBody(
  res: Response,
  maxBytes: number,
  timeoutMs: number,
): Promise<string | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await withTimeout(reader.read(), remaining);
      if (chunk === null || chunk.done) {
        complete = chunk !== null;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) break;
      chunks.push(chunk.value);
    }
  } catch {
    return null;
  } finally {
    await cancelReader(reader, Math.max(0, deadline - Date.now()));
  }
  return complete ? Buffer.concat(chunks).toString("utf8") : null;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  budgetMs: number,
): Promise<void> {
  try {
    await withTimeout(reader.cancel(), budgetMs);
  } catch {
    // Already closed or errored; the stream needs no further disposal.
  }
  try {
    reader.releaseLock();
  } catch {
    // Cancel already released it.
  }
}

/** Releases an abandoned response's socket. Safe on a body already read or cancelled. */
async function disposeBody(res: Response): Promise<void> {
  const body = res.body;
  if (!body || res.bodyUsed || body.locked) return;
  try {
    await withTimeout(body.cancel(), ERROR_BODY_TIMEOUT_MS);
  } catch {
    // A body that cannot be cancelled is already finished with.
  }
}

function backoffMs(
  attempt: number,
  retryAfter: number | null | undefined,
  jitter: () => number,
): number {
  return retryAfter ?? 500 * 2 ** (attempt - 1) + jitter();
}

export function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}
