import { DEFAULT_RETRY_ATTEMPTS } from "./retries";
import { probeDurationSeconds } from "./duration";
import type { AgentInput, OperationCard, RunOpts, Warning } from "./types";

export const GUARDED_HINTS = new Set([
  "characters",
  "audio_seconds",
  "per_generation",
  "per_source_minute",
]);

export interface EstimateDetail {
  credits: number | null;
  warnings: Warning[];
}

export async function estimateCredits(
  op: OperationCard,
  input: AgentInput,
  opts: RunOpts,
): Promise<number | null> {
  return (await estimateDetail(op, input, opts)).credits;
}

export async function estimateDetail(
  op: OperationCard,
  input: AgentInput,
  opts: RunOpts,
): Promise<EstimateDetail> {
  const warnings: Warning[] = [];
  if (!op.costHint || !GUARDED_HINTS.has(op.costHint)) return { credits: null, warnings };

  const credits = multiplyRetries(await baseEstimate(op, input, warnings), opts);
  return { credits, warnings };
}

export function overBudget(estimate: number | null, opts: RunOpts): boolean {
  return estimate !== null && opts.maxCredits != null && estimate > opts.maxCredits;
}

async function baseEstimate(
  op: OperationCard,
  input: AgentInput,
  warnings: Warning[],
): Promise<number | null> {
  if (op.costHint === "characters") return characterCount(input, warnings);
  if (op.operationId === "sound_generation") return soundGenerationCredits(input);
  if (isMusicGeneration(op.operationId)) {
    warnings.push({
      code: "generated_length_unknown",
      message: "Generated length unknown; using 5-minute cap.",
    });
    return 900 * 5;
  }
  if (op.operationId === "separate_song_stems") {
    warnings.push({
      code: "coarse_estimate",
      message: "Stem separation cost is estimated as a flat 100 credits.",
    });
    return 100;
  }
  if (isAudioSecondsOperation(op.operationId))
    return durationCredits(input, creditsPerAudioMinute(op.operationId), warnings);
  if (isSourceMinuteOperation(op.operationId)) return sourceMinuteCredits(input, warnings);
  return null;
}

function multiplyRetries(credits: number | null, opts: RunOpts): number | null {
  return credits === null ? null : credits * (opts.retryPost ? DEFAULT_RETRY_ATTEMPTS : 1);
}

function characterCount(input: AgentInput, warnings: Warning[]): number {
  if (detectSharedVoice(input)) {
    warnings.push({
      code: "shared_voice_lower_bound",
      message: "Shared/library voice multiplier is unknown; estimate is a lower bound.",
    });
  }
  return textFromBody(input.body).length * ttsCreditFactor(input.body);
}

// Flash/Turbo models bill at 0.5 credits/char via the API; all other models at 1.0.
// Unknown/unset model_id defaults to 1.0 (conservative for the pre-flight guard).
function ttsCreditFactor(body: unknown): number {
  const modelId = isRecord(body) && typeof body.model_id === "string" ? body.model_id : "";
  return /flash|turbo/iu.test(modelId) ? 0.5 : 1;
}

function textFromBody(body: unknown): string {
  if (!isRecord(body)) return "";
  if (typeof body.text === "string") return body.text;
  if (Array.isArray(body.inputs)) {
    return body.inputs
      .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .join("");
  }
  return "";
}

function soundGenerationCredits(input: AgentInput): number {
  const duration = numberAt(input.body, "duration_seconds");
  return duration ? 11 * duration : 100;
}

async function durationCredits(
  input: AgentInput,
  creditsPerMinute: number,
  warnings: Warning[],
): Promise<number | null> {
  const duration = await inputDurationSeconds(input);
  if (duration === null) {
    warnings.push({
      code: "duration_unknown",
      message: "Duration unknown; budget estimate unavailable.",
    });
    return null;
  }
  return (creditsPerMinute * Math.ceil(duration)) / 60;
}

async function sourceMinuteCredits(input: AgentInput, warnings: Warning[]): Promise<number | null> {
  const duration = await inputDurationSeconds(input);
  if (duration === null) {
    warnings.push({
      code: "duration_unknown",
      message: "Duration unknown; budget estimate unavailable.",
    });
    return null;
  }
  return 10_000 * (Math.ceil(duration) / 60) * targetLanguageCount(input.body);
}

async function inputDurationSeconds(input: AgentInput): Promise<number | null> {
  const filePath = firstFile(input.files);
  return filePath ? probeDurationSeconds(filePath) : null;
}

function firstFile(files: AgentInput["files"]): string | null {
  if (!files) return null;
  for (const value of Object.values(files)) {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}

function creditsPerAudioMinute(operationId: string): number {
  // Scribe STT bills ~27 credits/min via the API — empirically 51 credits for a ~115s scribe_v1
  // clip (confirmed against the account meter), cross-checked against $0.22/hr. The 330/min figure
  // on the pricing help page is a non-API/legacy rate that overestimates API STT by ~12x.
  if (operationId === "speech_to_text" || operationId === "transcribe") return 27;
  return 1_000;
}

function isAudioSecondsOperation(operationId: string): boolean {
  return (
    operationId === "speech_to_text" ||
    operationId === "transcribe" ||
    operationId.startsWith("speech_to_speech_") ||
    operationId.startsWith("audio_isolation")
  );
}

function isMusicGeneration(operationId: string): boolean {
  return (
    operationId === "generate" ||
    operationId === "stream_compose" ||
    operationId.startsWith("compose_") ||
    operationId === "video_to_music"
  );
}

function isSourceMinuteOperation(operationId: string): boolean {
  return ["create_dubbing", "dub", "add_language", "render", "translate"].includes(operationId);
}

function targetLanguageCount(body: unknown): number {
  if (!isRecord(body)) return 1;
  return languageCount(body.target_languages ?? body.target_lang);
}

function languageCount(value: unknown): number {
  if (Array.isArray(value)) return Math.max(1, value.length);
  if (typeof value === "string")
    return Math.max(1, value.split(",").filter((language) => language.trim()).length);
  return 1;
}

function detectSharedVoice(input: AgentInput): boolean {
  return [input.path, input.body].some(
    (value) =>
      isRecord(value) &&
      ["category", "source", "voice_type"].some(
        (key) =>
          String(value[key] ?? "")
            .toLowerCase()
            .includes("shared") ||
          String(value[key] ?? "")
            .toLowerCase()
            .includes("library"),
      ),
  );
}

function numberAt(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const number = Number(value[key]);
  return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
