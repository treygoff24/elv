import { failure, writeEnvelope } from "./envelope";
import { ExitCode } from "./types";
import type { Envelope, ErrorEnvelope, Hint, NormalizedError } from "./types";

const INPUT_CODES = new Set([
  "invalid_parameters",
  "validation_error",
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

export function exitCodeForError(err: NormalizedError, httpStatus?: number): ExitCode {
  const code = err.code.toLowerCase();
  if (INPUT_CODES.has(code)) return ExitCode.InputValidation;
  if (AUTH_CODES.has(code)) return ExitCode.AuthPermission;
  if (CREDIT_CODES.has(code)) return ExitCode.CreditExhausted;
  if (TRANSIENT_CODES.has(code)) return ExitCode.TransientExhausted;
  if (NOT_FOUND_CODES.has(code)) return ExitCode.NotFound;
  if (code === "confirmation") return ExitCode.ConfirmationRequired;
  if (code === "budget") return ExitCode.BudgetCeiling;
  if (httpStatus === 404) return ExitCode.NotFound;
  if (httpStatus && httpStatus >= 400 && httpStatus <= 599) return ExitCode.ProviderError;
  return ExitCode.ProviderError;
}

export function classifyTypeFromStatus(status: number): string {
  if (status === 400 || status === 422) return "validation_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "provider_error";
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

export function notImplemented(cmd: string): ErrorEnvelope {
  return failure({
    cmd,
    error: {
      type: "not_implemented",
      code: "not_implemented",
      message: `${cmd} is not implemented in P1`,
    },
    retry: { recommended: false, after_ms: null },
  });
}

export function emitAndExit(env: Envelope, code: ExitCode): never {
  writeEnvelope(env);
  process.exit(code);
}
