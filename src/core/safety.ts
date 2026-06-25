import type { OperationCard, RunOpts } from "./types";

export function enforceSafety(_op: OperationCard, _opts: RunOpts): void {
  // P7: --yes gates for destructive/external-side-effect operations.
}

export function requiresYes(_op: OperationCard): boolean {
  return false;
}
