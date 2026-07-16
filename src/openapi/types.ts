export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type Risk = "read" | "generate" | "mutate" | "destructive" | "external_side_effect";

/** Streaming is three different things; the runner branches on this. */
export type StreamKind = "none" | "audio_bytes" | "json_events" | "sse_events" | "text";

/** Budget guard keys on this (NOT the risk label). */
export type CostHint =
  | "characters"
  | "audio_seconds"
  | "per_generation"
  | "per_source_minute"
  | "slot"
  | "unknown";

export interface ParamCard {
  name: string;
  location: "path" | "query" | "header";
  required: boolean;
  /** JSON Schema fragment, bundled (internal $ref preserved). */
  schema: unknown;
  description?: string;
}

export interface BodyCard {
  contentType: string;
  required: boolean;
  /** $ref into components for Ajv validate-by-$ref (matches the bundle step). */
  schemaRef?: string;
  /** Inline schema when no top-level $ref is available. */
  schema?: unknown;
  multipart: boolean;
  /** Multipart fields that are file/binary parts. */
  fileFields?: string[];
}

export interface ResponseCard {
  status: string;
  contentType?: string;
  schema?: unknown;
  binary: boolean;
}

export interface ExampleCard {
  summary?: string;
  value: unknown;
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
