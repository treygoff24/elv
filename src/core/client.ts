import { loadRegistry, readRegistryCache } from "../openapi/registry";
import { isRecord } from "../util/json";
import { suggestIds } from "../util/suggest";
import { budgetDecision, estimateDetail } from "./budget";
import { ConfigFileError, loadConfig, getApiKey } from "./config";
import { dryRun, failure } from "./envelope";
import {
  budgetExceeded,
  configFileError,
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
  type PaginationCommand,
  type PaginationOptions,
} from "./pagination";
import { requiresYes } from "./safety";
import { OutTargetError } from "./files";
import type { ValidateFunction } from "ajv";
import type { OpenApiDocument } from "../openapi/compile-spec";
import { SchemaResolutionError, type HttpMethod, type OperationCard } from "../openapi/types";
import type { AgentInput, Envelope, Hint, NormalizedError, RunOpts, Warning } from "./types";
import type { HttpRequest } from "./request-builder";
import type { ResponseContext } from "./response-normalizer";

type OperationRunOpts = RunOpts & PaginationOptions & { inline?: boolean };

interface PreparedOperationRun {
  cmd: string;
  op: OperationCard;
  input: AgentInput;
  opts: OperationRunOpts;
  command: PaginationCommand;
  dryRunRequest: Record<string, unknown>;
  creditsEstimated: number | null;
  warnings?: Warning[];
  requestPath?: string;
  method?: HttpMethod;
}

type ExecutableOperationRun = Omit<PreparedOperationRun, "dryRunRequest">;

export async function runOperation(
  operationId: string,
  input: AgentInput | Record<string, unknown>,
  opts: OperationRunOpts = {},
): Promise<Envelope> {
  const cmd = opts.cmd ?? `elv call ${operationId}`;
  try {
    const registry = await loadRegistry();
    const cached = readRegistryCache();
    const baseOp = registry.get(operationId);
    if (!baseOp)
      return unknownOperation(operationId, suggestIds(operationId, [...registry.keys()]));
    const op = hydrateBodySchema(baseOp, cached?.bundledSpec);

    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
      return validationError(cmd, "--limit must be a positive integer", {
        operationId,
      });
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
        hints: validationHints(validation),
      });

    const { credits: estimate, warnings: estimateWarnings } = await estimateDetail(
      op,
      normalized,
      opts,
    );
    return await runPreparedOperation({
      cmd,
      op,
      input: normalized,
      opts,
      command: { kind: "call" },
      dryRunRequest: {
        operation_id: operationId,
        method: op.method,
        path: op.pathTemplate,
        input: normalized,
      },
      creditsEstimated: estimate,
      warnings: estimateWarnings,
    });
  } catch (error) {
    return envelopeForThrown(cmd, operationId, error);
  }
}

export function runPreparedOperation({
  cmd,
  op,
  input,
  opts,
  command,
  dryRunRequest,
  creditsEstimated,
  warnings = [],
  requestPath,
  method,
}: PreparedOperationRun): Promise<Envelope> {
  const config = loadConfig({
    profile: opts.profile,
    baseUrl: opts.baseUrl,
    maxCredits: opts.maxCredits,
  });
  const effectiveOpts = { ...opts, maxCredits: config.maxCredits };
  const budget = budgetDecision(op, creditsEstimated, effectiveOpts);
  const effectiveWarnings = [
    ...warnings,
    ...(op.deprecated
      ? [
          {
            code: "deprecated_operation",
            message: `${op.operationId} is deprecated by the active OpenAPI specification`,
          },
        ]
      : []),
    ...budgetPolicyWarnings(budget.policy),
  ];
  const preflightEnvelope = preparedOperationPreflight({
    cmd,
    op,
    input,
    opts: effectiveOpts,
    command,
    dryRunRequest,
    creditsEstimated,
    warnings: effectiveWarnings,
    requestPath,
    method,
  });
  if (preflightEnvelope) return Promise.resolve(preflightEnvelope);

  if (effectiveOpts.all && !allOutputTarget(effectiveOpts)) {
    return Promise.resolve(
      validationError(cmd, "--all requires --save-json or --out", {
        operationId: op.operationId,
      }),
    );
  }

  const requestContext = {
    baseUrl: effectiveOpts.baseUrl ?? config.baseUrl,
    apiKey: effectiveOpts.apiKey ?? getApiKey({ profile: effectiveOpts.profile }),
  };
  const makeRequest = (nextInput: AgentInput) => buildHttpRequest(op, nextInput, requestContext);
  const executable = {
    cmd,
    op,
    input,
    opts: effectiveOpts,
    command,
    creditsEstimated,
    warnings: effectiveWarnings,
    requestPath,
    method,
  };

  return effectiveOpts.all
    ? runAllPages(executable, makeRequest, config.outputDir)
    : runSinglePage(executable, makeRequest, config.outputDir);
}

