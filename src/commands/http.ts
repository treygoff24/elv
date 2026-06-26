import { resolve } from "node:path";
import { emitAndExit, exitCodeForError, validationError } from "../core/errors";
import { dryRun } from "../core/envelope";
import { getApiKey, loadConfig } from "../core/config";
import { envelopeForThrown, sendAndNormalize } from "../core/client";
import { spillIfLarge } from "../core/response-normalizer";
import {
  addPaginationToEnvelope,
  allOutputTarget,
  applyPaginationDefaults,
  collectAllPages,
  supportsPagination,
} from "../core/pagination";
import { buildHttpRequest } from "../core/request-builder";
import { estimateCredits } from "../core/budget";
import type { AgentInput, Envelope, HttpMethod, OperationCard, RunOpts } from "../core/types";
import { ExitCode as Codes } from "../core/types";

export interface HttpOptions {
  query?: string[];
  bodyJson?: string;
  file?: string[];
  out?: string;
  saveJson?: string;
  all?: boolean;
  limit?: string | number;
  dryRun?: boolean;
  retryPost?: boolean;
  hash?: boolean;
  baseUrl?: string;
  apiKey?: string;
  profile?: string;
}

type HttpRunOpts = RunOpts & { saveJson?: string; all?: boolean; limit?: number };

export async function handleHttp(
  method: string,
  path: string,
  options: HttpOptions,
): Promise<never> {
  const env = await runHttp(method, path, options);
  emitAndExit(
    env,
    env.ok ? Codes.Success : exitCodeForError(env.error, env.http?.status ?? undefined),
  );
}

export async function runHttp(
  method: string,
  path: string,
  options: HttpOptions = {},
): Promise<Envelope> {
  const cmd = `elv http ${method.toUpperCase()} ${path}`;
  const parsed = parseHttpInput(method, path, options);
  if (!parsed.ok) return parsed.env;

  try {
    const op = httpOperation(parsed.method, path, parsed.input);
    const opts = runOpts(options);
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      return validationError(cmd, "--limit must be a positive integer", {
        operationId: op.operationId,
      });
    }
    const input = applyPaginationDefaults(op, parsed.input, opts.limit ?? 20);

    if (opts.all && !allOutputTarget(opts)) {
      return validationError(cmd, "--all requires --save-json or --out", {
        operationId: op.operationId,
      });
    }

    const config = loadConfig({
      profile: opts.profile,
      baseUrl: opts.baseUrl,
      maxCredits: opts.maxCredits,
    });
    const requestContext = {
      baseUrl: opts.baseUrl ?? config.baseUrl,
      apiKey: opts.apiKey ?? getApiKey({ profile: opts.profile }),
    };
    const makeRequest = (nextInput: AgentInput) => buildHttpRequest(op, nextInput, requestContext);

    if (opts.dryRun) {
      return dryRun({
        cmd,
        operationId: op.operationId,
        request: { method: op.method, path, input },
        creditsEstimated: await estimateCredits(op, input, opts),
      });
    }

    if (opts.all) {
      return collectAllPages({
        op,
        input,
        out: opts.out,
        saveJson: opts.saveJson,
        hash: opts.hash,
        limit: opts.limit,
        command: { kind: "http", method: op.method, path },
        fetchPage: async (pageInput) =>
          sendAndNormalize(await makeRequest(pageInput), op, {
            cmd,
            out: opts.out ?? config.outputDir,
            hash: opts.hash,
            retryPost: opts.retryPost,
            requestPath: path,
            method: op.method,
          }),
      });
    }

    const isPaginated = supportsPagination(op);
    const env = await sendAndNormalize(await makeRequest(input), op, {
      cmd,
      out: opts.out ?? config.outputDir,
      hash: opts.hash,
      retryPost: opts.retryPost,
      requestPath: path,
      method: op.method,
      // Normalize inline so pagination sees the data (computes `next`) or so --save-json
      // can write the full result; spillIfLarge spills/saves afterward.
      inline: isPaginated || opts.saveJson !== undefined,
    });
    const paginatedEnv = addPaginationToEnvelope(env, op, input, {
      command: { kind: "http", method: op.method, path },
      limit: opts.limit,
    });
    return isPaginated || opts.saveJson !== undefined
      ? await spillIfLarge(op, paginatedEnv, {
          cmd,
          out: opts.out ?? config.outputDir,
          saveJson: opts.saveJson,
          hash: opts.hash,
        })
      : paginatedEnv;
  } catch (error) {
    return envelopeForThrown(cmd, "http", error);
  }
}

