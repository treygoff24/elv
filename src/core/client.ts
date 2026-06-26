import { loadRegistry, readRegistryCache } from "../openapi/registry";
import { estimateDetail, overBudget } from "./budget";
import { loadConfig, getApiKey } from "./config";
import { dryRun, failure } from "./envelope";
import {
  budgetExceeded,
  confirmationRequired,
  hintsForError,
  mergeErrorHints,
  validationError,
  unknownOperation,
} from "./errors";
import { NetworkRetryError, sendWithRetry } from "./retries";
import { buildHttpRequest, InputNormalizationError, normalizeInput } from "./request-builder";
import { normalizeResponse, spillIfLarge } from "./response-normalizer";
import {
  addPaginationToEnvelope,
  allOutputTarget,
  applyPaginationDefaults,
  collectAllPages,
  supportsPagination,
  type PaginationOptions,
} from "./pagination";
import { requiresYes } from "./safety";
import { OutTargetError } from "./files";
import type { AnySchema, ValidateFunction } from "ajv";
import type {
  AgentInput,
  Envelope,
  NormalizedError,
  OperationCard,
  RunOpts,
  Warning,
} from "./types";
import type { HttpRequest } from "./request-builder";
import type { ResponseContext } from "./response-normalizer";

const OPENAPI_SCHEMA_BASE = "elv://openapi";

type OperationRunOpts = RunOpts & PaginationOptions & { inline?: boolean };

export async function runOperation(
  operationId: string,
  input: AgentInput | Record<string, unknown>,
  opts: OperationRunOpts = {},
): Promise<Envelope> {
  const cmd = `elv call ${operationId}`;
  try {
    const registry = await loadRegistry();
    const cached = readRegistryCache();
    const baseOp = registry.get(operationId);
    if (!baseOp) return unknownOperation(operationId);
    const op = hydrateBodySchema(baseOp, cached?.bundledSpec);

    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      return validationError(cmd, "--limit must be a positive integer", { operationId });
    }

    const normalized = applyPaginationDefaults(
      op,
      normalizeInput(op, input, { allowUnknown: opts.allowUnknown }),
      opts.limit ?? 20,
    );
    const validation = await validateInput(op, normalized, cached?.bundledSpec);
    if (validation)
      return validationError(cmd, validation.message, {
        operationId,
        param: validation.param,
        raw: validation.raw,
      });

    const { credits: estimate, warnings: estimateWarnings } = await estimateDetail(
      op,
      normalized,
      opts,
    );
    if (opts.dryRun) {
      return withWarnings(
        dryRun({
          cmd,
          operationId,
          request: {
            operation_id: operationId,
            method: op.method,
            path: op.pathTemplate,
            input: normalized,
          },
          creditsEstimated: estimate,
          wouldRequireYes: requiresYes(op),
          wouldExceedBudget: overBudget(estimate, opts),
        }),
        estimateWarnings,
      );
    }

    if (requiresYes(op) && !opts.yes) {
      return confirmationRequired(cmd, `${operationId} (${op.risk}) requires --yes`, {
        operationId,
      });
    }
    if (overBudget(estimate, opts)) {
      return budgetExceeded(cmd, estimate, opts.maxCredits as number, { operationId });
    }

    const config = loadConfig({
      profile: opts.profile,
      baseUrl: opts.baseUrl,
      maxCredits: opts.maxCredits,
    });
    if (opts.all && !allOutputTarget(opts)) {
      return validationError(cmd, "--all requires --save-json or --out", { operationId });
    }

    const requestContext = {
      baseUrl: opts.baseUrl ?? config.baseUrl,
      apiKey: opts.apiKey ?? getApiKey({ profile: opts.profile }),
    };
    const makeRequest = (nextInput: AgentInput) => buildHttpRequest(op, nextInput, requestContext);

    const isPaginated = supportsPagination(op);

    if (opts.all) {
      return collectAllPages({
        op,
        input: normalized,
        out: opts.out,
        saveJson: opts.saveJson,
        hash: opts.hash,
        limit: opts.limit,
        command: { kind: "call" },
        // Force inline so each page's items and cursor are visible to the collector;
        // collectAllPages writes the combined set to the --save-json/--out file itself.
        fetchPage: async (pageInput) =>
          sendAndNormalize(await makeRequest(pageInput), op, {
            cmd,
            out: opts.out ?? config.outputDir,
            hash: opts.hash,
            creditsEstimated: estimate,
            retryPost: opts.retryPost,
            inline: true,
          }),
      });
    }

    const req = await makeRequest(normalized);
    const env = await sendAndNormalize(req, op, {
      cmd,
      out: opts.out ?? config.outputDir,
      hash: opts.hash,
      creditsEstimated: estimate,
      retryPost: opts.retryPost,
      requestPath: req.path,
      method: req.method,
      // Normalize inline when we need the data downstream: paginated ops so
      // addPaginationToEnvelope can compute `next`/truncate, or --save-json so the full
      // result can be written. spillIfLarge then spills/saves below as needed.
      inline: opts.inline || isPaginated || opts.saveJson !== undefined,
    });
    const paginatedEnv = addPaginationToEnvelope(env, op, normalized, {
      command: { kind: "call" },
      limit: opts.limit,
    });
    const finalEnv =
      (isPaginated || opts.saveJson !== undefined) && !opts.inline
        ? await spillIfLarge(op, paginatedEnv, {
            cmd,
            out: opts.out ?? config.outputDir,
            saveJson: opts.saveJson,
            hash: opts.hash,
          })
        : paginatedEnv;
    return withWarnings(finalEnv, estimateWarnings);
  } catch (error) {
    return envelopeForThrown(cmd, operationId, error);
  }
}

