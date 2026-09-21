import { failure, writeEnvelope } from "./envelope";
import type { OutTargetError } from "./files";
import { ExitCode } from "./types";
import { shellArg } from "../util/shell";
import type { Envelope, ErrorEnvelope, Hint, NormalizedError } from "./types";

const INPUT_CODES = new Set([
  "invalid_parameters",
  "validation_error",
  "config_error",
  "config_json_invalid",
  "config_untrusted",
  "config_file_missing",
  "invalid_out_target",
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
  budget_estimate_unavailable: ExitCode.BudgetCeiling,
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
    hints: ({ operationId }) => {
      if (operationId === "http") {
        return [{ cmd: "elv http --help", why: "Inspect raw HTTP input and output options." }];
      }
      return operationId
        ? [{ cmd: `elv ops get ${operationId}`, why: "Confirm the operation and required ids." }]
        : [];
    },
  },
  {
    codes: new Set(["invalid_api_key", "missing_api_key"]),
    hints: () => [
      {
        cmd: "elv config doctor --online",
        why: "Verify the configured API key; profiles select its source with api_key_env.",
      },
    ],
  },
  {
    codes: new Set([
      "forbidden",
      "insufficient_permissions",
      "feature_not_available",
      "detected_unusual_activity",
    ]),
    hints: () => [
      {
        cmd: "elv config doctor --online",
        why: "Check the configured API key, its permissions, and plan access.",
      },
    ],
  },
  {
    codes: new Set(["insufficient_credits", "quota_exceeded"]),
    hints: () => [
      {
        cmd: "elv usage",
        why: "Check remaining credits/quota.",
      },
    ],
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

export function exitCodeForError(err: NormalizedError, httpStatus?: number | null): ExitCode {
  const code = err.code.toLowerCase();
  const codeExit = exitCodeFromCode(code);
  if (codeExit) return codeExit;
  if (httpStatus === 401 || httpStatus === 403) return ExitCode.AuthPermission;
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
    hints: ensureHints(
      options.hints,
      {
        type: "validation_error",
        code: "validation_error",
        message,
      },
      options.operationId,
      cmd,
    ),
  });
}

export function configFileError(
  cmd: string,
  message: string,
  options: PreflightOptions & { code?: string } = {},
): ErrorEnvelope {
  return failure({
    cmd,
    operation_id: options.operationId,
    error: {
      type: "config_error",
      code: options.code ?? "config_json_invalid",
      message,
      param: options.param ?? null,
      raw: options.raw,
    },
    retry: { recommended: false, after_ms: null },
    hints: [{ cmd: "elv config doctor", why: "Validate local elv configuration." }],
  });
}

export function outTargetError(
  cmd: string,
  error: OutTargetError,
  options: Pick<PreflightOptions, "operationId"> & { hintCmd?: string } = {},
): ErrorEnvelope {
  const replacementFlag = error.source === "--save-json" ? "--save-json" : "--out";
  const replacement = replacementFlag === "--save-json" ? "./output.json" : "./output";
  const baseCommand =
    options.operationId && options.operationId !== "http" ? `elv call ${options.operationId}` : cmd;
  const replacementHint = {
    cmd: options.hintCmd ?? `${baseCommand} ${replacementFlag} ${replacement} --dry-run`,
    why: error.hint,
  };
  return failure({
    cmd,
    operation_id: options.operationId,
    error: {
      type: "validation_error",
      code: error.code,
      message: error.message,
      raw: { hint: error.hint },
    },
    retry: { recommended: false, after_ms: null },
    hints:
      error.source === "default"
        ? [
            {
              cmd: "elv config get",
              why: "Show the output_dir / ELV_OUTPUT_DIR that failed the writability check.",
            },
            replacementHint,
          ]
        : [replacementHint],
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
    hints: ensureHints(
      options.hints,
      {
        type: "confirmation_required",
        code: "confirmation",
        message,
      },
      options.operationId,
      cmd,
    ),
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
    hints: ensureHints(
      options.hints,
      {
        type: "budget_exceeded",
        code: "budget",
        message:
          estimated === null
            ? `Budget cap ${max} would be exceeded`
            : `Estimated credits ${estimated} exceed cap ${max}`,
      },
      options.operationId,
      cmd,
    ),
  });
}

export function hintsForError(err: NormalizedError, operationId?: string, cmd?: string): Hint[] {
  const code = err.code.toLowerCase();
  const matchingRule = HINT_RULES.find((rule) => rule.codes.has(code));
  if (matchingRule) return matchingRule.hints({ operationId, cmd });
  if (err.type === "validation_error" || INPUT_CODES.has(code)) {
    return [inputRecoveryHint(operationId, cmd)];
  }
  if (err.type === "authentication_error" || err.type === "permission_error") {
    return [
      {
        cmd: "elv config doctor --online",
        why: "Verify the configured API key; profiles select its source with api_key_env.",
      },
    ];
  }
  if (code === "budget" || code === "budget_estimate_unavailable") {
    return [
      {
        cmd: "elv usage",
        why: "Inspect current usage before raising --max-credits or reducing the requested work.",
      },
    ];
  }
  if (operationId === "http" && (code === "unknown_operation" || NOT_FOUND_CODES.has(code))) {
    return [{ cmd: "elv http --help", why: "Inspect raw HTTP input and output options." }];
  }
  if (
    err.type === "provider_error" ||
    err.type === "server_error" ||
    err.type === "network_error" ||
    TRANSIENT_CODES.has(code)
  ) {
    return [
      {
        cmd: "elv config doctor --online",
        why: "Check provider connectivity and authentication before retrying.",
      },
    ];
  }
  return [inputRecoveryHint(operationId, cmd)];
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
  return ensureHints(merged, err, operationId, cmd);
}

function ensureHints(
  base: Hint[] | undefined,
  err: NormalizedError,
  operationId?: string,
  cmd?: string,
): Hint[] {
  return base?.length ? base : hintsForError(err, operationId, cmd);
}

function inputRecoveryHint(operationId?: string, cmd?: string): Hint {
  if (operationId && operationId !== "http") {
    return {
      cmd: `elv ops schema ${operationId} --example`,
      why: "Inspect required inputs and generate a valid request skeleton.",
    };
  }
  if (operationId === "http" || cmd?.startsWith("elv http")) {
    return { cmd: "elv http --help", why: "Inspect raw HTTP input and output options." };
  }
  return { cmd: commandHelp(cmd), why: "Inspect valid commands and flags." };
}

function commandHelp(cmd?: string): string {
  const tokens = cmd?.trim().split(/\s+/u) ?? [];
  const flag = tokens.findIndex((token) => token.startsWith("-"));
  const command = tokens.slice(0, flag < 0 ? tokens.length : flag).join(" ");
  return command ? `${command} --help` : "elv --help";
}

export function unknownOperation(id: string, suggestions: string[] = []): ErrorEnvelope {
  const suggestionHints: Hint[] = suggestions.map((s) => ({
    cmd: `elv call ${s}`,
    why: `Did you mean '${s}'?`,
  }));
  return failure({
    cmd: `elv call ${id}`,
    operation_id: id,
    error: {
      type: "not_found_error",
      code: "unknown_operation",
      message: `Unknown operation: ${id}`,
    },
    retry: { recommended: false, after_ms: null },
    hints: [
      ...suggestionHints,
      { cmd: `elv ops search ${shellArg(id)}`, why: "Find a valid operation_id." },
    ],
  });
}

export function emitAndExit(env: Envelope, code: ExitCode): never {
  writeEnvelope(env);
  process.exit(code);
}
