import { failure, writeEnvelope } from "./envelope";
import { ExitCode } from "./types";
import type { Envelope, ErrorEnvelope, Hint, NormalizedError } from "./types";

const INPUT_CODES = new Set([
  "invalid_parameters",
  "validation_error",
  "config_error",
  "config_json_invalid",
  "text_too_long",
  "max_character_limit_exceeded",
]);
const AUTH_CODES = new Set([
  "invalid_api_key",
  "missing_api_key",
  "forbidden",
  "insufficient_permissions",
  "feature_not_available",
  "detected_unusual_activity",
]);
const CREDIT_CODES = new Set(["insufficient_credits", "quota_exceeded"]);
const TRANSIENT_CODES = new Set([
  "rate_limit_exceeded",
  "system_busy",
  "concurrent_limit_exceeded",
  "too_many_concurrent_requests",
  "internal_error",
  "service_unavailable",
]);
const NOT_FOUND_CODES = new Set([
  "voice_not_found",
  "not-found",
  "not_found",
  "unknown_operation",
  "unknown op",
]);
const EXIT_CODE_RULES: Array<[Set<string>, ExitCode]> = [
  [INPUT_CODES, ExitCode.InputValidation],
  [AUTH_CODES, ExitCode.AuthPermission],
  [CREDIT_CODES, ExitCode.CreditExhausted],
  [TRANSIENT_CODES, ExitCode.TransientExhausted],
  [NOT_FOUND_CODES, ExitCode.NotFound],
];
const EXACT_EXIT_CODES: Record<string, ExitCode> = {
  confirmation: ExitCode.ConfirmationRequired,
  budget: ExitCode.BudgetCeiling,
};
const TYPE_BY_STATUS: Record<number, string> = {
  400: "validation_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  422: "validation_error",
  429: "rate_limit_error",
};

interface HintContext {
  operationId?: string;
  cmd?: string;
}

interface HintRule {
  codes: Set<string>;
  hints: (context: HintContext) => Hint[];
}

const HINT_RULES: HintRule[] = [
  {
    codes: new Set(["voice_not_found"]),
    hints: () => [{ cmd: "elv voices list", why: "List available voice ids." }],
  },
  {
    codes: new Set(["not_found", "not-found"]),
    hints: ({ operationId }) =>
      operationId
        ? [{ cmd: `elv ops get ${operationId}`, why: "Confirm the operation and required ids." }]
        : [],
  },
  {
    codes: new Set(["invalid_api_key", "missing_api_key"]),
    hints: () => [{ cmd: "elv config doctor", why: "Verify ELEVENLABS_API_KEY is set and valid." }],
  },
  {
    codes: new Set(["forbidden", "insufficient_permissions", "feature_not_available"]),
    hints: () => [
      {
        cmd: "elv config doctor",
        why: "Your key lacks permission or the feature isn't on your plan.",
      },
    ],
  },
  {
    codes: new Set(["insufficient_credits", "quota_exceeded"]),
    hints: () => [{ cmd: "elv usage", why: "Check remaining credits/quota." }],
  },
  {
    codes: new Set([
      "rate_limit_exceeded",
      "system_busy",
      "concurrent_limit_exceeded",
      "too_many_concurrent_requests",
    ]),
    hints: ({ cmd }) => (cmd ? [{ cmd, why: "Transient; retry after the suggested delay." }] : []),
  },
];

export function exitCodeForError(err: NormalizedError, httpStatus?: number): ExitCode {
  const code = err.code.toLowerCase();
  const codeExit = exitCodeFromCode(code);
  if (codeExit) return codeExit;
  if (httpStatus === 404) return ExitCode.NotFound;
  return ExitCode.ProviderError;
}

function exitCodeFromCode(code: string): ExitCode | undefined {
  for (const [codes, exitCode] of EXIT_CODE_RULES) {
    if (codes.has(code)) return exitCode;
  }
  return EXACT_EXIT_CODES[code];
}

export function classifyTypeFromStatus(status: number): string {
  return TYPE_BY_STATUS[status] ?? (status >= 500 ? "server_error" : "provider_error");
}

interface PreflightOptions {
  param?: string | null;
  operationId?: string;
  hints?: Hint[];
  raw?: unknown;
}

export function validationError(
  cmd: string,
  message: string,
  options: PreflightOptions = {},
): ErrorEnvelope {
  return failure({
    cmd,
    operation_id: options.operationId,
    error: {
      type: "validation_error",
      code: "validation_error",
      message,
      param: options.param ?? null,
      raw: options.raw,
    },
    retry: { recommended: false, after_ms: null },
    hints: options.hints,
  });
}

export function configFileError(
  cmd: string,
  message: string,
  options: PreflightOptions = {},
): ErrorEnvelope {
  return failure({
    cmd,
    operation_id: options.operationId,
    error: {
      type: "config_error",
      code: "config_json_invalid",
      message,
      param: options.param ?? null,
      raw: options.raw,
    },
    retry: { recommended: false, after_ms: null },
    hints: [{ cmd: "elv config doctor", why: "Validate local elv configuration." }],
  });
}

export function confirmationRequired(
  cmd: string,
  message = "Confirmation required",
  options: PreflightOptions = {},
): ErrorEnvelope {
  return failure({
    cmd,
    operation_id: options.operationId,
    error: {
      type: "confirmation_required",
      code: "confirmation",
      message,
      raw: options.raw,
    },
    retry: { recommended: false, after_ms: null },
    hints: options.hints,
  });
}

export function budgetExceeded(
  cmd: string,
  estimated: number | null,
  max: number,
  options: PreflightOptions = {},
): ErrorEnvelope {
  return failure({
    cmd,
    operation_id: options.operationId,
    error: {
      type: "budget_exceeded",
      code: "budget",
      message:
        estimated === null
          ? `Budget cap ${max} would be exceeded`
          : `Estimated credits ${estimated} exceed cap ${max}`,
      raw: { estimated, max },
    },
    cost: {
      credits_estimated: estimated,
      credits_charged: null,
      credits_source: estimated === null ? "none" : "estimate",
    },
    retry: { recommended: false, after_ms: null },
    hints: options.hints,
  });
}

export function hintsForError(err: NormalizedError, operationId?: string, cmd?: string): Hint[] {
  const code = err.code.toLowerCase();
  return HINT_RULES.find((rule) => rule.codes.has(code))?.hints({ operationId, cmd }) ?? [];
}

export function mergeErrorHints(
  base: Hint[] | undefined,
  err: NormalizedError,
  operationId?: string,
  cmd?: string,
): Hint[] {
  const merged = [...(base ?? [])];
  for (const hint of hintsForError(err, operationId, cmd)) {
    if (!merged.some((existing) => existing.cmd === hint.cmd && existing.why === hint.why)) {
      merged.push(hint);
    }
  }
  return merged;
}

export function unknownOperation(id: string): ErrorEnvelope {
  return failure({
    cmd: `elv call ${id}`,
    operation_id: id,
    error: {
      type: "not_found_error",
      code: "unknown_operation",
      message: `Unknown operation: ${id}`,
    },
    retry: { recommended: false, after_ms: null },
    hints: [{ cmd: "elv ops search <query>", why: "Find a valid operation_id." }],
  });
}

export function emitAndExit(env: Envelope, code: ExitCode): never {
  writeEnvelope(env);
  process.exit(code);
}