function withWarnings(env: Envelope, warnings: Warning[]): Envelope {
  if (!env.ok || warnings.length === 0) return env;
  return { ...env, warnings: [...(env.warnings ?? []), ...warnings] };
}

export interface SendAndNormalizeContext extends ResponseContext {
  retryPost?: boolean;
}

export async function sendAndNormalize(
  req: HttpRequest,
  op: OperationCard,
  ctx: SendAndNormalizeContext,
): Promise<Envelope> {
  const res = await sendWithRetry(req, op, { retryPost: ctx.retryPost });
  return normalizeResponse(op, res, ctx);
}

async function validateInput(
  op: OperationCard,
  input: AgentInput,
  bundledSpec: unknown,
): Promise<NormalizedError | null> {
  for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
    if (!param.required) continue;
    const bucket = param.location === "header" ? input.headers : input[param.location];
    if (bucket?.[param.name] === undefined) {
      return {
        type: "validation_error",
        code: "validation_error",
        message: `${param.location}: missing required parameter ${param.name}`,
        param: param.name,
        raw: { location: param.location, name: param.name },
      };
    }
  }

  if (!op.requestBody) return null;
  if (!bundledSpec && op.requestBody.schemaRef) return null;
  if (op.requestBody.required && !hasRequestPayload(op, input)) {
    return {
      type: "validation_error",
      code: "validation_error",
      message: "body: request body is required",
      param: "body",
      raw: {},
    };
  }

  const validator = await getInputValidatorForOperation(op, bundledSpec ?? minimalSpec());
  if (!validator) return null;
  if (validator(validationBody(op, input))) return null;

  const first = validator.errors?.[0];
  const param = ajvParam(first?.instancePath, first?.params);
  return {
    type: "validation_error",
    code: "validation_error",
    message: `body: ${first?.message ?? "invalid request body"}`,
    param,
    raw: validator.errors,
  };
}

function hasRequestPayload(op: OperationCard, input: AgentInput): boolean {
  if (!op.requestBody?.multipart) return input.body !== undefined;
  return input.body !== undefined || Object.keys(input.files ?? {}).length > 0;
}

function validationBody(op: OperationCard, input: AgentInput): unknown {
  if (!op.requestBody?.multipart) return input.body ?? {};
  const props = asRecord(asRecord(op.requestBody.schema).properties);
  const files = Object.fromEntries(
    Object.entries(input.files ?? {}).map(([key, value]) => [
      key,
      asRecord(props[key]).type === "array" && !Array.isArray(value) ? [value] : value,
    ]),
  );
  return { ...asRecord(input.body), ...files };
}

async function getInputValidatorForOperation(
  op: OperationCard,
  bundledSpec: unknown,
): Promise<ValidateFunction | null> {
  const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
    import("ajv/dist/2020.js"),
    import("ajv-formats"),
  ]);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema(bundledSpec as AnySchema, OPENAPI_SCHEMA_BASE);
  if (op.requestBody?.schemaRef)
    return ajv.getSchema(`${OPENAPI_SCHEMA_BASE}${op.requestBody.schemaRef}`) ?? null;
  if (op.requestBody?.schema) return ajv.compile(op.requestBody.schema as AnySchema);
  return null;
}

function hydrateBodySchema(op: OperationCard, bundledSpec: unknown): OperationCard {
  if (!op.requestBody?.schemaRef || op.requestBody.schema || !bundledSpec) return op;
  return {
    ...op,
    requestBody: {
      ...op.requestBody,
      schema: resolveRef(op.requestBody.schemaRef, bundledSpec),
    },
  };
}

function resolveRef(ref: string, spec: unknown): unknown {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))
    .reduce<unknown>((current, part) => asRecord(current)[part], spec);
}

function ajvParam(instancePath: string | undefined, params: unknown): string | null {
  const missing = asRecord(params).missingProperty;
  if (typeof missing === "string") return missing;
  const last = instancePath?.split("/").filter(Boolean).at(-1);
  return last ?? null;
}

export function envelopeForThrown(cmd: string, operationId: string, error: unknown): Envelope {
  if (error instanceof InputNormalizationError) {
    return failure({
      cmd,
      operation_id: operationId,
      error: error.toNormalizedError(),
      retry: { recommended: false, after_ms: null },
      hints: [{ cmd: `elv ops schema ${operationId}`, why: "Inspect required buckets." }],
    });
  }
  if (error instanceof NetworkRetryError) {
    return failure({
      cmd,
      operation_id: operationId,
      error: error.normalizedError,
      retry: error.retry,
      hints: mergeErrorHints(undefined, error.normalizedError, operationId, cmd),
    });
  }
  if (error instanceof OutTargetError) {
    return failure({
      cmd,
      operation_id: operationId,
      error: {
        type: "validation_error",
        code: error.code,
        message: error.message,
        raw: { hint: error.hint },
      },
      retry: { recommended: false, after_ms: null },
      hints: [{ cmd, why: error.hint }],
    });
  }
  return failure({
    cmd,
    operation_id: operationId,
    error: {
      type: "runtime_error",
      code: "internal_error",
      message: error instanceof Error ? error.message : String(error),
      raw: error,
    },
    retry: { recommended: false, after_ms: null },
    hints: hintsForError(
      {
        type: "runtime_error",
        code: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      },
      operationId,
      cmd,
    ),
  });
}

function minimalSpec(): unknown {
  return {
    openapi: "3.1.0",
    info: { title: "elv", version: "0" },
    paths: {},
    components: { schemas: {} },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
