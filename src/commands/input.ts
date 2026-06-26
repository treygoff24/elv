import { resolve } from "node:path";
import { isRecord } from "../util/json";

export function addPairs(
  input: Record<string, unknown>,
  bucket: "query" | "path",
  pairs: string[] | undefined,
): void {
  if (!pairs || pairs.length === 0) return;
  const current = bucketObject(input, bucket);
  for (const pair of pairs) {
    const { key, value } = parsePair(pair);
    current[key] = value;
  }
}

export function addFiles(input: Record<string, unknown>, files: string[] | undefined): void {
  if (!files || files.length === 0) return;
  const current = bucketObject(input, "files") as Record<string, string | string[]>;
  for (const file of files) {
    const { key, value } = parsePair(file);
    const field = key.endsWith("[]") ? key.slice(0, -2) : key;
    const path = resolve(value);
    if (key.endsWith("[]")) {
      const previous = current[field];
      current[field] = Array.isArray(previous)
        ? [...previous, path]
        : previous
          ? [previous, path]
          : [path];
    } else {
      current[field] = path;
    }
  }
}

function parsePair(pair: string): { key: string; value: string } {
  const index = pair.indexOf("=");
  if (index <= 0) throw new Error(`Expected key=value, got "${pair}"`);
  return { key: pair.slice(0, index), value: pair.slice(index + 1) };
}

function bucketObject(
  input: Record<string, unknown>,
  bucket: "query" | "path" | "files",
): Record<string, unknown> {
  const existing = input[bucket];
  if (existing === undefined) {
    const next: Record<string, unknown> = {};
    input[bucket] = next;
    return next;
  }
  if (!isRecord(existing)) {
    throw new Error(`${bucket} must be an object`);
  }
  return existing;
}
