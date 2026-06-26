/** Shared runtime contract types for elv. OpenAPI operation-card types live in src/openapi/types. */

import type { HttpMethod } from "../openapi/types";

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
  baseUrl?: string;
  apiKey?: string;
  profile?: string;
}

interface HttpInfo {
  status: number | null;
  method: HttpMethod;
  path: string;
}

interface RequestInfo {
  id: string | null;
  trace_id: string | null;
  song_id: string | null;
}

interface ConcurrencyInfo {
  current: number | null;
  max: number | null;
}

type CreditsSource = "estimate" | "header" | "none";

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
