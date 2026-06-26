import { redact } from "./redaction";
import { ENVELOPE_VERSION } from "./types";
import type { Envelope, ErrorEnvelope, SuccessEnvelope } from "./types";

export function writeEnvelope(env: Envelope): void {
  process.stdout.write(`${JSON.stringify(redact(env))}\n`);
}

export function success(partial: Omit<SuccessEnvelope, "v" | "ok">): SuccessEnvelope {
  return { v: ENVELOPE_VERSION, ok: true, ...partial };
}

export function failure(partial: Omit<ErrorEnvelope, "v" | "ok">): ErrorEnvelope {
  return { v: ENVELOPE_VERSION, ok: false, ...partial };
}

interface DryRunInput {
  cmd: string;
  operationId?: string;
  request: unknown;
  creditsEstimated?: number | null;
  wouldRequireYes?: boolean;
  wouldExceedBudget?: boolean;
}

export function dryRun(input: DryRunInput): SuccessEnvelope {
  const creditsEstimated = input.creditsEstimated ?? null;
  return success({
    cmd: input.cmd,
    operation_id: input.operationId,
    cost: {
      credits_estimated: creditsEstimated,
      credits_charged: null,
      credits_source: "estimate",
    },
    data: {
      dry_run: true,
      request: redact(input.request),
      credits_estimated: creditsEstimated,
      would_require_yes: input.wouldRequireYes ?? false,
      would_exceed_budget: input.wouldExceedBudget ?? false,
    },
  });
}
