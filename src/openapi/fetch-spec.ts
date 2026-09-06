import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileSpec } from "./compile-spec";
import {
  readRegistryCache,
  registryCachePath,
  specCounts,
  specProvenance,
  vendoredSpecMetaPath,
  vendoredSpecPath,
  writeRegistryCache,
} from "./registry";
import { parseJson, parseJsonRecord } from "../util/json";
import { errorMessage } from "../util/error";
import type { CompileSpecResult } from "./compile-spec";
import type { RegistryCache, RegistryOptions, SpecCounts, SpecProvenance } from "./registry";
import type { OperationCard } from "./types";
import type { JsonObject } from "../util/json";

const LIVE_SPEC_URL = "https://api.elevenlabs.io/openapi.json";
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SPEC_BYTES = 20_000_000;

export interface UpdateSpecOptions extends RegistryOptions {
  from?: string;
  offline?: boolean;
  dryRun?: boolean;
  specUrl?: string;
}

interface SpecDiff {
  baseline: SpecProvenance | "unknown";
  candidate: SpecProvenance;
  counts: { baseline: SpecCounts; candidate: SpecCounts };
  added_operations: string[];
  removed_operations: string[];
  changed_operations: string[];
  local_curation_changes: {
    risk: string[];
    cost: string[];
    stream: string[];
  };
  newly_deprecated_operations: string[];
  no_longer_deprecated_operations: string[];
  added_schemas: string[];
  removed_schemas: string[];
  changed_schemas: number;
}

export interface SpecUpdateResult {
  operations: number;
  totalOperations: number;
  skippedOperations: number;
  cachePath: string;
  written: boolean;
  provenance: SpecProvenance;
  diff: SpecDiff;
}

interface SpecStatus {
  cache_path: string;
  vendored: SpecProvenance;
  active: {
    present: boolean;
    provenance: SpecProvenance | "unknown";
    counts: SpecCounts | null;
  };
  active_differs_from_vendored: boolean | null;
}

interface SpecDocument {
  document: JsonObject;
  rawText: string;
  source: "offline" | "file" | "url";
  label: string;
  retrievedAt?: string;
}

interface ComparableSpec {
  compiled: CompileSpecResult;
  provenance: SpecProvenance | "unknown";
}

export type VendoredMetadata = JsonObject &
  Pick<SpecProvenance, "source" | "retrieved_at" | "sha256">;

export class SpecInputError extends Error {
  constructor(
    message: string,
    public readonly raw?: JsonObject,
  ) {
    super(message);
    this.name = "SpecInputError";
  }
}

export class SpecProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecProviderError";
  }
}

export async function updateSpecCache(options: UpdateSpecOptions = {}): Promise<SpecUpdateResult> {
  validateOptions(options);
  const candidate = await compileCandidate(options);
  const baseline = await activeBaseline(options);
  const diff = diffSpecs(baseline, candidate);
  const cachePath = registryCachePath(options);
  if (!options.dryRun) writeRegistryCache(candidate.compiled, candidate.provenance, options);
  return {
    operations: candidate.compiled.operations.length,
    totalOperations: candidate.compiled.totalOperations,
    skippedOperations: candidate.compiled.skippedOperations,
    cachePath,
    written: !options.dryRun,
    provenance: candidate.provenance,
    diff,
  };
}

export async function diffSpec(options: UpdateSpecOptions = {}): Promise<SpecUpdateResult> {
  return updateSpecCache({ ...options, dryRun: true });
}

export async function specStatus(options: RegistryOptions = {}): Promise<SpecStatus> {
  const vendored = await compileVendored(options.moduleUrl);
  const active = readRegistryCache(options);
  const activeProvenance = active?.provenance ?? "unknown";
  return {
    cache_path: registryCachePath(options),
    vendored: vendored.provenance,
    active: {
      present: active !== null,
      provenance: activeProvenance,
      counts: active ? countsForCache(active) : null,
    },
    active_differs_from_vendored:
      activeProvenance === "unknown"
        ? null
        : activeProvenance.sha256 !== vendored.provenance.sha256,
  };
}

async function compileCandidate(options: UpdateSpecOptions): Promise<{
  compiled: CompileSpecResult;
  provenance: SpecProvenance;
}> {
  const source = await documentForUpdate(options);
  let compiled: CompileSpecResult;
  try {
    compiled = await compileSpec({ document: source.document });
  } catch (error) {
    const message = `Invalid OpenAPI spec from ${source.label}: ${errorMessage(error)}`;
    if (source.source === "url") throw new SpecProviderError(message);
    throw new SpecInputError(message, { source: source.label });
  }
  return {
    compiled,
    provenance: specProvenance(compiled, source.rawText, source.label, source.retrievedAt),
  };
}