function preparedOperationPreflight({
  cmd,
  op,
  opts,
  dryRunRequest,
  creditsEstimated,
  warnings = [],
}: PreparedOperationRun): Envelope | null {
  const budget = budgetDecision(op, creditsEstimated, opts);
  if (opts.dryRun) {
    const env = dryRun({
      cmd,
      operationId: op.operationId,
      request: dryRunRequest,
      creditsEstimated,
      wouldRequireYes: requiresYes(op),
      wouldExceedBudget: budget.wouldExceed === true,
    });
    return withWarnings(
      {
        ...env,
        data: {
          ...(isRecord(env.data) ? env.data : {}),
          budget_policy: budget.policy,
          would_exceed_budget: budget.wouldExceed,
        },
      },
      warnings,
    );
  }

  if (requiresYes(op) && !opts.yes) {
    return withWarnings(
      confirmationRequired(cmd, `${op.operationId} (${op.risk}) requires --yes`, {
        operationId: op.operationId,
        hints: [
          {
            cmd: `${cmd} --dry-run`,
            why: "Preview the request without calling the API or mutating anything.",
          },
        ],
      }),
      warnings,
    );
  }
  if (budget.policy === "estimate_unavailable") {
    return withWarnings(budgetEstimateUnavailable(cmd, op, opts.maxCredits as number), warnings);
  }
  if (budget.wouldExceed === true) {
    return withWarnings(
      budgetExceeded(cmd, creditsEstimated, opts.maxCredits as number, {
        operationId: op.operationId,
      }),
      warnings,
    );
  }
  return null;
}

type RequestFactory = (nextInput: AgentInput) => Promise<HttpRequest>;

async function runAllPages(
  {
    cmd,
    op,
    input,
    opts,
    command,
    creditsEstimated,
    warnings = [],
    requestPath,
    method,
  }: ExecutableOperationRun,
  makeRequest: RequestFactory,
  outputDir: string,
): Promise<Envelope> {
  const env = await collectAllPages({
    op,
    input,
    out: opts.out,
    saveJson: opts.saveJson,
    hash: opts.hash,
    limit: opts.limit,
    command,
    fetchPage: async (pageInput) =>
      sendAndNormalize(await makeRequest(pageInput), op, {
        cmd,
        out: opts.out ?? outputDir,
        saveJson: opts.saveJson,
        hash: opts.hash,
        creditsEstimated,
        retryPost: opts.retryPost,
        requestPath,
        method,
        inline: true,
      }),
  });
  return withWarnings(env, warnings);
}

async function runSinglePage(
  {
    cmd,
    op,
    input,
    opts,
    command,
    creditsEstimated,
    warnings = [],
    requestPath,
    method,
  }: ExecutableOperationRun,
  makeRequest: RequestFactory,
  outputDir: string,
): Promise<Envelope> {
  const isPaginated = supportsPagination(op);
  const req = await makeRequest(input);
  const env = await sendAndNormalize(req, op, {
    cmd,
    out: opts.out ?? outputDir,
    saveJson: opts.saveJson,
    hash: opts.hash,
    creditsEstimated,
    retryPost: opts.retryPost,
    requestPath: requestPath ?? req.path,
    method: method ?? req.method,
    // Normalize inline when downstream code needs data: pagination computes
    // next/truncation, --save-json writes the full result, and explicit inline
    // callers consume the body directly.
    inline: opts.inline || isPaginated || opts.saveJson !== undefined,
  });
  const paginatedEnv = addPaginationToEnvelope(env, op, input, {
    command,
    limit: opts.limit,
  });
  const finalEnv =
    (isPaginated || opts.saveJson !== undefined) && !opts.inline
      ? await spillIfLarge(op, paginatedEnv, {
          cmd,
          out: opts.out ?? outputDir,
          saveJson: opts.saveJson,
          hash: opts.hash,
        })
      : paginatedEnv;
  return withWarnings(finalEnv, warnings);
}

function withWarnings(env: Envelope, warnings: Warning[]): Envelope {
  if (warnings.length === 0) return env;
  return { ...env, warnings: [...(env.warnings ?? []), ...warnings] };
}

function budgetPolicyWarnings(policy: ReturnType<typeof budgetDecision>["policy"]): Warning[] {
  return policy === "unknown_unbounded"
    ? [
        {
          code: "budget_policy_unknown_unbounded",
          message:
            "A credit ceiling is configured, but this non-generation operation has no defensible estimate and will proceed.",
        },
      ]
    : [];
}

