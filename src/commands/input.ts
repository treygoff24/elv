import { resolve } from "node:path";
import { isRecord } from "../util/json";
import type { AgentInput } from "../core/types";
import type { JsonObjectInput } from "../util/json";

export function addPairs(
  input: AgentInput,
  bucket: "query" | "path",
  pairs: string[] | undefined,
): void {
  if (!pairs || pairs.length === 0) return;
  const current = bucketObject(input, bucket);
  for (const pair of pairs) {
    const { key, value } = parsePair(pair);
    if (bucket === "query" && key.endsWith("[]")) {
      const field = key.slice(0, -2);
      if (!field) throw new Error("Query array key must have a non-empty name before []");
      const previous = current[field];
      if (previous !== undefined && !Array.isArray(previous)) {
        throw new Error(`Query parameter "${field}" must be an array to append with ${key}`);
      }
      current[field] = [...(previous ?? []), value];
    } else {
      current[key] = value;
    }
  }
}

export function addFiles(input: AgentInput, files: string[] | undefined): void {
  if (!files || files.length === 0) return;
  const current = bucketObject(input, "files");
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

function bucketObject(input: AgentInput, bucket: "files"): NonNullable<AgentInput["files"]>;
function bucketObject(input: AgentInput, bucket: "query" | "path"): JsonObjectInput;
function bucketObject(input: AgentInput, bucket: "query" | "path" | "files"): JsonObjectInput {
  const existing = input[bucket];
  if (existing === undefined) {
    if (bucket === "files") {
      input.files = {};
      return input.files;
    }
    const next: JsonObjectInput = {};
    input[bucket] = next;
    return next;
  }
  if (!isRecord(existing)) {
    throw new Error(`${bucket} must be an object`);
  }
  return existing;
}