async function activeBaseline(options: RegistryOptions): Promise<ComparableSpec> {
  const cached = readRegistryCache(options);
  if (cached?.bundledSpec) {
    return {
      compiled: {
        bundledSpec: cached.bundledSpec,
        operations: cached.operations,
        totalOperations: cached.totalOperations,
        skippedOperations: cached.skippedOperations,
      },
      provenance: cached.provenance,
    };
  }
  return compileVendored(options.moduleUrl);
}

async function compileVendored(moduleUrl: string | URL = import.meta.url): Promise<{
  compiled: CompileSpecResult;
  provenance: SpecProvenance;
}> {
  const path = vendoredSpecPath(moduleUrl);
  const rawText = readBoundedFile(path);
  const document = parseSpecJson(rawText, path);
  const compiled = await compileSpec({ document });
  const metadata = readVendoredMetadata(moduleUrl);
  return {
    compiled,
    provenance: specProvenance(compiled, rawText, metadata.source, metadata.retrieved_at),
  };
}

async function documentForUpdate(options: UpdateSpecOptions): Promise<SpecDocument> {
  if (options.offline) {
    const path = vendoredSpecPath(options.moduleUrl);
    const rawText = readBoundedFile(path);
    const metadata = readVendoredMetadata(options.moduleUrl);
    return {
      document: parseSpecJson(rawText, path),
      rawText,
      source: "offline",
      label: metadata.source,
      retrievedAt: metadata.retrieved_at,
    };
  }
  const configuredUrl = options.specUrl ?? process.env.ELV_SPEC_URL ?? LIVE_SPEC_URL;
  const from = options.from ?? configuredUrl;
  if (/^https?:\/\//iu.test(from)) {
    const rawText = await fetchSpec(from);
    return {
      document: parseFetchedJson(rawText, from),
      rawText,
      source: "url",
      label: from,
    };
  }
  const path = resolve(from);
  const rawText = readBoundedFile(path);
  return { document: parseSpecJson(rawText, path), rawText, source: "file", label: path };
}

function validateOptions(options: UpdateSpecOptions): void {
  if (options.offline && options.from)
    throw new SpecInputError("Use only one of --offline or --from", {
      offline: true,
      from: options.from,
    });
}

