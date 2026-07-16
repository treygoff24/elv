import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnySchema, ValidateFunction } from "ajv";
import type { OpenApiDocument } from "./compile-spec";
import { SchemaResolutionError, type OperationCard } from "./types";

const OPENAPI_SCHEMA_BASE = "elv://openapi";

export function buildAjv(bundledSpec: OpenApiDocument): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
  addFormats(ajv);
  ajv.addSchema(bundledSpec as AnySchema, OPENAPI_SCHEMA_BASE);
  return ajv;
}

export function getInputValidator(ajv: Ajv2020, op: OperationCard): ValidateFunction | null {
  try {
    if (!op.requestBody) return null;
    if (op.requestBody.schemaRef) {
      const validator = ajv.getSchema(`${OPENAPI_SCHEMA_BASE}${op.requestBody.schemaRef}`);
      if (!validator) throw new Error(`missing ${op.requestBody.schemaRef}`);
      return validator;
    }
    if (op.requestBody.schema) {
      return ajv.compile(absoluteDocumentRefs(op.requestBody.schema) as AnySchema);
    }
    return null;
  } catch (error) {
    throw new SchemaResolutionError(op.operationId, error);
  }
}

function absoluteDocumentRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(absoluteDocumentRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "$ref" && typeof entry === "string" && entry.startsWith("#/")
        ? `${OPENAPI_SCHEMA_BASE}${entry}`
        : absoluteDocumentRefs(entry),
    ]),
  );
}
