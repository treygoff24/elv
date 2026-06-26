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

  if (code === "voice_not_found") {
    return [{ cmd: "elv voices list", why: "List available voice ids." }];
  }
  if ((code === "not_found" || code === "not-found") && operationId) {
    return [{ cmd: `elv ops get ${operationId}`, why: "Confirm the operation and required ids." }];
  }
  if (code === "invalid_api_key" || code === "missing_api_key") {
    return [{ cmd: "elv config doctor", why: "Verify ELEVENLABS_API_KEY is set and valid." }];
  }
  if (
    code === "forbidden" ||
    code === "insufficient_permissions" ||
    code === "feature_not_available"
  ) {
    return [
      {
        cmd: "elv config doctor",
        why: "Your key lacks permission or the feature isn't on your plan.",
      },
    ];
  }
  if (code === "insufficient_credits" || code === "quota_exceeded") {
    return [{ cmd: "elv usage", why: "Check remaining credits/quota." }];
  }
  if (
    code === "rate_limit_exceeded" ||
    code === "system_busy" ||
    code === "concurrent_limit_exceeded" ||
    code === "too_many_concurrent_requests"
  ) {
    return cmd ? [{ cmd, why: "Transient; retry after the suggested delay." }] : [];
  }
  return [];
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
