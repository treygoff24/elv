import { normalizeProviderError } from "./error-normalizer";
import type { HttpRequest } from "./request-builder";
import type { NormalizedError, RetryInfo } from "./types";
import type { OperationCard } from "../openapi/types";

interface RetryContext {
  retryPost?: boolean;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
}

export const DEFAULT_RETRY_ATTEMPTS = 3;

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
  const sleep = ctx.sleep ?? defaultSleep;
  const jitter = ctx.jitter ?? (() => Math.floor(Math.random() * 100));
  let lastNetworkError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetchSameOrigin(req);
      const decision = await retryDecision(res, req, ctx, attempt, maxAttempts, jitter);
      if (!decision.retry) return res;
      await sleep(decision.afterMs);
    } catch (error) {
      lastNetworkError = error;
      if (!methodCanRetry(req, ctx) || attempt >= maxAttempts) break;
      await sleep(backoffMs(attempt, undefined, jitter));
    }
  }

  throw new NetworkRetryError(lastNetworkError);
}

async function fetchSameOrigin(req: HttpRequest): Promise<Response> {
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
      ...(req.duplex ? { duplex: req.duplex } : {}),
    } as RequestInit & { duplex?: "half" });
    if (!REDIRECT_HTTP.has(res.status)) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    if (redirects >= MAX_REDIRECTS) {
      await res.body?.cancel();
      throw new Error(`Too many redirects from ${req.url}`);
    }

    const next = new URL(location, url);
    if (next.origin !== origin) {
      await res.body?.cancel();
      throw new Error(`Refusing cross-origin redirect from ${origin} to ${next.origin}`);
    }
    await res.body?.cancel();

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

  const retryAfter = retryAfterMs(res.headers);
  if (res.status === 429) {
    const code = await responseCode(res);
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

async function responseCode(res: Response): Promise<string> {
  try {
    const body = await res.clone().json();
    return normalizeProviderError(body, res.status, res.headers).code;
  } catch {
    return "";
  }
}

function backoffMs(attempt: number, retryAfter: number | undefined, jitter: () => number): number {
  return retryAfter ?? 500 * 2 ** (attempt - 1) + jitter();
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
