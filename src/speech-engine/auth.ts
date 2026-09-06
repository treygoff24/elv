import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isRecord } from "../util/json";

// Public contract: elevenlabs-js SpeechEngineResource.ts at aa6976916c3c4a7d.
const ISSUER = "https://api.elevenlabs.io/convai/speech-engine";
const SUBJECT = "convai_speech_engine_upstream";

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("Invalid JWT encoding");
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) throw new Error("Noncanonical JWT encoding");
  return bytes;
}

export function verifySpeechEngineJwt(value: string | undefined, apiKey: string): boolean {
  if (!value || value.length > 8192 || !apiKey.trim()) return false;
  try {
    const parts = value
      .trim()
      .replace(/^bearer\s+/i, "")
      .split(".");
    if (parts.length !== 3) return false;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header: unknown = JSON.parse(decode(headerPart).toString("utf8"));
    const payload: unknown = JSON.parse(decode(payloadPart).toString("utf8"));
    if (!isRecord(header) || header.alg !== "HS256" || !isRecord(payload)) return false;
    const secret = createHash("sha256").update(apiKey.trim(), "utf8").digest();
    const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
    const actual = decode(signaturePart);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    if (payload.iss !== ISSUER || payload.sub !== SUBJECT) return false;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return false;
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return false;
    const now = Math.floor(Date.now() / 1000);
    return payload.exp + 60 >= now && payload.iat - 60 <= now;
  } catch {
    return false;
  }
}
