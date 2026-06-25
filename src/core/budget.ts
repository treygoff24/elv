import type { AgentInput, OperationCard, RunOpts } from "./types";

export function estimateCredits(_op: OperationCard, _input: AgentInput, _opts: RunOpts): number | null {
  // P7: real modality-specific estimates and --retry-post multiplier.
  return null;
}

export function enforceBudget(_estimate: number | null, _opts: RunOpts): void {
  // P7: --max-credits pre-flight guard.
}

export function overBudget(_estimate: number | null, _opts: RunOpts): boolean {
  return false;
}
