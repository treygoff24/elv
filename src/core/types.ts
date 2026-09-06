import type { HttpMethod } from "../openapi/types";
import type { JsonInputValue, JsonObjectInput } from "../util/json";

export const ENVELOPE_VERSION = 1 as const;

/** §4 exit-code taxonomy — agents branch on these without parsing JSON. Keyed on body code, not HTTP status. */
export enum ExitCode {
  Success = 0,
  InputValidation = 2,
  AuthPermission = 3,
  ConfirmationRequired = 4,
  BudgetCeiling = 5,
  CreditExhausted = 6,
  TransientExhausted = 7,
  ProviderError = 8,
  NotFound = 9,
}

/** Canonical bucketed input to the runner. Flat JSON is normalized into this shape. */
export type AgentInput = JsonObjectInput & {
  path?: JsonObjectInput;
  query?: JsonObjectInput;
  body?: JsonInputValue;
  headers?: Record<string, string>;
  /** Resolved file uploads: field name → absolute path(s). `name[]` arrays collapse to string[]. */
  files?: Record<string, string | string[]>;
};

export interface RunOpts {
  /** Command path the caller invoked; aliases preserve it in envelopes and hints. */
  cmd?: string;
  dryRun?: boolean;
  yes?: boolean;
  maxCredits?: number;
  retryPost?: boolean;
  /** dir or single file (single-file ops only). */
  out?: string;
  allowUnknown?: boolean;
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
  /** Output may contain credentials and must not be rendered by `elv view`. */
  sensitive?: boolean;
  /** Valid bytes/events preserved after a provider stream failed. */
  partial?: boolean;
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
  timed_out: boolean;
  partial?: boolean;
}

interface EnvelopeBase {
  v: typeof ENVELOPE_VERSION;
  cmd: string;
  operation_id?: string;
  http?: HttpInfo;
  cost?: CostInfo;
  files?: FileRecord[];
  warnings?: Warning[];
  hints?: Hint[];
  ws?: WsInfo;
}

export interface SuccessEnvelope extends EnvelopeBase {
  ok: true;
  request?: RequestInfo;
  concurrency?: ConcurrencyInfo;
  data?: unknown;
  data_summary?: DataSummary;
  truncated?: boolean;
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

export interface ErrorEnvelope extends EnvelopeBase {
  ok: false;
  error: NormalizedError;
  retry?: RetryInfo;
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

export interface CommandResult {
  env: Envelope;
  exitCode: ExitCode;
}
