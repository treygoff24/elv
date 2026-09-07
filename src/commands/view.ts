import { closeSync, openSync, readFileSync, readSync } from "node:fs";
import { basename, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { failure, success } from "../core/envelope";
import { validationError } from "../core/errors";
import { isSensitiveSpillFilename } from "../core/files";
import { SMALL_JSON_LIMIT, summarizeData } from "../core/response-normalizer";
import { containsCredential } from "../core/redaction";
import { ExitCode } from "../core/types";
import type { CommandResult, Hint } from "../core/types";
import { errorMessage } from "../util/error";
import { isRecord, JsonParseError, parseJson } from "../util/json";
import type { JsonValue } from "../util/json";
import { readPath } from "../util/jsonpath";
import { shellArg } from "../util/shell";
import type { CliOptionValues } from "./options";

interface ViewOptions extends Pick<CliOptionValues, "limit"> {
  path?: string;
}

/** `null` marks an invalid `--limit`; it is only reported after path resolution. */
type ParsedLimit = number | undefined | null;

export function buildViewResult(path: string, options: ViewOptions = {}): CommandResult {
  const cmd = `elv view ${path}`;
  const resolved = resolve(path);
  if (isSensitiveSpillFilename(basename(resolved))) return sensitiveRefusal(cmd, resolved);

  const limit = parseLimit(options.limit);
  return resolved.endsWith(".ndjson")
    ? viewNdjson(cmd, resolved, options, limit)
    : viewJson(cmd, resolved, options, limit);
}

/**
 * Whole-document JSON stays a single read: the file is already bounded by the spill
 * limit that produced it, and a streaming parser for arbitrary JSON is a separate
 * decision (it needs either a dependency or a hand-rolled parser).
 */
function viewJson(
  cmd: string,
  resolved: string,
  options: ViewOptions,
  limit: ParsedLimit,
): CommandResult {
  let parsed: JsonValue;
  try {
    parsed = parseJson(readFileSync(resolved, "utf8"), `File ${resolved}`);
  } catch (error) {
    return readFailure(cmd, resolved, error);
  }

  if (containsCredential(parsed)) return sensitiveRefusal(cmd, resolved);

  let value = parsed;
  if (options.path) {
    let selected: JsonValue | undefined;
    try {
      selected = readPath(parsed, options.path);
    } catch (error) {
      return { env: validationError(cmd, errorMessage(error)), exitCode: ExitCode.InputValidation };
    }
    if (selected === undefined) return pathNotFound(cmd, resolved, options.path);
    value = selected;
  }

  return renderValue(cmd, resolved, value, options.path, limit);
}

/**
 * NDJSON is read incrementally so peak memory tracks the selection, not the file.
 *
 * Three orderings from the whole-file implementation are load-bearing and preserved:
 * a malformed line anywhere aborts before any other verdict; a credential anywhere —
 * including on lines after the ones the caller asked for — refuses the whole file; and
 * `--path` errors are only reported once the file has been scanned clean. So the scan
 * always runs to EOF before an envelope is emitted, even when the requested rows are
 * already known.
 */
function viewNdjson(
  cmd: string,
  resolved: string,
  options: ViewOptions,
  limit: ParsedLimit,
): CommandResult {
  const selector = rowSelector(options.path);
  const rows = new ArrayAccumulator(limit ?? undefined);
  let indexed: JsonValue | undefined;
  let credential = false;
  let pathError: unknown;
  if (selector.kind === "invalid") pathError = selector.error;
  let rowNumber = 0;

  try {
    forEachNdjsonLine(resolved, (line) => {
      const row = parseJson(line, `NDJSON line ${rowNumber + 1}`);
      rowNumber += 1;
      if (!credential && containsCredential(row)) credential = true;
      if (pathError !== undefined) return;
      try {
        if (selector.kind === "all") rows.push(row);
        else if (selector.kind === "project") rows.push(projectRow(row, selector.rowPath));
        else if (selector.kind === "index" && rowNumber - 1 === selector.index) {
          indexed = readPath([row] as JsonValue, selector.rowPath);
        }
      } catch (error) {
        pathError = error;
      }
    });
  } catch (error) {
    return readFailure(cmd, resolved, error);
  }

  if (credential) return sensitiveRefusal(cmd, resolved);
  if (pathError !== undefined) {
    return {
      env: validationError(cmd, errorMessage(pathError)),
      exitCode: ExitCode.InputValidation,
    };
  }
  if (selector.kind === "none" || (selector.kind === "index" && indexed === undefined)) {
    return pathNotFound(cmd, resolved, options.path ?? "");
  }
  if (limit === null) {
    return {
      env: validationError(cmd, "--limit must be a positive integer"),
      exitCode: ExitCode.InputValidation,
    };
  }

  if (selector.kind === "index") {
    return renderValue(cmd, resolved, indexed as JsonValue, options.path, limit);
  }
  return renderAccumulated(cmd, resolved, rows, options.path);
}

/**
 * `readPath` over the whole document reduces, for a top-level NDJSON array, to one of
 * three shapes: a leading array index selects a single row, a leading `[]` projects the
 * remaining path across every row, and anything else cannot index an array at all. Each
 * row is evaluated through the same `readPath`, on a one-element array, so projection
 * grouping, `[]`-suffix rules, and thrown-path messages stay identical.
 */
type RowSelector =
  | { kind: "all" }
  | { kind: "index"; index: number; rowPath: string }
  | { kind: "project"; rowPath: string }
  | { kind: "none" }
  | { kind: "invalid"; error: unknown };

function rowSelector(path: string | undefined): RowSelector {
  if (!path) return { kind: "all" };
  try {
    // readPath validates the whole path before walking; an empty array walks the same
    // first segment a real document would, so every pre-walk rejection surfaces here.
    readPath([] as JsonValue, path);
  } catch (error) {
    return { kind: "invalid", error };
  }
  const clean = path.startsWith("$.") ? path.slice(2) : path;
  const segments = clean.split(".");
  const head = segments[0] ?? "";
  const rest = segments.slice(1);
  if (head === "[]") return { kind: "project", rowPath: ["[]", ...rest].join(".") };
  if (/^\d+$/u.test(head)) {
    return { kind: "index", index: Number(head), rowPath: ["0", ...rest].join(".") };
  }
  return { kind: "none" };
}

function projectRow(row: JsonValue, rowPath: string): JsonValue | undefined {
  const projected = readPath([row] as JsonValue, rowPath);
  return Array.isArray(projected) ? (projected[0] as JsonValue | undefined) : undefined;
}

/**
 * Retains the prefix of a streamed array that the envelope can still need: items up to
 * `--limit`, and only while the serialized result could still fit inline. Once the
 * inline threshold is passed the answer is a summary, so later items are counted but
 * dropped. The retained prefix always covers `summarizeData`'s preview, which stops at
 * 20 items or 4 KiB.
 */
class ArrayAccumulator {
  private readonly kept: (JsonValue | undefined)[] = [];
  /** Serialized byte length of `kept` as a JSON array, brackets included. */
  private bytes = 2;
  private retaining = true;
  private count = 0;

  constructor(private readonly limit: number | undefined) {}

  push(item: JsonValue | undefined): void {
    this.count += 1;
    if (!this.retaining) return;
    if (this.limit !== undefined && this.kept.length >= this.limit) {
      this.retaining = false;
      return;
    }
    this.bytes +=
      Buffer.byteLength(JSON.stringify(item) ?? "null") + (this.kept.length > 0 ? 1 : 0);
    this.kept.push(item);
    if (this.bytes >= SMALL_JSON_LIMIT) this.retaining = false;
  }

  /** Items the envelope would show: the whole stream, or `--limit` of it. */
  get shown(): number {
    return this.limit === undefined ? this.count : Math.min(this.count, this.limit);
  }

  get truncatedByLimit(): boolean {
    return this.limit !== undefined && this.count > this.limit;
  }

  /** True when the shown items cannot be inlined, so only a summary is retained. */
  get oversize(): boolean {
    return this.bytes >= SMALL_JSON_LIMIT;
  }

  get inlineItems(): JsonValue {
    return this.kept as JsonValue;
  }

  /** Retained prefix with the real length restored, for summary and hint shape only. */
  summaryShape(): JsonValue {
    const shape = this.kept.slice();
    shape.length = this.shown;
    return shape as JsonValue;
  }
}

function renderAccumulated(
  cmd: string,
  resolved: string,
  rows: ArrayAccumulator,
  jsonPath: string | undefined,
): CommandResult {
  if (!rows.oversize) {
    return {
      env: success({
        cmd,
        data: rows.inlineItems,
        ...(rows.truncatedByLimit ? { truncated: true } : {}),
      }),
      exitCode: ExitCode.Success,
    };
  }
  const shape = rows.summaryShape();
  return {
    env: success({
      cmd,
      data_summary: summarizeData(shape),
      truncated: true,
      hints: [narrowHint(resolved, shape, jsonPath)],
    }),
    exitCode: ExitCode.Success,
  };
}

function renderValue(
  cmd: string,
  resolved: string,
  selected: JsonValue,
  jsonPath: string | undefined,
  limit: ParsedLimit,
): CommandResult {
  if (limit === null) {
    return {
      env: validationError(cmd, "--limit must be a positive integer"),
      exitCode: ExitCode.InputValidation,
    };
  }

  let value = selected;
  let truncated = false;
  if (Array.isArray(value) && limit !== undefined) {
    if (value.length > limit) truncated = true;
    value = value.slice(0, limit);
  }

  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) < SMALL_JSON_LIMIT) {
    return {
      env: success({ cmd, data: value, ...(truncated ? { truncated: true } : {}) }),
      exitCode: ExitCode.Success,
    };
  }

  return {
    env: success({
      cmd,
      data_summary: summarizeData(value),
      truncated: true,
      hints: [narrowHint(resolved, value, jsonPath)],
    }),
    exitCode: ExitCode.Success,
  };
}

