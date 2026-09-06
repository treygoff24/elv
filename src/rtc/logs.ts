import { StringDecoder } from "node:string_decoder";
import { redactWs, redactWsString } from "../ws/events";
import type { JsonValue } from "../util/json";

export function redactRtcText(text: string, token: string): string {
  const variants = [token, JSON.stringify(token).slice(1, -1)];
  try {
    variants.push(encodeURIComponent(token));
  } catch {
    /* Malformed Unicode has no URI encoding; still redact raw and JSON forms. */
  }
  for (const value of new Set(variants)) {
    if (value) text = text.split(value).join("[REDACTED]");
  }
  return redactWsString(text);
}

export function redactRtcValue(value: JsonValue, token: string): JsonValue {
  const clean = (entry: JsonValue): JsonValue => {
    if (typeof entry === "string") return redactRtcText(entry, token);
    if (Array.isArray(entry)) return entry.map(clean);
    if (entry !== null && typeof entry === "object")
      return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, clean(child)]));
    return entry;
  };
  return clean(redactWs(value));
}

export class RtcLogCollector {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private dropping = false;
  private output = "";
  private truncated = false;

  constructor(
    private token: string,
    private maxBytes = 16_384,
  ) {}

  write(bytes: Buffer): void {
    const chunks = this.decoder.write(bytes).split("\n");
    for (const [index, chunk] of chunks.entries()) {
      if (!this.dropping) {
        this.pending += chunk;
        if (Buffer.byteLength(this.pending) > 65536) {
          this.pending = "";
          this.dropping = true;
          this.truncated = true;
        }
      }
      if (index < chunks.length - 1) {
        if (!this.dropping) this.append(this.pending + "\n");
        this.pending = "";
        this.dropping = false;
      }
    }
  }

  finish(): string {
    this.pending += this.decoder.end();
    // EOF may be a killed worker in the middle of emitting a credential.
    if (this.pending) this.truncated = true;
    this.pending = "";
    return this.output.trim() + (this.truncated ? " [native logs truncated]" : "");
  }

  private append(line: string): void {
    const safe = Buffer.from(redactRtcText(line, this.token));
    const remaining = Math.max(0, this.maxBytes - Buffer.byteLength(this.output));
    this.output += safe.subarray(0, remaining).toString("utf8");
    if (safe.length > remaining) this.truncated = true;
  }
}
