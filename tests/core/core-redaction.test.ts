import { describe, expect, it } from "vitest";
import { containsCredential, redact, redactMedia, redactString } from "../../src/core/redaction";

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

  it("masks CloudFront and Azure signed-URL parameters", () => {
    const cloudfront =
      "https://d1.cloudfront.net/a.mp3?Expires=99&Signature=ABCDEF&Key-Pair-Id=KP123";
    const azure = "https://s.blob.core.windows.net/a.mp3?sv=2021&sig=AZURESIG&se=2030-01-01";

    expect(containsCredential({ any_url: cloudfront })).toBe(true);
    expect(redactString(cloudfront)).toBe(
      "https://d1.cloudfront.net/a.mp3?Expires=99&Signature=[REDACTED]&Key-Pair-Id=[REDACTED]",
    );
    expect(redactString(azure)).toBe(
      "https://s.blob.core.windows.net/a.mp3?sv=2021&sig=[REDACTED]&se=2030-01-01",
    );
    expect(redactString("https://cdn/a?Policy=eyJTdGF0ZW1lbnQi&Signature=SIG")).toBe(
      "https://cdn/a?Policy=[REDACTED]&Signature=[REDACTED]",
    );
  });

  it("strips every query string from media URLs while keeping polling fields", () => {
    const value = {
      id: "gen-1",
      status: "completed",
      preview_url: "https://d1.cloudfront.net/a.mp3?Expires=99&Signature=ABCDEF&Key-Pair-Id=KP123",
      cover_image_url: "https://cdn.example/cover.png",
      next_cursor: "cursor-1",
      note: "no url here?not=a-url",
    };

    expect(redactMedia(value)).toEqual({
      id: "gen-1",
      status: "completed",
      preview_url: "https://d1.cloudfront.net/a.mp3?[REDACTED]",
      cover_image_url: "https://cdn.example/cover.png",
      next_cursor: "cursor-1",
      note: "no url here?not=a-url",
    });
  });

  it("does not redact non-secret boolean presence flags", () => {
    expect(redact({ apiKeyPresent: true, apiKey: "sk_live_123" })).toEqual({
      apiKeyPresent: true,
      apiKey: "[REDACTED]",
    });
  });
});
