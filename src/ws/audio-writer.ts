import { createHash } from "node:crypto";
import { join } from "node:path";
import { decodeBase64 } from "../core/encoding";
import { tempFileWriter } from "../core/files";
import { isRecord } from "../util/json";
import type { TempFileWriter } from "../core/files";
import type { JsonValue } from "../util/json";

export interface AudioOutput {
  path: string;
  contextId: string | null;
}

interface ContextWriter extends AudioOutput {
  writer: TempFileWriter;
}

const DEFAULT_CONTEXT = "\0default";

export class AudioWriter {
  private readonly writers = new Map<string, ContextWriter>();
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

  async writeFromEvent(event: JsonValue): Promise<boolean> {
    const audio = audioEvent(event);
    if (!audio) return false;
    const bytes = decodeBase64(audio.base64, "WebSocket event");
    const output = this.writerForContext(audio.contextId);
    await output.writer.write(bytes);
    this.wroteAudio = true;
    return true;
  }

  async close(): Promise<string | null> {
    const outputs = await this.closeAll();
    return outputs.find(({ contextId }) => contextId === null)?.path ?? null;
  }

  async closeAll(): Promise<AudioOutput[]> {
    return await Promise.all(
      [...this.writers.values()].map(async ({ writer, ...output }) => {
        await writer.close();
        return output;
      }),
    );
  }

  async abort(): Promise<void> {
    await Promise.all([...this.writers.values()].map(({ writer }) => writer.abort()));
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
  if (value.includes("pcm")) return "pcm";
  if (value.includes("opus")) return "opus";
  if (value.includes("ulaw") || value.includes("mulaw") || value.includes("mu_law")) return "ulaw";
  return "mp3";
}

function audioEvent(event: JsonValue): { base64: string; contextId: string | null } | null {
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
  return base64 === null ? null : { base64, contextId: audioContextId(event) };
}

function audioContextId(event: Record<string, JsonValue>): string | null {
  const camelPresent = Object.hasOwn(event, "contextId");
  const snakePresent = Object.hasOwn(event, "context_id");
  if (!camelPresent && !snakePresent) return null;
  const camel = event.contextId;
  const snake = event.context_id;
  if (camelPresent && (typeof camel !== "string" || camel.length === 0)) {
    throw new Error("Invalid WebSocket audio contextId");
  }
  if (snakePresent && (typeof snake !== "string" || snake.length === 0)) {
    throw new Error("Invalid WebSocket audio context_id");
  }
  if (camelPresent && snakePresent && camel !== snake) {
    throw new Error("Conflicting WebSocket audio context identifiers");
  }
  return (camelPresent ? camel : snake) as string;
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
