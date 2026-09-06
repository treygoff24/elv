import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnySchema, ValidateFunction } from "ajv";
import type { OpenApiDocument } from "./compile-spec";
import type { JsonValue } from "../util/json";
import { SchemaResolutionError, type OperationCard } from "./types";

const OPENAPI_SCHEMA_BASE = "elv://openapi";

export function buildAjv(
  bundledSpec: OpenApiDocument,
  coerceTypes: boolean | "array" = false,
): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, coerceTypes });
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

function absoluteDocumentRefs(value: JsonValue): JsonValue {
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
export function compileParamSchema(
  ajv: Ajv2020,
  operationId: string,
  schema: JsonValue,
): ValidateFunction {
  try {
    // AJV cannot replace a root scalar; wrapping it makes any coercion observable.
    return ajv.compile({
      type: "object",
      properties: { value: absoluteDocumentRefs(schema) },
      required: ["value"],
    } as AnySchema);
  } catch (error) {
    throw new SchemaResolutionError(operationId, error);
  }
}
export function paramSchemaHasRef(schema: JsonValue): boolean {
  if (Array.isArray(schema)) return schema.some(paramSchemaHasRef);
  if (!schema || typeof schema !== "object") return false;
  return Object.entries(schema).some(
    ([key, entry]) => (key === "$ref" && typeof entry === "string") || paramSchemaHasRef(entry),
  );
}
