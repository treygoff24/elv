import { describe, expect, it } from "vitest";
import { redact, redactString } from "../../src/core/redaction";

describe("redaction", () => {
  it("deep-clones and redacts secret-looking keys", () => {
    const input = {
      nested: {
        Authorization: "Bearer live_token",
        normal: "keep",
        xi_api_key: "sk_live_secret",
        clientSecret: "secret-value",
      },
    };

    const output = redact(input);

    expect(output).toEqual({
      nested: {
        Authorization: "[REDACTED]",
        normal: "keep",
        xi_api_key: "[REDACTED]",
        clientSecret: "[REDACTED]",
      },
    });
    expect(input.nested.Authorization).toBe("Bearer live_token");
  });

  it("scrubs credentials embedded in strings", () => {
    const value =
      "https://x.test/ws?single_use_token=abc&ok=1 Authorization: Bearer token123 sk_live_123";

    expect(redactString(value)).toBe(
      "https://x.test/ws?single_use_token=[REDACTED]&ok=1 Authorization: Bearer [REDACTED] sk_[REDACTED]",
    );
  });

  it("does not redact non-secret boolean presence flags", () => {
    expect(redact({ apiKeyPresent: true, apiKey: "sk_live_123" })).toEqual({
      apiKeyPresent: true,
      apiKey: "[REDACTED]",
    });
  });
});
