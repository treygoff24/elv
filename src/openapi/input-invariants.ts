import type { AgentInput, Hint } from "../core/types";
import { isRecord } from "../util/json";
import { shellArg } from "../util/shell";

type InputPath = readonly [bucket: "body" | "files", field: string];

interface ExactlyOneInvariant {
  paths: readonly InputPath[];
  exampleFileField?: string;
  multipartBodyFile?: { bodyField: string; fileField: string };
  param: string;
  message: string;
  hints: readonly Hint[];
}

export interface InputInvariantFailure {
  message: string;
  param: string;
  raw: { expected: 1; present: string[]; near_miss?: string };
  hints: Hint[];
}

const INPUT_INVARIANTS: Readonly<Record<string, ExactlyOneInvariant>> = {
  speech_to_text: {
    paths: [
      ["files", "file"],
      ["body", "source_url"],
      ["body", "cloud_storage_url"],
    ],
    exampleFileField: "file",
    multipartBodyFile: { bodyField: "file", fileField: "file" },
    param: "media_source",
    message:
      "speech_to_text requires exactly one media source: --file file=PATH, body.source_url, or body.cloud_storage_url",
    hints: [
      {
        cmd: `elv call speech_to_text --json '{"body":{"model_id":"scribe_v2"}}' --file file=./path/to/file --dry-run`,
        why: "Upload a local media file.",
      },
      {
        cmd: `elv call speech_to_text --json '{"body":{"model_id":"scribe_v2","source_url":"https://example.com/audio.mp3"}}' --dry-run`,
        why: "Transcribe media from a source_url instead.",
      },
    ],
  },
};

export function invariantExampleFileField(operationId: string): string | undefined {
  return INPUT_INVARIANTS[operationId]?.exampleFileField;
}

export function validateInputInvariants(
  operationId: string,
  input: AgentInput,
): InputInvariantFailure | null {
  const invariant = INPUT_INVARIANTS[operationId];
  if (!invariant) return null;

  const present = invariant.paths.filter((path) => hasInput(input, path)).map(formatPath);
  if (present.length === 1) return null;
  const nearMiss = multipartBodyFileNearMiss(invariant, input);

  return {
    message: nearMiss
      ? `${invariant.message}; body.${nearMiss.bodyField} is ignored for multipart uploads, so use --file ${nearMiss.fileField}=PATH instead of body.${nearMiss.bodyField}`
      : invariant.message,
    param: invariant.param,
    raw: {
      expected: 1,
      present,
      ...(nearMiss ? { near_miss: `body.${nearMiss.bodyField}` } : {}),
    },
    hints: nearMiss
      ? [multipartBodyFileReplay(operationId, input, nearMiss), ...invariant.hints.slice(1)]
      : [...invariant.hints],
  };
}

interface MultipartBodyFileNearMiss {
  bodyField: string;
  fileField: string;
  path: string;
}

function multipartBodyFileNearMiss(
  invariant: ExactlyOneInvariant,
  input: AgentInput,
): MultipartBodyFileNearMiss | null {
  const mapping = invariant.multipartBodyFile;
  if (!mapping || !isRecord(input.body)) return null;
  const value = input.body[mapping.bodyField];
  return typeof value === "string" && value.length > 0 ? { ...mapping, path: value } : null;
}

function multipartBodyFileReplay(
  operationId: string,
  input: AgentInput,
  nearMiss: MultipartBodyFileNearMiss,
): Hint {
  const body = Object.fromEntries(
    Object.entries(isRecord(input.body) ? input.body : {}).filter(
      ([field]) => field !== nearMiss.bodyField,
    ),
  );
  const replayInput = Object.keys(body).length > 0 ? { body } : {};
  return {
    cmd: `elv call ${operationId} --json ${shellArg(JSON.stringify(replayInput))} --file ${shellArg(`${nearMiss.fileField}=${nearMiss.path}`)} --dry-run`,
    why: `Upload body.${nearMiss.bodyField} with --file instead of JSON.`,
  };
}

function hasInput(input: AgentInput, [bucket, field]: InputPath): boolean {
  const value = bucket === "body" && isRecord(input.body) ? input.body : input[bucket];
  return isRecord(value) && Object.hasOwn(value, field) && isNonEmpty(value[field]);
}

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.some(isNonEmpty);
  return true;
}

function formatPath([bucket, field]: InputPath): string {
  return `${bucket}.${field}`;
}
