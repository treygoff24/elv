import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySpeechEngineJwt } from "../../src/speech-engine/auth";

export const TEST_KEY = "speech-engine-test-key";

export function token(
  claims: Record<string, unknown> = {},
  key = TEST_KEY,
  header: Record<string, unknown> = { alg: "HS256", typ: "JWT" },
): string {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    header,
    {
      iss: "https://api.elevenlabs.io/convai/speech-engine",
      sub: "convai_speech_engine_upstream",
      iat: now,
      exp: now + 300,
      ...claims,
    },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"));
  const signingInput = parts.join(".");
  const secret = createHash("sha256").update(key.trim(), "utf8").digest();
  return `${signingInput}.${createHmac("sha256", secret).update(signingInput).digest("base64url")}`;
}

describe("Speech Engine upgrade JWT authentication", () => {
  it("accepts the official binary SHA256-key HS256 contract and optional Bearer prefix", () => {
    expect(verifySpeechEngineJwt(token(), TEST_KEY)).toBe(true);
    expect(verifySpeechEngineJwt(`Bearer ${token()}`, ` ${TEST_KEY} `)).toBe(true);
    expect(
      verifySpeechEngineJwt(token({ exp: Math.floor(Date.now() / 1000) - 30 }), TEST_KEY),
    ).toBe(true);
  });

  it("rejects wrong keys, tampering, missing headers, and noncanonical segments", () => {
    const signed = token();
    expect(verifySpeechEngineJwt(signed, "wrong-key")).toBe(false);
    expect(verifySpeechEngineJwt(`${signed.slice(0, -3)}aaa`, TEST_KEY)).toBe(false);
    expect(verifySpeechEngineJwt(undefined, TEST_KEY)).toBe(false);
    expect(verifySpeechEngineJwt(signed, " ")).toBe(false);
    expect(verifySpeechEngineJwt(`${signed}=`, TEST_KEY)).toBe(false);
    expect(verifySpeechEngineJwt("a.b.c.d", TEST_KEY)).toBe(false);
  });

  it.each([
    { iss: "https://example.test" },
    { sub: "not-speech-engine" },
    { exp: 1 },
    { exp: "999999999999" },
    { iat: "1" },
    { exp: null },
    { iat: Math.floor(Date.now() / 1000) + 120 },
  ])("rejects invalid claims %j", (claims) => {
    expect(verifySpeechEngineJwt(token(claims), TEST_KEY)).toBe(false);
  });

  it("rejects unsupported algorithms even if a valid HMAC was supplied", () => {
    expect(verifySpeechEngineJwt(token({}, TEST_KEY, { alg: "none" }), TEST_KEY)).toBe(false);
    expect(verifySpeechEngineJwt(token({}, TEST_KEY, { alg: "HS512" }), TEST_KEY)).toBe(false);
  });
});
