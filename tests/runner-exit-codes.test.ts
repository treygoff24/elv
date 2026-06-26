import { describe, expect, it } from "vitest";
import { normalizeProviderError } from "../src/core/error-normalizer";
import { exitCodeForError } from "../src/core/errors";
import { ExitCode } from "../src/core/types";

describe("runner exit code taxonomy", () => {
  it("keys on provider body code before raw HTTP status", () => {
    expect(
      exitCodeForError(
        normalizeProviderError(
          { detail: { code: "invalid_parameters", message: "bad" } },
          500,
          new Headers(),
        ),
        500,
      ),
    ).toBe(ExitCode.InputValidation);
    expect(
      exitCodeForError(
        normalizeProviderError(
          { detail: { code: "quota_exceeded", message: "pay" } },
          401,
          new Headers(),
        ),
        401,
      ),
    ).toBe(ExitCode.CreditExhausted);
    expect(
      exitCodeForError(
        normalizeProviderError(
          { detail: { code: "rate_limit_exceeded", message: "wait" } },
          429,
          new Headers(),
        ),
        429,
      ),
    ).toBe(ExitCode.TransientExhausted);
    expect(
      exitCodeForError(
        normalizeProviderError(
          { detail: { status: "missing_api_key", message: "auth" } },
          401,
          new Headers(),
        ),
        401,
      ),
    ).toBe(ExitCode.AuthPermission);
  });
});
