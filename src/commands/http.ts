import { emitAndExit, exitCodeForError, validationError } from "../core/errors";
import { envelopeForThrown, runPreparedOperation } from "../core/client";
import { applyPaginationDefaults, type PaginationOptions } from "../core/pagination";
import { estimateCredits } from "../core/budget";
import type { AgentInput, Envelope, HttpMethod, OperationCard, RunOpts } from "../core/types";
import { ExitCode as Codes } from "../core/types";
import { addFiles, addPairs } from "./input";

export interface HttpOptions {
  query?: string[];
  bodyJson?: string;
  file?: string[];
  out?: RunOpts["out"];
  saveJson?: PaginationOptions["saveJson"];
  all?: PaginationOptions["all"];
  limit?: string | number;
  dryRun?: RunOpts["dryRun"];
  retryPost?: RunOpts["retryPost"];
  hash?: RunOpts["hash"];
  baseUrl?: RunOpts["baseUrl"];
  apiKey?: RunOpts["apiKey"];
  profile?: RunOpts["profile"];
  maxCredits?: string | number;
  yes?: RunOpts["yes"];
}

type HttpRunOpts = RunOpts & Omit<PaginationOptions, "limit"> & { limit?: number };

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
    const opts = httpRunOpts(options);
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      return validationError(cmd, "--limit must be a positive integer", {
        operationId: op.operationId,
      });
    }
    const input = applyPaginationDefaults(op, parsed.input, opts.limit ?? 20);

    return runPreparedOperation({
      cmd,
      op,
      input,
      opts,
      command: { kind: "http", method: op.method, path },
      dryRunRequest: { method: op.method, path, input },
      creditsEstimated: await estimateCredits(op, input, opts),
      requestPath: path,
      method: op.method,
    });
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
    const input: AgentInput & Record<string, unknown> = {};
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

function httpRunOpts(options: HttpOptions): HttpRunOpts {
  const limit =
    options.limit === undefined || options.limit === "" ? undefined : Number(options.limit);
  const maxCredits =
    options.maxCredits === undefined || options.maxCredits === ""
      ? undefined
      : Number(options.maxCredits);
  return {
    dryRun: options.dryRun,
    retryPost: options.retryPost,
    hash: options.hash,
    out: options.out,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    profile: options.profile,
    maxCredits: Number.isFinite(maxCredits) ? maxCredits : undefined,
    yes: options.yes,
    saveJson: options.saveJson,
    all: options.all,
    // Raw parsed number; runOperation/runHttp validate it (positive integer) so all
    // call/http/alias paths reject an invalid --limit identically.
    limit,
  };
}

function isHttpMethod(value: string): value is HttpMethod {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(value);
}