const NDJSON_CHUNK_BYTES = 64 * 1024;

/**
 * Reads an NDJSON file in fixed chunks and hands over one non-blank line at a time.
 * Only the partial trailing line is buffered, so memory tracks the longest record
 * rather than the file. Lines are passed through unmodified, exactly as the
 * whole-file split did.
 */
function forEachNdjsonLine(resolved: string, onLine: (line: string) => void): void {
  const fd = openSync(resolved, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const chunk = Buffer.allocUnsafe(NDJSON_CHUNK_BYTES);
    let pending = "";
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      pending += decoder.write(chunk.subarray(0, read));
      let start = 0;
      for (
        let newline = pending.indexOf("\n");
        newline >= 0;
        newline = pending.indexOf("\n", start)
      ) {
        const line = pending.slice(start, newline);
        start = newline + 1;
        if (line.trim().length > 0) onLine(line);
      }
      if (start > 0) pending = pending.slice(start);
    }
    pending += decoder.end();
    if (pending.trim().length > 0) onLine(pending);
  } finally {
    closeSync(fd);
  }
}

function readFailure(cmd: string, resolved: string, error: unknown): CommandResult {
  if (isNodeError(error) && NOT_FOUND_FS_CODES.has(error.code ?? "")) {
    return {
      env: failure({
        cmd,
        error: {
          type: "not_found_error",
          code: "not_found",
          message: `File not found: ${resolved}`,
        },
        retry: { recommended: false, after_ms: null },
        hints: [
          {
            cmd: "elv <prior-cmd>",
            why: "Check files[].path from the prior command's envelope.",
          },
        ],
      }),
      exitCode: ExitCode.NotFound,
    };
  }
  const message =
    error instanceof JsonParseError
      ? `File is not valid JSON: ${resolved}. Use cat to inspect raw contents.`
      : error instanceof Error
        ? error.message
        : String(error);
  return { env: validationError(cmd, message), exitCode: ExitCode.InputValidation };
}

