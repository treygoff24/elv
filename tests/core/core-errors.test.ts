import { describe, expect, it } from "vitest";
import { ExitCode } from "../../src/core/types";
import {
  budgetExceeded,
  classifyTypeFromStatus,
  confirmationRequired,
  exitCodeForError,
  hintsForError,
  unknownOperation,
  validationError,
} from "../../src/core/errors";

describe("errors", () => {
  it("maps exit codes from normalized body codes before HTTP status", () => {
    expect(exitCodeForError({ type: "x", code: "invalid_parameters", message: "bad" }, 500)).toBe(
      ExitCode.InputValidation,
    );
    expect(exitCodeForError({ type: "x", code: "quota_exceeded", message: "pay" }, 401)).toBe(
      ExitCode.CreditExhausted,
    );
    expect(exitCodeForError({ type: "x", code: "rate_limit_exceeded", message: "wait" }, 429)).toBe(
      ExitCode.TransientExhausted,
    );
    expect(exitCodeForError({ type: "x", code: "unknown_operation", message: "missing" })).toBe(
      ExitCode.NotFound,
    );
    expect(exitCodeForError({ type: "x", code: "other", message: "oops" }, 418)).toBe(
      ExitCode.ProviderError,
    );
  });

  it("classifies fallback error type from status", () => {
    expect(classifyTypeFromStatus(422)).toBe("validation_error");
    expect(classifyTypeFromStatus(401)).toBe("authentication_error");
    expect(classifyTypeFromStatus(429)).toBe("rate_limit_error");
    expect(classifyTypeFromStatus(503)).toBe("server_error");
  });

  it("builds preflight error envelopes", () => {
    expect(validationError("elv call", "bad input").error.code).toBe("validation_error");
    expect(confirmationRequired("elv delete").error.code).toBe("confirmation");
    expect(budgetExceeded("elv tts", 10, 5).error.code).toBe("budget");
    expect(unknownOperation("missing_op")).toMatchObject({ ok: false, operation_id: "missing_op" });
  });

  it("returns actionable hints from normalized provider codes", () => {
    expect(hintsForError({ type: "x", code: "voice_not_found", message: "missing" })).toEqual([
      { cmd: "elv voices list", why: "List available voice ids." },
    ]);
    expect(
      hintsForError({ type: "x", code: "not_found", message: "missing" }, "get_voice"),
    ).toEqual([{ cmd: "elv ops get get_voice", why: "Confirm the operation and required ids." }]);
    expect(hintsForError({ type: "x", code: "quota_exceeded", message: "pay" })).toEqual([
      { cmd: "elv usage", why: "Check remaining credits/quota." },
    ]);
    expect(
      hintsForError(
        { type: "x", code: "rate_limit_exceeded", message: "wait" },
        undefined,
        "elv call",
      ),
    ).toEqual([{ cmd: "elv call", why: "Transient; retry after the suggested delay." }]);
  });
});
