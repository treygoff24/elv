import { loadRegistry, readRegistryCache } from "../openapi/registry";
import { estimateCredits, enforceBudget, overBudget } from "./budget";
import { loadConfig, getApiKey } from "./config";
import { dryRun, failure } from "./envelope";
import { validationError, unknownOperation } from "./errors";
import { NetworkRetryError, sendWithRetry } from "./retries";
import { buildHttpRequest, InputNormalizationError, normalizeInput } from "./request-builder";
import { normalizeResponse } from "./response-normalizer";
import {
  addPaginationToEnvelope,
  allOutputTarget,
  applyPaginationDefaults,
  collectAllPages,
  type PaginationOptions,
} from "./pagination";
import { enforceSafety, requiresYes } from "./safety";
import { OutTargetError } from "./files";
import type { AnySchema, ValidateFunction } from "ajv";
import type { AgentInput, Envelope, NormalizedError, OperationCard, RunOpts } from "./types";
import type { HttpRequest } from "./request-builder";
import type { ResponseContext } from "./response-normalizer";

const OPENAPI_SCHEMA_BASE = "elv://openapi";

export async function runOperation(
  operationId: string,
  input: AgentInput | Record<string, unknown>,
  opts: RunOpts & PaginationOptions = {},
): Promise<Envelope> {
  const cmd = `elv call ${operationId}`;
  try {
    const registry = await loadRegistry();
    const cached = readRegistryCache();
    const baseOp = registry.get(operationId);
    if (!baseOp) return unknownOperation(operationId);
    const op = hydrateBodySchema(baseOp, cached?.bundledSpec);

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

    const estimate = estimateCredits(op, normalized, opts);
    if (opts.dryRun) {
      return dryRun({
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
      });
    }

    enforceSafety(op, opts);
    enforceBudget(estimate, opts);

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

    if (opts.all) {
      return collectAllPages({
        op,
        input: normalized,
        out: opts.out,
        saveJson: opts.saveJson,
        hash: opts.hash,
        limit: opts.limit,
        command: { kind: "call" },
        fetchPage: async (pageInput) =>
          sendAndNormalize(await makeRequest(pageInput), op, {
            cmd,
            out: opts.out ?? config.outputDir,
            hash: opts.hash,
            creditsEstimated: estimate,
            retryPost: opts.retryPost,
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
    });
    return addPaginationToEnvelope(env, op, normalized, { command: { kind: "call" }, limit: opts.limit });
  } catch (error) {
    return envelopeForThrown(cmd, operationId, error);
  }
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
  return { ...asRecord(input.body), ...input.files };
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
