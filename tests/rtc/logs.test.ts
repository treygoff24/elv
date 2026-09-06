import { describe, expect, it } from "vitest";
import { RtcLogCollector, redactRtcText, redactRtcValue } from "../../src/rtc/logs";

describe("native RTC diagnostics", () => {
  it("redacts malformed Unicode tokens without throwing in error handling", () => {
    const token = "\ud800";
    expect(redactRtcText(JSON.stringify(token).slice(1, -1), token)).toBe("[REDACTED]");
  });
  it("redacts a token across both chunk and retained-log boundaries", () => {
    const token = "eyJ-native-private-token.signature-canary";
    const logs = new RtcLogCollector(token, 40);
    logs.write(Buffer.from(`prior diagnostics\ntrace: ${token.slice(0, 16)}`));
    logs.write(Buffer.from(`${token.slice(16)}\n`));
    const result = logs.finish();
    expect(result).not.toContain(token);
    expect(result).not.toContain(token.slice(0, 16));
    expect(result).toContain("[REDACTED]");
  });

  it("drops an oversized incomplete line instead of exposing a token prefix", () => {
    const token = "private-token-crossing-large-tail";
    const logs = new RtcLogCollector(token, 100);
    logs.write(Buffer.from(token.slice(0, 12) + "x".repeat(70000)));
    expect(logs.finish()).not.toContain(token.slice(0, 12));
  });

  it("redacts encoded token strings in a complete line", () => {
    const token = 'private/token+with"quote';
    expect(redactRtcText(encodeURIComponent(token), token)).toBe("[REDACTED]");
    const logs = new RtcLogCollector(token);
    logs.write(Buffer.from(`diagnostic ${JSON.stringify(token).slice(1, -1)}\n`));
    expect(logs.finish()).toBe("diagnostic [REDACTED]");
  });

  it("never emits an incomplete token at EOF", () => {
    const token = "private-credential-with-a-truncated-tail";
    const logs = new RtcLogCollector(token);
    logs.write(Buffer.from(`error ${token.slice(0, 20)}`));
    expect(logs.finish()).not.toContain(token.slice(0, 20));
  });

  it("sanitizes event values before serializing JSON with credential-bearing URLs", () => {
    const token = "exact-session-canary";
    const event = {
      type: "metadata",
      url: `https://example.test/content?token=${token}`,
      nested: { text: token },
    };
    const line = JSON.stringify(redactRtcValue(event, token));
    expect(JSON.parse(line)).toEqual({
      type: "metadata",
      url: "https://example.test/content?token=[REDACTED]",
      nested: { text: "[REDACTED]" },
    });
    expect(line).not.toContain(token);
  });
});
