import type { FileRecord } from "../core/types";
import type { RtcAction } from "./actions";

export const RTC_CLEANUP_STEP_MS = 750;
export const RTC_WORKER_EXIT_GRACE_MS = 4 * RTC_CLEANUP_STEP_MS + 2000;
export const RTC_WORKER_KILL_GRACE_MS = 500;
export const RTC_SUPERVISOR_GRACE_MS = RTC_WORKER_EXIT_GRACE_MS + RTC_WORKER_KILL_GRACE_MS + 1000;

export interface RtcAudioOutput {
  track_id: string;
  participant: string;
  path: string;
  sample_rate: number;
  channels: number;
  format: "pcm_s16le";
  bytes: number;
}

export interface RtcInfo {
  transport: "webrtc";
  events_sent: number;
  events_received: number;
  audio_input_bytes: number;
  audio_output_bytes: number;
  audio_tracks: RtcAudioOutput[];
  closed: boolean;
  timed_out: boolean;
  partial: boolean;
  reason: string;
}

export interface RtcSessionOptions {
  serverUrl: string;
  token: string;
  outDir: string;
  script: RtcAction[];
  duplex?: { input: NodeJS.ReadableStream; onEvent: (line: string) => void };
  timeoutMs?: number;
  signal?: AbortSignal;
  maxEventBytes?: number;
  maxAudioBytes?: number;
  maxTracks?: number;
}

export interface RtcSessionResult {
  rtc: RtcInfo;
  files: FileRecord[];
}

export interface WorkerOptions extends Omit<RtcSessionOptions, "signal" | "duplex"> {
  duplex: boolean;
  maxEventBytes: number;
  maxAudioBytes: number;
  maxTracks: number;
}

export interface OpenArtifact {
  path: string;
  temporary_path: string;
  mime: string;
  audio?: Omit<RtcAudioOutput, "path" | "bytes">;
}

export type ParentMessage =
  | { type: "start"; options: WorkerOptions }
  | { type: "action"; id: number; action: RtcAction }
  | { type: "input_end" }
  | { type: "stop"; reason: string };

export type WorkerMessage =
  | { type: "ready" }
  | { type: "ack"; id: number }
  | { type: "event"; line: string }
  | { type: "open_artifact"; artifact: OpenArtifact }
  | { type: "artifact"; file: FileRecord; audio?: RtcAudioOutput }
  | { type: "progress"; rtc: RtcInfo }
  | { type: "result"; result: RtcSessionResult; error?: { code: string; message: string } };

export function emptyRtcInfo(): RtcInfo {
  return {
    transport: "webrtc",
    events_sent: 0,
    events_received: 0,
    audio_input_bytes: 0,
    audio_output_bytes: 0,
    audio_tracks: [],
    closed: false,
    timed_out: false,
    partial: false,
    reason: "connecting",
  };
}
