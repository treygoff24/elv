/**
 * Shared contract types for elv. Hand-authored from spec v2: §4 (envelope/exit codes),
 * §5 (input model), §7 (OperationCard), §13 (risk), §14 (cost). Both delegate lanes
 * import from here — this file IS the integration contract. Change only with coordinator
 * sign-off; lanes add module-internal types in their own files, not here.
 */

export const ENVELOPE_VERSION = 1 as const;

/** §4 exit-code taxonomy — agents branch on these without parsing JSON. Keyed on body code, not HTTP status. */
export enum ExitCode {
  Success = 0,
  InputValidation = 2, // invalid_parameters/validation_error/text_too_long/max_character_limit_exceeded, or our pre-flight (400 AND 422)
  AuthPermission = 3, // invalid_api_key/missing_api_key/forbidden/insufficient_permissions/feature_not_available/detected_unusual_activity
  ConfirmationRequired = 4, // --yes missing on destructive/external_side_effect op
  BudgetCeiling = 5, // --max-credits pre-flight blocked the call (no network)
  CreditExhausted = 6, // provider insufficient_credits/quota_exceeded (401 or 402)
  TransientExhausted = 7, // 429 + 5xx after retries, network failure
  ProviderError = 8, // other 4xx/5xx not covered above
  NotFound = 9, // 404, unknown operation_id
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

export type Risk = "read" | "generate" | "mutate" | "destructive" | "external_side_effect";

/** §6 — streaming is three different things; the runner branches on this. */
export type StreamKind = "none" | "audio_bytes" | "json_events" | "text";

/** §14 — budget guard keys on this (NOT the risk label). */
export type CostHint =
  | "characters"
  | "audio_seconds"
  | "per_generation"
  | "per_source_minute"
  | "slot"
  | "unknown";

// ---------------------------------------------------------------------------
// OpenAPI registry (compiler output) — §7
// ---------------------------------------------------------------------------

export interface ParamCard {
  name: string;
  location: "path" | "query" | "header";
  required: boolean;
  /** JSON Schema fragment, bundled (internal $ref preserved). */
  schema: unknown;
  description?: string;
}

export interface BodyCard {
  contentType: string; // application/json, multipart/form-data, ...
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
  status: string; // "200", "default", ...
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
  costHint?: CostHint;
  deprecated: boolean;
  examples: ExampleCard[];
}

// ---------------------------------------------------------------------------
// Input model — §5
// ---------------------------------------------------------------------------

/** Canonical bucketed input to the runner. Flat JSON is normalized into this shape. */
export interface AgentInput {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Resolved file uploads: field name → absolute path(s). `name[]` arrays collapse to string[]. */
  files?: Record<string, string | string[]>;
}

export interface RunOpts {
  dryRun?: boolean;
  yes?: boolean;
  maxCredits?: number;
  retryPost?: boolean;
  /** dir or single file (single-file ops only). */
  out?: string;
  allowUnknown?: boolean;
  unpack?: boolean;
  hash?: boolean;
  // resolved runtime/config
  baseUrl?: string;
  apiKey?: string;
  profile?: string;
}

// ---------------------------------------------------------------------------
// Envelope — §4 / §6
// ---------------------------------------------------------------------------

export interface HttpInfo {
  status: number | null;
  method: HttpMethod;
  path: string;
}

export interface RequestInfo {
  id: string | null;
  trace_id: string | null;
  song_id: string | null;
}

export interface ConcurrencyInfo {
  current: number | null;
  max: number | null;
}

export type CreditsSource = "estimate" | "header" | "none";

export interface CostInfo {
  credits_estimated: number | null;
  credits_charged: number | null;
  credits_source: CreditsSource;
}

export interface FileRecord {
  path: string;
  mime: string;
  bytes: number;
  /** sha256 hex, or null when skipped (size-capped per §6). */
  sha256?: string | null;
}

export interface Warning {
  code: string;
  message: string;
}

export interface Hint {
  cmd: string;
  why?: string;
}

export interface DataSummary {
  type: string;
  count?: number;
  preview_count?: number;
  preview?: unknown[];
}

export interface WsInfo {
  catalog: string | null;
  path: string;
  events_sent: number;
  events_received: number;
  closed: boolean;
}

export interface SuccessEnvelope {
  v: typeof ENVELOPE_VERSION;
  ok: true;
  cmd: string;
  operation_id?: string;
  http?: HttpInfo;
  request?: RequestInfo;
  concurrency?: ConcurrencyInfo;
  cost?: CostInfo;
  data?: unknown;
  data_summary?: DataSummary;
  files?: FileRecord[];
  truncated?: boolean;
  warnings?: Warning[];
  hints?: Hint[];
  ws?: WsInfo;
}

/** §4 — normalized from all FOUR provider detail variants (array / rich-object / legacy / string). */
export interface NormalizedError {
  type: string;
  code: string;
  message: string;
  param?: string | null;
  request_id?: string | null;
  /** full provider body, always preserved. */
  raw?: unknown;
}

export interface RetryInfo {
  recommended: boolean;
  after_ms: number | null;
}

export interface ErrorEnvelope {
  v: typeof ENVELOPE_VERSION;
  ok: false;
  cmd: string;
  operation_id?: string;
  http?: HttpInfo;
  error: NormalizedError;
  retry?: RetryInfo;
  cost?: CostInfo;
  warnings?: Warning[];
  hints?: Hint[];
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;