function pathNotFound(cmd: string, resolved: string, jsonPath: string): CommandResult {
  return {
    env: validationError(cmd, `path "${jsonPath}" not found in ${resolved}`),
    exitCode: ExitCode.InputValidation,
  };
}

function sensitiveRefusal(cmd: string, resolved: string): CommandResult {
  return {
    env: validationError(cmd, `Refusing to render sensitive provider response: ${resolved}`, {
      hints: [
        {
          cmd: `cat ${shellArg(resolved)}`,
          why: "Read the credential directly from its restrictive file when you intend to reveal it.",
        },
      ],
    }),
    exitCode: ExitCode.InputValidation,
  };
}

// Filesystem errors that mean "no readable file at this path" — mapped to exit 9
// (not_found) rather than letting a raw ENOTDIR/ELOOP surface as a provider error.
const NOT_FOUND_FS_CODES = new Set(["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function parseLimit(value: string | number | undefined): ParsedLimit {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function narrowHint(filePath: string, value: JsonValue, jsonPath?: string): Hint {
  if (Array.isArray(value)) {
    // Drilling into the first element always shrinks the payload, so the hint converges;
    // suggesting `--limit` here would loop when individual items are themselves large.
    const nextPath = jsonPath ? `${jsonPath}.0` : "0";
    return {
      cmd: `elv view ${shellArg(filePath)} --path ${shellArg(nextPath)}`,
      why: "Inspect the first array item.",
    };
  }
  if (isRecord(value)) {
    const key = Object.keys(value)[0];
    if (key) {
      const nextPath = jsonPath ? `${jsonPath}.${key}` : key;
      return {
        cmd: `elv view ${shellArg(filePath)} --path ${shellArg(nextPath)}`,
        why: "Drill into a nested field.",
      };
    }
  }
  return {
    cmd: `elv view ${shellArg(filePath)}`,
    why: "Inspect spilled JSON without loading it into context.",
  };
}
