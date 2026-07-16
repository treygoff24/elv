export function decodeBase64(value: string, context: string): Buffer {
  const encoded = value.trim();
  const padding = encoded.indexOf("=");
  const unpadded = padding === -1 ? encoded : encoded.slice(0, padding);
  const suffix = padding === -1 ? "" : encoded.slice(padding);
  if (
    encoded.length === 0 ||
    !/^[A-Za-z0-9+/]+$/u.test(unpadded) ||
    !/^={0,2}$/u.test(suffix) ||
    unpadded.length % 4 === 1 ||
    (suffix.length > 0 && encoded.length % 4 !== 0)
  ) {
    throw new Error(`Invalid base64 audio in ${context}`);
  }
  return Buffer.from(encoded, "base64");
}