function readBoundedFile(path: string): string {
  let value: Buffer;
  try {
    value = readFileSync(path);
  } catch (error) {
    throw new SpecInputError(`Unable to read OpenAPI spec ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
  if (value.byteLength > MAX_SPEC_BYTES)
    throw new SpecInputError(
      `OpenAPI spec ${path} exceeds the ${MAX_SPEC_BYTES}-byte download limit`,
      { path, bytes: value.byteLength, max_bytes: MAX_SPEC_BYTES },
    );
  return value.toString("utf8");
}

function parseSpecJson(rawText: string, path: string): JsonObject {
  try {
    return parseJson(rawText, path) as JsonObject;
  } catch (error) {
    throw new SpecInputError(`Invalid JSON in OpenAPI spec ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
}

function parseFetchedJson(rawText: string, url: string): JsonObject {
  try {
    return parseJson(rawText, url) as JsonObject;
  } catch (error) {
    throw new SpecProviderError(
      `Failed to parse fetched OpenAPI spec from ${url}: ${errorMessage(error)}`,
    );
  }
}

async function fetchSpec(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new SpecProviderError(`Failed to fetch OpenAPI spec from ${url}: ${errorMessage(error)}`);
  }
  const requestedOrigin = new URL(url).origin;
  const responseOrigin = response.url ? new URL(response.url).origin : requestedOrigin;
  if (responseOrigin !== requestedOrigin) {
    throw new SpecProviderError(
      `Refusing cross-origin redirect while fetching OpenAPI spec: ${requestedOrigin} to ${responseOrigin}`,
    );
  }
  if (!response.ok)
    throw new SpecProviderError(`Failed to fetch OpenAPI spec: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_SPEC_BYTES)
    throw new SpecProviderError(`OpenAPI spec exceeds the ${MAX_SPEC_BYTES}-byte download limit`);
  if (!response.body) return "";

  try {
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SPEC_BYTES)
        throw new SpecProviderError(
          `OpenAPI spec exceeds the ${MAX_SPEC_BYTES}-byte download limit`,
        );
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof SpecProviderError) throw error;
    throw new SpecProviderError(`Failed to fetch OpenAPI spec from ${url}: ${errorMessage(error)}`);
  }
}

function diffSpecs(
  baseline: ComparableSpec,
  candidate: { compiled: CompileSpecResult; provenance: SpecProvenance },
): SpecDiff {
  const before = new Map(
    baseline.compiled.operations.map((operation) => [operation.operationId, operation]),
  );
  const after = new Map(
    candidate.compiled.operations.map((operation) => [operation.operationId, operation]),
  );
  const beforeIds = new Set(before.keys());
  const afterIds = new Set(after.keys());
  const sharedIds = [...beforeIds].filter((id) => afterIds.has(id));
  const beforeSchemas = baseline.compiled.bundledSpec.components?.schemas ?? {};
  const afterSchemas = candidate.compiled.bundledSpec.components?.schemas ?? {};
  const sharedSchemas = Object.keys(beforeSchemas).filter((name) => name in afterSchemas);

  return {
    baseline: baseline.provenance,
    candidate: candidate.provenance,
    counts: {
      baseline: specCounts(baseline.compiled),
      candidate: specCounts(candidate.compiled),
    },
    added_operations: sortedDifference(afterIds, beforeIds),
    removed_operations: sortedDifference(beforeIds, afterIds),
    changed_operations: sharedIds
      .filter(
        (id) =>
          canonical(upstreamFields(after.get(id)!)) !== canonical(upstreamFields(before.get(id)!)),
      )
      .sort(),
    local_curation_changes: {
      risk: changedField(sharedIds, before, after, "risk"),
      cost: changedField(sharedIds, before, after, "costHint"),
      stream: changedField(sharedIds, before, after, "streamKind"),
    },
    newly_deprecated_operations: sharedIds
      .filter((id) => !before.get(id)!.deprecated && after.get(id)!.deprecated)
      .sort(),
    no_longer_deprecated_operations: sharedIds
      .filter((id) => before.get(id)!.deprecated && !after.get(id)!.deprecated)
      .sort(),
    added_schemas: sortedDifference(
      new Set(Object.keys(afterSchemas)),
      new Set(Object.keys(beforeSchemas)),
    ),
    removed_schemas: sortedDifference(
      new Set(Object.keys(beforeSchemas)),
      new Set(Object.keys(afterSchemas)),
    ),
    changed_schemas: sharedSchemas.filter(
      (name) => canonical(beforeSchemas[name]) !== canonical(afterSchemas[name]),
    ).length,
  };
}

function upstreamFields(
  operation: OperationCard,
): Omit<OperationCard, "risk" | "costHint" | "streamKind"> {
  const { risk: _risk, costHint: _costHint, streamKind: _streamKind, ...upstream } = operation;
  return upstream;
}

function changedField<K extends "risk" | "costHint" | "streamKind">(
  ids: string[],
  before: Map<string, OperationCard>,
  after: Map<string, OperationCard>,
  field: K,
): string[] {
  return ids.filter((id) => before.get(id)![field] !== after.get(id)![field]).sort();
}

function sortedDifference(left: Set<string>, right: Set<string>): string[] {
  return [...left].filter((value) => !right.has(value)).sort();
}

function canonical(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => (entry === undefined ? "null" : canonical(entry))).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function countsForCache(cache: RegistryCache): SpecCounts {
  const { paths, total_operations, callable_operations, skipped_operations, schemas } =
    cache.provenance;
  return { paths, total_operations, callable_operations, skipped_operations, schemas };
}

/** Source URL, retrieval date, digest, and counts pinned alongside the vendored snapshot. */
export function readVendoredMetadata(moduleUrl: string | URL = import.meta.url): VendoredMetadata {
  const path = vendoredSpecMetaPath(moduleUrl);
  let metadata: JsonObject;
  try {
    metadata = parseJsonRecord(readFileSync(path, "utf8"), path);
  } catch (error) {
    throw new SpecInputError(`Invalid vendored OpenAPI metadata ${path}: ${errorMessage(error)}`, {
      path,
    });
  }
  if (
    typeof metadata.source === "string" &&
    typeof metadata.retrieved_at === "string" &&
    typeof metadata.sha256 === "string" &&
    isNonNegativeInteger(metadata.paths) &&
    isNonNegativeInteger(metadata.total_operations) &&
    isNonNegativeInteger(metadata.callable_operations) &&
    isNonNegativeInteger(metadata.skipped_operations) &&
    isNonNegativeInteger(metadata.schemas)
  ) {
    return {
      ...metadata,
      source: metadata.source,
      retrieved_at: metadata.retrieved_at,
      sha256: metadata.sha256,
    };
  }
  throw new SpecInputError(
    `Invalid vendored OpenAPI metadata ${path}: expected source, retrieved_at, sha256, and non-negative integer counts`,
    { path, metadata },
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
