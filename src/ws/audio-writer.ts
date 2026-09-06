import { createHash } from "node:crypto";
import { join } from "node:path";
import { decodeBase64 } from "../core/encoding";
import { tempFileWriter } from "../core/files";
import { isRecord } from "../util/json";
import type { TempFileWriter } from "../core/files";
import type { Warning } from "../core/types";
import type { JsonValue } from "../util/json";

export interface AudioOutput {
  path: string;
  contextId: string | null;
}

interface ContextWriter extends AudioOutput {
  writer: TempFileWriter;
}

const DEFAULT_CONTEXT = "\0default";
const AUDIO_UNKNOWN_EXTENSION = "bin";

export class AudioWriter {
  private readonly writers = new Map<string, ContextWriter>();
  private readonly issues: Warning[] = [];
  private wroteAudio = false;

  constructor(
    private readonly dir: string,
    readonly outputFormat: string | undefined,
  ) {}

  get path(): string {
    return join(this.dir, `audio.${audioExtension(this.outputFormat)}`);
  }

  get hasData(): boolean {
    return this.wroteAudio;
  }

  get warnings(): Warning[] {
    if (!this.wroteAudio) return [];
    const unknownFormat: Warning[] =
      this.outputFormat === undefined
        ? [
            {
              code: "ws_audio_format_unknown",
              message: `This route does not declare an audio encoding, so the bytes were written to ${AUDIO_UNKNOWN_EXTENSION} without a format label; set --query output_format=... to name it.`,
            },
          ]
        : [];
    return [...unknownFormat, ...this.issues];
  }

  async writeFromEvent(event: JsonValue): Promise<boolean> {
    const audio = audioEvent(event, (warning) => this.recordIssue(warning));
    if (!audio) return false;
    const bytes = decodeBase64(audio.base64, "WebSocket event");
    const output = this.writerForContext(audio.contextId);
    await output.writer.write(bytes);
    this.wroteAudio = true;
    return true;
  }

  async closeAll(): Promise<AudioOutput[]> {
    return await Promise.all(
      [...this.writers.values()].map(async ({ writer, contextId }) => {
        const path = await writer.close();
        return { path, contextId };
      }),
    );
  }

  async abort(): Promise<void> {
    await Promise.all([...this.writers.values()].map(({ writer }) => writer.abort()));
  }

  private recordIssue(warning: Warning): void {
    if (this.issues.some((existing) => existing.code === warning.code)) return;
    this.issues.push(warning);
  }

  private writerForContext(contextId: string | null): ContextWriter {
    const key = contextId === null ? DEFAULT_CONTEXT : `context:${contextId}`;
    const existing = this.writers.get(key);
    if (existing) return existing;
    const path =
      contextId === null ? this.path : contextAudioPath(this.dir, contextId, this.outputFormat);
    const output = { path, contextId, writer: tempFileWriter(path) };
    this.writers.set(key, output);
    return output;
  }
}

function audioExtension(outputFormat: string | undefined): string {
  const value = outputFormat?.toLowerCase() ?? "";
  if (value.includes("wav")) return "wav";
  if (value.includes("pcm")) return "pcm";
  if (value.includes("opus")) return "opus";
  if (value.includes("ulaw") || value.includes("mulaw") || value.includes("mu_law")) return "ulaw";
  if (value.includes("alaw")) return "alaw";
  if (value.includes("mp3")) return "mp3";
  // Nothing named the encoding. Agent audio is whatever the agent is configured to
  // emit (often PCM or mu-law), so an .mp3 name would be a guess a downstream player
  // cannot detect; the warning on the envelope says the format is unknown.
  return AUDIO_UNKNOWN_EXTENSION;
}

function audioEvent(
  event: JsonValue,
  onIssue: (warning: Warning) => void,
): { base64: string; contextId: string | null } | null {
  if (!isRecord(event)) return null;
  const value = event.audio ?? event.audio_base64;
  const nestedValue =
    event.type === "audio" && isRecord(event.audio_event)
      ? event.audio_event.audio_base_64
      : undefined;
  const base64 =
    typeof value === "string" && value.length > 0
      ? value
      : typeof nestedValue === "string" && nestedValue.length > 0
        ? nestedValue
        : null;
  return base64 === null ? null : { base64, contextId: audioContextId(event, onIssue) };
}

function audioContextId(
  event: Record<string, JsonValue>,
  onIssue: (warning: Warning) => void,
): string | null {
  const camelPresent = Object.hasOwn(event, "contextId");
  const snakePresent = Object.hasOwn(event, "context_id");
  if (!camelPresent && !snakePresent) return null;
  const camel = event.contextId;
  const snake = event.context_id;
  // A malformed identifier is the provider's mistake, and rejecting it terminates a
  // session that is already being billed. Fall back to the default audio file and
  // report it; two identifiers that disagree stay an error because there is no
  // defensible file to pick.
  if (camelPresent && !isContextId(camel)) return unlabelledContext(onIssue, "contextId");
  if (snakePresent && !isContextId(snake)) return unlabelledContext(onIssue, "context_id");
  if (camelPresent && snakePresent && camel !== snake) {
    throw new Error("Conflicting WebSocket audio context identifiers");
  }
  return (camelPresent ? camel : snake) as string;
}

function isContextId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function unlabelledContext(onIssue: (warning: Warning) => void, field: string): null {
  onIssue({
    code: "ws_audio_context_id_invalid",
    message: `A provider event carried a ${field} that is not a non-empty string; its audio was written to the default audio file.`,
  });
  return null;
}

function contextAudioPath(
  dir: string,
  contextId: string,
  outputFormat: string | undefined,
): string {
  const slug = contextId
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  const digest = createHash("sha256").update(contextId).digest("hex").slice(0, 12);
  return join(dir, `audio.context-${slug || "id"}-${digest}.${audioExtension(outputFormat)}`);
}