function budgetEstimateUnavailable(cmd: string, op: OperationCard, maxCredits: number): Envelope {
  return failure({
    cmd,
    operation_id: op.operationId,
    error: {
      type: "budget_exceeded",
      code: "budget_estimate_unavailable",
      message: `Cannot enforce credit cap ${maxCredits} because ${op.operationId} has no defensible cost estimate`,
      raw: {
        estimated: null,
        max: maxCredits,
        budget_policy: "estimate_unavailable",
      },
    },
    cost: {
      credits_estimated: null,
      credits_charged: null,
      credits_source: "none",
    },
    retry: { recommended: false, after_ms: null },
    hints: [
      {
        cmd,
        why: "Remove the configured ceiling deliberately, provide a smaller bounded input, or choose an operation with a documented estimator.",
      },
    ],
  });
}

interface SendAndNormalizeContext extends ResponseContext {
  retryPost?: boolean;
}

async function sendAndNormalize(
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
  bundledSpec: OpenApiDocument | undefined,
): Promise<NormalizedError | null> {
  const missingParam = missingRequiredParamError(op, input);
  if (missingParam) return missingParam;
  if (skipRequestBodyValidation(op, bundledSpec)) return null;

  const missingBody = missingRequiredBodyError(op, input);
  if (missingBody) return missingBody;

  const validator = await getInputValidatorForOperation(op, bundledSpec ?? minimalSpec());
  if (!validator) return null;
  return validationFailure(op, input, validator);
}

function missingRequiredParamError(op: OperationCard, input: AgentInput): NormalizedError | null {
  for (const param of [...op.pathParams, ...op.queryParams, ...op.headerParams]) {
    if (!param.required) continue;
    const bucket = param.location === "header" ? input.headers : input[param.location];
    if (bucket?.[param.name] !== undefined) continue;
    return {
      type: "validation_error",
      code: "validation_error",
      message: `${param.location}: missing required parameter ${param.name}`,
      param: param.name,
      raw: { location: param.location, name: param.name },
    };
  }
  return null;
}

function skipRequestBodyValidation(
  op: OperationCard,
  bundledSpec: OpenApiDocument | undefined,
): boolean {
  return !op.requestBody || (!bundledSpec && Boolean(op.requestBody.schemaRef));
}

function missingRequiredBodyError(op: OperationCard, input: AgentInput): NormalizedError | null {
  if (!op.requestBody?.required || hasRequestPayload(op, input)) return null;
  return {
    type: "validation_error",
    code: "validation_error",
    message: "body: request body is required",
    param: "body",
    raw: {},
  };
}

function validationFailure(
  op: OperationCard,
  input: AgentInput,
  validator: ValidateFunction,
): NormalizedError | null {
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

function validationHints(error: NormalizedError): Hint[] | undefined {
  if (!isModelEnumFailure(error)) return undefined;
  return [
    { cmd: "elv spec status", why: "Check which OpenAPI revision is active." },
    { cmd: "elv spec diff", why: "Check whether the provider publishes the model yet." },
    { cmd: "elv spec update", why: "Refresh model enums from the published OpenAPI spec." },
  ];
}

function isModelEnumFailure(error: NormalizedError): boolean {
  if (error.param !== "model_id" || !Array.isArray(error.raw)) return false;
  return error.raw.some((entry) => isRecord(entry) && entry.keyword === "enum");
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
  bundledSpec: OpenApiDocument,
): Promise<ValidateFunction | null> {
  const { buildAjv, getInputValidator } = await import("../openapi/ajv");
  return getInputValidator(buildAjv(bundledSpec), op);
}

function hydrateBodySchema(
  op: OperationCard,
  bundledSpec: OpenApiDocument | undefined,
): OperationCard {
  if (!op.requestBody?.schemaRef || op.requestBody.schema || !bundledSpec) return op;
  return {
    ...op,
    requestBody: {
      ...op.requestBody,
      schema: resolveRef(op.requestBody.schemaRef, bundledSpec),
    },
  };
}

function resolveRef(ref: string, spec: OpenApiDocument): unknown {
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
  if (error instanceof ConfigFileError) {
    return configFileError(cmd, error.message, {
      operationId,
      raw: { path: error.path },
    });
  }
  if (error instanceof InputNormalizationError) {
    return failure({
      cmd,
      operation_id: operationId,
      error: error.toNormalizedError(),
      retry: { recommended: false, after_ms: null },
      hints: [
        {
          cmd: `elv ops schema ${operationId}`,
          why: "Inspect required buckets.",
        },
      ],
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
  if (error instanceof SchemaResolutionError) {
    return failure({
      cmd,
      operation_id: operationId,
      error: {
        type: "schema_resolution_error",
        code: "schema_resolution_error",
        message: error.message,
        raw: { operation_id: operationId },
      },
      retry: { recommended: false, after_ms: null },
      hints: [
        {
          cmd: `elv ops schema ${operationId} --example`,
          why: "Inspect the active request schema and generate a valid input skeleton.",
        },
        { cmd: "elv spec status", why: "Inspect the active OpenAPI revision." },
      ],
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

function minimalSpec(): OpenApiDocument {
  return {
    openapi: "3.1.0",
    info: { title: "elv", version: "0" },
    paths: {},
    components: { schemas: {} },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
