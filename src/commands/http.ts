import { exitCodeForError, validationError } from "../core/errors";
import { envelopeForThrown, runPreparedOperation } from "../core/client";
import { applyPaginationDefaults, type PaginationOptions } from "../core/pagination";
import { estimateCredits } from "../core/budget";
import { loadRegistry } from "../openapi/registry";
import { parseJson } from "../util/json";
import type { AgentInput, Envelope, RunOpts } from "../core/types";
import type { HttpMethod, OperationCard } from "../openapi/types";
import { ExitCode as Codes } from "../core/types";
import { addFiles, addPairs } from "./input";
import { paginationOptionsFromOptions, runOptsFromOptions } from "./options";

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
): Promise<{ env: Envelope; exitCode: Codes }> {
  const env = await runHttp(method, path, options);
  return {
    env,
    exitCode: env.ok ? Codes.Success : exitCodeForError(env.error, env.http?.status ?? undefined),
  };
}

export async function runHttp(
  method: string,
  path: string,
  options: HttpOptions = {},
): Promise<Envelope> {
  const cmd = `elv http ${method.toUpperCase()} ${path}`;
  const parsed = parseHttpInput(method, path, options);
  if (!parsed.ok) return parsed.env;

  let opts: HttpRunOpts;
  try {
    opts = httpRunOpts(options);
  } catch (error) {
    return validationError(cmd, error instanceof Error ? error.message : String(error));
  }

  try {
    const op = await httpOperation(parsed.method, path, parsed.input);
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
    if (options.bodyJson !== undefined) input.body = parseJson(options.bodyJson, "--body-json");
    addFiles(input, options.file);
    return { ok: true, method, input };
  } catch (error) {
    return {
      ok: false,
      env: validationError(cmd, error instanceof Error ? error.message : String(error)),
    };
  }
}

async function httpOperation(
  method: HttpMethod,
  path: string,
  input: AgentInput,
): Promise<OperationCard> {
  const fileFields = Object.keys(input.files ?? {});
  const registryOp = await matchingRegistryOperation(method, path);
  return {
    operationId: "http",
    method,
    pathTemplate: path,
    group: ["http"],
    tags: [],
    risk: registryOp?.risk ?? fallbackRisk(method),
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

async function matchingRegistryOperation(
  method: HttpMethod,
  path: string,
): Promise<OperationCard | undefined> {
  const requestPath = path.split("?", 1)[0] ?? path;
  const registry = await loadRegistry();
  for (const op of registry.values()) {
    if (op.method === method && pathMatchesTemplate(op.pathTemplate, requestPath)) return op;
  }
  return undefined;
}

function pathMatchesTemplate(template: string, path: string): boolean {
  const templateParts = pathParts(template);
  const requestParts = pathParts(path);
  return (
    templateParts.length === requestParts.length &&
    templateParts.every(
      (part, index) => (part.startsWith("{") && part.endsWith("}")) || part === requestParts[index],
    )
  );
}

function pathParts(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function fallbackRisk(method: HttpMethod): OperationCard["risk"] {
  if (method === "GET" || method === "HEAD") return "read";
  if (method === "DELETE") return "destructive";
  return "mutate";
}

function httpRunOpts(options: HttpOptions): HttpRunOpts {
  return {
    ...runOptsFromOptions(options as Record<string, unknown>),
    apiKey: options.apiKey,
    ...paginationOptionsFromOptions(options as Record<string, unknown>),
  };
}

function isHttpMethod(value: string): value is HttpMethod {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(value);
}
