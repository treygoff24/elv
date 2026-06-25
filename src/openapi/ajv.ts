import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { AnySchema, ValidateFunction } from "ajv";
import type { OperationCard } from "../core/types";

export const OPENAPI_SCHEMA_BASE = "elv://openapi";

export function buildAjv(bundledSpec: unknown): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema(bundledSpec as AnySchema, OPENAPI_SCHEMA_BASE);
  return ajv;
}

export function getInputValidator(ajv: Ajv2020, op: OperationCard): ValidateFunction | null {
  if (!op.requestBody) return null;
  if (op.requestBody.schemaRef) {
    return ajv.getSchema(`${OPENAPI_SCHEMA_BASE}${op.requestBody.schemaRef}`) ?? null;
  }
  if (op.requestBody.schema) return ajv.compile(op.requestBody.schema as AnySchema);
  return null;
}
