import type { Command } from "commander";
import {
  readJsonBody,
  required,
  runAlias,
  type BuiltOperation,
  type JsonBodyFlags,
} from "./shared";

interface TranscriptFlags extends JsonBodyFlags {
  projectId?: string;
  languageId?: string;
  segmentId?: string;
}

function sourcePath(flags: TranscriptFlags): Record<string, string> {
  return { project_id: required(flags.projectId, "--project-id") };
}

function targetPath(flags: TranscriptFlags): Record<string, string> {
  return {
    ...sourcePath(flags),
    language_id: required(flags.languageId, "--language-id"),
  };
}

export function buildDubbingTranscriptGetInput(flags: TranscriptFlags): BuiltOperation {
  return { operationId: "dubbing_transcript_get", input: { path: sourcePath(flags) } };
}

export function buildDubbingTranscriptAddSegmentInput(flags: TranscriptFlags): BuiltOperation {
  return {
    operationId: "dubbing_transcript_segment_add",
    input: { path: sourcePath(flags), body: readJsonBody(flags) },
  };
}

export function buildDubbingTranscriptUpdateSegmentInput(flags: TranscriptFlags): BuiltOperation {
  return {
    operationId: "dubbing_transcript_segment_update",
    input: {
      path: { ...sourcePath(flags), segment_id: required(flags.segmentId, "--segment-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildDubbingTranscriptDeleteSegmentInput(flags: TranscriptFlags): BuiltOperation {
  return {
    operationId: "dubbing_transcript_segment_delete",
    input: {
      path: { ...sourcePath(flags), segment_id: required(flags.segmentId, "--segment-id") },
    },
  };
}

export function buildDubbingTargetTranscriptGetInput(flags: TranscriptFlags): BuiltOperation {
  return { operationId: "dubbing_target_transcript_get", input: { path: targetPath(flags) } };
}

export function buildDubbingTargetTranscriptUpdateSegmentInput(
  flags: TranscriptFlags,
): BuiltOperation {
  return {
    operationId: "dubbing_target_transcript_segment_update",
    input: {
      path: { ...targetPath(flags), segment_id: required(flags.segmentId, "--segment-id") },
      body: readJsonBody(flags),
    },
  };
}

export function buildDubbingTargetTranscriptRegenerateInput(
  flags: TranscriptFlags,
): BuiltOperation {
  return {
    operationId: "dubbing_target_transcript_regenerate",
    input: { path: targetPath(flags) },
  };
}

export function registerDubbingProjectCommand(
  program: Command,
  addCommonFlags: (command: Command) => Command,
): void {
  const project = program
    .command("dubbing-project")
    .description("Edit Dubbing Project transcripts (distinct from automatic Dubbing v2)");
  const transcript = project.command("transcript").description("Source transcript editing");
  addCommonFlags(
    transcriptCommand(transcript.command("get"), "Get the source transcript", false, false).action(
      (options: TranscriptFlags, command: Command) =>
        runAlias(buildDubbingTranscriptGetInput, options, command),
    ),
  );
  addCommonFlags(
    transcriptCommand(
      transcript.command("add-segment"),
      "Add a source segment",
      true,
      false,
    ).action((options: TranscriptFlags, command: Command) =>
      runAlias(buildDubbingTranscriptAddSegmentInput, options, command),
    ),
  );
  addCommonFlags(
    transcriptCommand(
      transcript.command("update-segment"),
      "Update a source segment",
      true,
      true,
    ).action((options: TranscriptFlags, command: Command) =>
      runAlias(buildDubbingTranscriptUpdateSegmentInput, options, command),
    ),
  );
  addCommonFlags(
    transcriptCommand(
      transcript.command("delete-segment"),
      "Delete a source segment (requires --yes)",
      false,
      true,
    ).action((options: TranscriptFlags, command: Command) =>
      runAlias(buildDubbingTranscriptDeleteSegmentInput, options, command),
    ),
  );

  const target = project
    .command("target-transcript")
    .description("Target-language transcript editing");
  addCommonFlags(
    targetCommand(target.command("get"), "Get a target transcript", false, false).action(
      (options: TranscriptFlags, command: Command) =>
        runAlias(buildDubbingTargetTranscriptGetInput, options, command),
    ),
  );
  addCommonFlags(
    targetCommand(
      target.command("update-segment"),
      "Update a translated segment",
      true,
      true,
    ).action((options: TranscriptFlags, command: Command) =>
      runAlias(buildDubbingTargetTranscriptUpdateSegmentInput, options, command),
    ),
  );
  addCommonFlags(
    targetCommand(
      target.command("regenerate"),
      "Regenerate a target dub from edited transcript",
      false,
      false,
    ).action((options: TranscriptFlags, command: Command) =>
      runAlias(buildDubbingTargetTranscriptRegenerateInput, options, command),
    ),
  );
}

function transcriptCommand(
  command: Command,
  description: string,
  body: boolean,
  segment: boolean,
): Command {
  command.description(description).option("--project-id <id>", "Dubbing Project id");
  if (segment) command.option("--segment-id <id>", "transcript segment id");
  return body ? jsonOptions(command) : command;
}

function targetCommand(
  command: Command,
  description: string,
  body: boolean,
  segment: boolean,
): Command {
  transcriptCommand(command, description, body, segment).option(
    "--language-id <id>",
    "target language id",
  );
  return command;
}

function jsonOptions(command: Command): Command {
  return command
    .option("--json <json>", "request body JSON")
    .option("--json-file <path>", "request body JSON file");
}
