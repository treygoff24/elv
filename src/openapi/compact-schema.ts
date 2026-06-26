import { resolveMaybeRef, resolveRef, schemaNameFromRef } from "./compile-spec";
import type { JsonObject, OpenApiDocument } from "./compile-spec";
import type { OperationCard, ParamCard } from "./types";

type CompactValue = string | number | boolean | null | JsonObject;
interface CompactBuckets {
  path: Record<string, CompactValue>;
  query: Record<string, CompactValue>;
  header: Record<string, CompactValue>;
  body: Record<string, CompactValue>;
}
export interface CompactSchema {
  required: CompactBuckets;
  optional: CompactBuckets;
}

export interface ExampleCommand {
  cmd: string;
}

export function compactSchemaForOperation(op: OperationCard, spec: OpenApiDocument): CompactSchema {
  const compact = emptyCompactSchema();
  addParams(compact, op.pathParams);
  addParams(compact, op.queryParams);
  addParams(compact, op.headerParams);
  addBody(compact, op, spec);
  return compact;
}

export function rawInputSchemaForOperation(op: OperationCard, spec: OpenApiDocument): unknown {
  if (!op.requestBody) return null;
  if (op.requestBody.schemaRef) return resolveRef(op.requestBody.schemaRef, spec);
  return op.requestBody.schema ?? null;
}

export function buildExampleCommand(op: OperationCard, spec: OpenApiDocument): ExampleCommand {
  const schema = compactSchemaForOperation(op, spec);
  const input = cleanEmptyBuckets({
    path: skeleton(schema.required.path),
    query: skeleton(schema.required.query),
    body: skeleton(schema.required.body),
    headers: skeleton(schema.required.header),
  });
  const out = op.returnsBinary || op.streamKind !== "none" ? " --out ./out" : "";
  return { cmd: `elv call ${op.operationId} --json '${JSON.stringify(input)}'${out}` };
}

function emptyCompactSchema(): CompactSchema {
  return {
    required: { path: {}, query: {}, header: {}, body: {} },
    optional: { path: {}, query: {}, header: {}, body: {} },
  };
}

function addParams(compact: CompactSchema, params: ParamCard[]): void {
  for (const param of params) {
    const bucket = param.required
      ? compact.required[param.location]
      : compact.optional[param.location];
    bucket[param.name] = compactValue(param.schema);
  }
}

function addBody(compact: CompactSchema, op: OperationCard, spec: OpenApiDocument): void {
  if (!op.requestBody) return;
  const schema = rawInputSchemaForOperation(op, spec);
  const object = asObject(resolveMaybeRef(schema, spec));
  const required = new Set(asStringArray(object.required));
  const properties = asObject(object.properties);
  if (Object.keys(properties).length === 0) {
    const target = op.requestBody.required ? compact.required.body : compact.optional.body;
    target.value = compactValue(object, spec);
    return;
  }

  for (const [name, property] of Object.entries(properties)) {
    const target = required.has(name) ? compact.required.body : compact.optional.body;
    target[name] = compactValue(
      property,
      spec,
      new Set(op.requestBody.schemaRef ? [op.requestBody.schemaRef] : []),
    );
  }
}

function compactValue(
  schema: unknown,
  spec?: OpenApiDocument,
  visited = new Set<string>(),
): CompactValue {
  const ref = refValue(schema);
  if (ref) {
    if (visited.has(ref)) return { $recursive: schemaNameFromRef(ref) };
    if (!spec) return { $ref: ref };
    return compactValue(resolveRef(ref, spec), spec, new Set([...visited, ref]));
  }

  const object = asObject(schema);
  const variant = firstUsefulVariant(object);
  if (variant) return compactValue(variant, spec, visited);

  if (Array.isArray(object.enum)) return { type: typeName(object) ?? "string", enum: object.enum };
  if (object.const !== undefined)
    return { type: typeName(object) ?? typeof object.const, const: object.const };

  const type = typeName(object);
  if (type === "array")
    return { type: "array", items: compactValue(object.items ?? {}, spec, visited) };
  if (type === "object" || Object.keys(asObject(object.properties)).length > 0) {
    const nested = Object.fromEntries(
      Object.entries(asObject(object.properties)).map(([name, property]) => [
        name,
        compactValue(property, spec, visited),
      ]),
    );
    return Object.keys(nested).length > 0 ? { type: "object", properties: nested } : "object";
  }
  return type ?? "unknown";
}

function firstUsefulVariant(object: JsonObject): unknown {
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = Array.isArray(object[key]) ? (object[key] as unknown[]) : [];
    const variant = variants.find((candidate) => typeName(asObject(candidate)) !== "null");
    if (variant) return variant;
  }
  return undefined;
}

function skeleton(bucket: Record<string, CompactValue>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(bucket).map(([name, shape]) => [name, placeholderFor(name, shape)]),
  );
}

function placeholderFor(name: string, shape: CompactValue): unknown {
  if (typeof shape === "string") {
    if (shape === "integer" || shape === "number") return 0;
    if (shape === "boolean") return false;
    if (shape === "array") return [];
    if (shape === "object") return {};
    return `<${name}>`;
  }
  const object = asObject(shape);
  if (Array.isArray(object.enum)) return object.enum[0] ?? `<${name}>`;
  if (object.type === "integer" || object.type === "number") return 0;
  if (object.type === "boolean") return false;
  if (object.type === "array") return [];
  if (object.type === "object") return {};
  return `<${name}>`;
}

function cleanEmptyBuckets(
  input: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => Object.keys(value).length > 0),
  );
}

function typeName(object: JsonObject): string | undefined {
  if (typeof object.type === "string") return object.type;
  if (Array.isArray(object.type))
    return object.type.find((entry): entry is string => entry !== "null");
  return undefined;
}

function refValue(value: unknown): string | undefined {
  const ref = asObject(value).$ref;
  return typeof ref === "string" ? ref : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
