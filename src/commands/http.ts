import { exitCodeForError, validationError } from "../core/errors";
import { envelopeForThrown, runPreparedOperation } from "../core/client";
import { InputNormalizationError } from "../core/request-builder";
import { applyPaginationDefaults, type PaginationOptions } from "../core/pagination";
import { estimateCredits } from "../core/budget";
import { loadRegistry } from "../openapi/registry";
import { classifyRisk } from "../openapi/risk";
import { parseJson } from "../util/json";
import type { AgentInput, CommandResult, Envelope, RunOpts, Warning } from "../core/types";
import type { HttpMethod, OperationCard } from "../openapi/types";
import { ExitCode as Codes } from "../core/types";
import { addFiles, addPairs } from "./input";
import { paginationOptionsFromOptions, runOptsFromOptions } from "./options";
import type { PaginationOptionValues, RunOptionValues } from "./options";

interface HttpOptions extends RunOptionValues, PaginationOptionValues, Pick<RunOpts, "apiKey"> {
  query?: string[];
  bodyJson?: string;
  file?: string[];
}

type HttpRunOpts = RunOpts & PaginationOptions;

export async function handleHttp(
  method: string,
  path: string,
  options: HttpOptions,
): Promise<CommandResult> {
  const env = await runHttp(method, path, options);
  return {
    env,
    exitCode: env.ok ? Codes.Success : exitCodeForError(env.error, env.http?.status),
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
    const { op, metadataWarning } = await httpOperation(parsed.method, path, parsed.input);
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      return validationError(cmd, "--limit must be a positive integer", {
        operationId: op.operationId,
      });
    }
    const input = applyPaginationDefaults(op, parsed.input, opts.limit ?? 20);

    return await runPreparedOperation({
      cmd,
      op,
      input,
      opts,
      command: { kind: "http", method: op.method, path },
      dryRunRequest: { method: op.method, path, input },
      creditsEstimated: await estimateCredits(op, input, opts),
      warnings: [metadataWarning],
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
    return {
      ok: false,
      env: validationError(cmd, `Unsupported HTTP method: ${methodRaw}`),
    };
  if (!path.startsWith("/"))
    return {
      ok: false,
      env: validationError(cmd, "HTTP path must start with /"),
    };

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
): Promise<{ op: OperationCard; metadataWarning: Warning }> {
  const fileFields = Object.keys(input.files ?? {});
  const registryOp = await matchingRegistryOperation(method, path);
  if (registryOp) {
    return {
      op: {
        ...registryOp,
        pathTemplate: path,
        requestBody: requestBodyForRawInput(registryOp.requestBody, input, fileFields),
      },
      metadataWarning: {
        code: "http_metadata_matched",
        message: `HTTP metadata matched registry operation ${registryOp.operationId}.`,
      },
    };
  }
  return {
    op: {
      operationId: "http",
      method,
      pathTemplate: path,
      group: ["http"],
      tags: [],
      risk: fallbackRisk(method, path),
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
    },
    metadataWarning: {
      code: "http_metadata_inferred",
      message: "HTTP metadata was inferred because no registry operation matched the request path.",
    },
  };
}

async function matchingRegistryOperation(
  method: HttpMethod,
  path: string,
): Promise<OperationCard | undefined> {
  const requestPath = path.replace(/\?.*$/u, "");
  const registry = await loadRegistry();
  const candidates = [...registry.values()]
    .filter((op) => op.method === method && pathMatchesTemplate(op.pathTemplate, requestPath))
    .map((op) => ({ op, rank: pathSpecificity(op.pathTemplate, requestPath) }))
    .sort(compareMatches);
  const best = candidates[0];
  if (!best) return undefined;

  const equallySpecific = candidates.filter((candidate) => sameRank(candidate.rank, best.rank));
  if (new Set(equallySpecific.map(({ op }) => safetyMetadata(op))).size > 1) {
    throw new InputNormalizationError(`Ambiguous HTTP metadata for ${method} ${requestPath}`, {
      operations: equallySpecific.map(({ op }) => op.operationId).sort(),
    });
  }
  return best.op;
}

interface PathSpecificity {
  exact: boolean;
  literals: number;
  parameters: number;
}

interface RankedMatch {
  op: OperationCard;
  rank: PathSpecificity;
}

function pathSpecificity(template: string, requestPath: string): PathSpecificity {
  const parts = pathParts(template);
  const parameters = parts.filter(isTemplateParameter).length;
  return {
    exact: template === requestPath,
    literals: parts.length - parameters,
    parameters,
  };
}

function compareMatches(left: RankedMatch, right: RankedMatch): number {
  return (
    Number(right.rank.exact) - Number(left.rank.exact) ||
    right.rank.literals - left.rank.literals ||
    left.rank.parameters - right.rank.parameters ||
    left.op.operationId.localeCompare(right.op.operationId)
  );
}

function sameRank(left: PathSpecificity, right: PathSpecificity): boolean {
  return (
    left.exact === right.exact &&
    left.literals === right.literals &&
    left.parameters === right.parameters
  );
}

function safetyMetadata(op: OperationCard): string {
  return JSON.stringify({
    risk: op.risk,
    costHint: op.costHint ?? "unknown",
    streamKind: op.streamKind,
    returnsBinary: op.returnsBinary,
    returnsJson: op.returnsJson,
    secretResult: op.secretResult ?? false,
  });
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

function isTemplateParameter(part: string): boolean {
  return part.startsWith("{") && part.endsWith("}");
}

function requestBodyForRawInput(
  matched: OperationCard["requestBody"],
  input: AgentInput,
  fileFields: string[],
): OperationCard["requestBody"] {
  if (fileFields.length > 0) {
    return {
      ...matched,
      contentType: "multipart/form-data",
      required: matched?.required ?? false,
      multipart: true,
      fileFields: [...new Set([...(matched?.fileFields ?? []), ...fileFields])],
    };
  }
  if (matched) return matched;
  return input.body === undefined
    ? undefined
    : { contentType: "application/json", required: false, multipart: false };
}

function fallbackRisk(method: HttpMethod, path: string): OperationCard["risk"] {
  return classifyRisk({ operationId: "http", method, pathTemplate: path });
}

function httpRunOpts(options: HttpOptions): HttpRunOpts {
  return {
    ...runOptsFromOptions(options),
    apiKey: options.apiKey,
    ...paginationOptionsFromOptions(options),
  };
}

function isHttpMethod(value: string): value is HttpMethod {
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(value);
}
