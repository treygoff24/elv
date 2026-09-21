import type { AgentInput, Hint } from "../core/types";
import { isRecord } from "../util/json";

type InputPath = readonly [bucket: "body" | "files", field: string];

interface ExactlyOneInvariant {
  paths: readonly InputPath[];
  param: string;
  message: string;
  hints: readonly Hint[];
}

export interface InputInvariantFailure {
  message: string;
  param: string;
  raw: { expected: 1; present: string[] };
  hints: Hint[];
}

const INPUT_INVARIANTS: Readonly<Record<string, ExactlyOneInvariant>> = {
  speech_to_text: {
    paths: [
      ["files", "file"],
      ["body", "source_url"],
      ["body", "cloud_storage_url"],
    ],
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

export function validateInputInvariants(
  operationId: string,
  input: AgentInput,
): InputInvariantFailure | null {
  const invariant = INPUT_INVARIANTS[operationId];
  if (!invariant) return null;

  const present = invariant.paths.filter((path) => hasInput(input, path)).map(formatPath);
  if (present.length === 1) return null;

  return {
    message: invariant.message,
    param: invariant.param,
    raw: { expected: 1, present },
    hints: [...invariant.hints],
  };
}

function hasInput(input: AgentInput, [bucket, field]: InputPath): boolean {
  const value = bucket === "body" && isRecord(input.body) ? input.body : input[bucket];
  return isRecord(value) && Object.hasOwn(value, field) && value[field] !== undefined;
}

function formatPath([bucket, field]: InputPath): string {
  return `${bucket}.${field}`;
}