function parseHttpInput(
  methodRaw: string,
  path: string,
  options: HttpOptions,
):
  | { ok: true; method: HttpMethod; input: AgentInput }
  | { ok: false; env: ReturnType<typeof validationError> } {
  const cmd = `elv http ${methodRaw} ${path}`;
  const method = methodRaw.toUpperCase();
  if (!isHttpMethod(method))
    return { ok: false, env: validationError(cmd, `Unsupported HTTP method: ${methodRaw}`) };
  if (!path.startsWith("/"))
    return { ok: false, env: validationError(cmd, "HTTP path must start with /") };

  try {
    const input: AgentInput = {};
    addPairs(input, "query", options.query);
    if (options.bodyJson !== undefined) input.body = JSON.parse(options.bodyJson) as unknown;
    addFiles(input, options.file);
    return { ok: true, method, input };
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }
}

function httpOperation(method: HttpMethod, path: string, input: AgentInput): OperationCard {
  const fileFields = Object.keys(input.files ?? {});
  return {
    operationId: "http",
    method,
    pathTemplate: path,
    group: ["http"],
    tags: [],
    risk:
      method === "GET" || method === "HEAD"
        ? "read"
        : method === "DELETE"
          ? "destructive"
          : "mutate",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody:
      input.body !== undefined || fileFields.length > 0
        ? {
            contentType: fileFields.length > 0 ? "multipart/form-data" : "application/json",
            required: false,
            multipart: fileFields.length > 0,
            fileFields,
          }
        : undefined,
    responses: [],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
  };
}

function runOpts(options: HttpOptions): HttpRunOpts {
  const limit =
    options.limit === undefined || options.limit === "" ? undefined : Number(options.limit);
  return {
    dryRun: options.dryRun,
    retryPost: options.retryPost,
    hash: options.hash,
    out: options.out,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    profile: options.profile,
    saveJson: options.saveJson,
    all: options.all,
    // Raw parsed number; runOperation/runHttp validate it (positive integer) so all
    // call/http/alias paths reject an invalid --limit identically.
    limit,
  };
}

function addPairs(input: AgentInput, bucket: "query", pairs: string[] | undefined): void {
  if (!pairs || pairs.length === 0) return;
  const current = input[bucket] ?? {};
  input[bucket] = current;
  for (const pair of pairs) {
    const { key, value } = parsePair(pair);
    current[key] = value;
  }
}

function addFiles(input: AgentInput, files: string[] | undefined): void {
  if (!files || files.length === 0) return;
  const current: Record<string, string | string[]> = input.files ?? {};
  input.files = current;
  for (const file of files) {
    const { key, value } = parsePair(file);
    const field = key.endsWith("[]") ? key.slice(0, -2) : key;
    const path = resolve(value);
    if (key.endsWith("[]")) {
      const previous = current[field];
      current[field] = Array.isArray(previous)
        ? [...previous, path]
        : previous
          ? [previous, path]
          : [path];
    } else {
      current[field] = path;
    }
  }
}

function parsePair(pair: string): { key: string; value: string } {
  const index = pair.indexOf("=");
  if (index <= 0) throw new Error(`Expected key=value, got "${pair}"`);
  return { key: pair.slice(0, index), value: pair.slice(index + 1) };
}

function isHttpMethod(value: string): value is HttpMethod {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(value);
}
