import type { JsonValue } from "../util/json";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export class SchemaResolutionError extends Error {
  constructor(operationId: string, cause: unknown) {
    super(
      `Cannot compile the request schema for ${operationId}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "SchemaResolutionError";
  }
}

export const RISKS = ["read", "mutate", "generate", "external_side_effect", "destructive"] as const;
export type Risk = (typeof RISKS)[number];

/** Streaming is three different things; the runner branches on this. */
export const STREAM_KINDS = ["none", "audio_bytes", "json_events", "sse_events", "text"] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];

/** Budget guard keys on this (NOT the risk label). */
export const COST_HINTS = [
  "characters",
  "audio_seconds",
  "per_generation",
  "per_source_minute",
  "slot",
  "unknown",
] as const;
export type CostHint = (typeof COST_HINTS)[number];

export interface ParamCard {
  name: string;
  location: "path" | "query" | "header";
  required: boolean;
  /** JSON Schema fragment, bundled (internal $ref preserved). */
  schema: JsonValue;
  description?: string;
}

export interface BodyCard {
  contentType: string;
  required: boolean;
  /** $ref into components for Ajv validate-by-$ref (matches the bundle step). */
  schemaRef?: string;
  /** Inline schema when no top-level $ref is available. */
  schema?: JsonValue;
  multipart: boolean;
  fileFields?: string[];
}

export interface ResponseCard {
  status: string;
  contentType?: string;
  schema?: JsonValue;
  binary: boolean;
}

export interface ExampleCard {
  summary?: string;
  value: JsonValue | undefined;
}

export interface OperationCard {
  operationId: string;
  method: HttpMethod;
  pathTemplate: string;
  /** from x-fern-sdk-group-name → tags → path */
  group: string[];
  summary?: string;
  description?: string;
  tags: string[];
  risk: Risk;
  pathParams: ParamCard[];
  queryParams: ParamCard[];
  headerParams: ParamCard[];
  /** bound to the -Input schema */
  requestBody?: BodyCard;
  responses: ResponseCard[];
  returnsBinary: boolean;
  returnsJson: boolean;
  streamKind: StreamKind;
  /** Successful JSON may contain a credential and must not be emitted inline. */
  secretResult?: boolean;
  costHint?: CostHint;
  deprecated: boolean;
  examples: ExampleCard[];
}
