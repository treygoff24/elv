import { join } from "node:path";
import { tempFileWriter } from "../core/files";
import { isRecord } from "../util/json";
import type { TempFileWriter } from "../core/files";

export class AudioWriter {
  private writer: TempFileWriter | null = null;
  private wroteAudio = false;

  constructor(
    private readonly dir: string,
    readonly outputFormat: string | undefined,
  ) {}

  get path(): string {
    return join(this.dir, `audio.${audioExtension(this.outputFormat)}`);
  }

  async writeFromEvent(event: unknown): Promise<boolean> {
    const audio = audioBase64(event);
    if (!audio) return false;
    this.writer ??= tempFileWriter(this.path);
    await this.writer.write(Buffer.from(audio, "base64"));
    this.wroteAudio = true;
    return true;
  }

  async close(): Promise<string | null> {
    if (!this.writer) return null;
    const path = await this.writer.close();
    return this.wroteAudio ? path : null;
  }

  async abort(): Promise<void> {
    await this.writer?.abort();
  }
}

function audioExtension(outputFormat: string | undefined): string {
  const value = outputFormat?.toLowerCase() ?? "";
  if (value.includes("pcm")) return "pcm";
  if (value.includes("opus")) return "opus";
  if (value.includes("ulaw") || value.includes("mulaw") || value.includes("mu_law")) return "ulaw";
  return "mp3";
}

function audioBase64(event: unknown): string | null {
  if (!isRecord(event)) return null;
  const value = event.audio ?? event.audio_base64;
  return typeof value === "string" && value.length > 0 ? value : null;
}
