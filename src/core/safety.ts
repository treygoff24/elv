import type { OperationCard } from "../openapi/types";

export function requiresYes(op: OperationCard): boolean {
  return op.risk === "destructive" || op.risk === "external_side_effect";
}
