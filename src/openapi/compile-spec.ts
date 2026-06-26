import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundle } from "@apidevtools/json-schema-ref-parser";
import { classifyRisk, costHintForOperationId } from "./risk";
import { parseJson } from "../util/json";
import type {
  BodyCard,
  ExampleCard,
  HttpMethod,
  OperationCard,
  ParamCard,
  ResponseCard,
  StreamKind,
} from "./types";

const METHODS = ["get", "post", "put", "patch", "delete", "head"] as const;
const METHOD_SET = new Set<string>(METHODS);
const BODY_TYPE_PREFERENCE = [
  "application/json",
  "multipart/form-data",
  "application/octet-stream",
  "text/plain",
];

export type JsonObject = Record<string, unknown>;
export interface OpenApiDocument extends JsonObject {
  paths: Record<string, JsonObject>;
  components: { schemas: Record<string, unknown> } & JsonObject;
}

interface CompileSpecOptions {
  sourcePath?: string;
  document?: unknown;
}

export interface CompileSpecResult {
  bundledSpec: OpenApiDocument;
  operations: OperationCard[];
  totalOperations: number;
  skippedOperations: number;
}

export async function compileSpec(options: CompileSpecOptions = {}): Promise<CompileSpecResult> {
  const source = await sourceForBundle(options);
  const bundledSpec = (await bundle(source)) as OpenApiDocument;
  const seen = new Set<string>();
  const operations: OperationCard[] = [];
  let totalOperations = 0;
  let skippedOperations = 0;

  for (const [pathTemplate, pathItem] of Object.entries(bundledSpec.paths ?? {})) {
    const pathParams = extractParameters(asArray(pathItem.parameters), bundledSpec);
    for (const [methodLower, rawOperation] of Object.entries(pathItem)) {
      if (!METHOD_SET.has(methodLower)) continue;
      totalOperations += 1;

      const operation = asObject(rawOperation);
      if (operation["x-skip-spec"] === true) {
        skippedOperations += 1;
        continue;
      }

      const operationId = stringValue(operation.operationId);
      if (!operationId)
        throw new Error(`Missing operationId for ${methodLower.toUpperCase()} ${pathTemplate}`);
      if (seen.has(operationId)) throw new Error(`Duplicate operationId: ${operationId}`);
      seen.add(operationId);

      const method = methodLower.toUpperCase() as HttpMethod;
      const allParams = [
        ...pathParams,
        ...extractParameters(asArray(operation.parameters), bundledSpec),
      ];
      const responses = extractResponses(asObject(operation.responses), bundledSpec);
      const cardBase = {
        operationId,
        method,
        pathTemplate,
        group: groupForOperation(operation, pathTemplate),
        summary: stringValue(operation.summary),
        description: stringValue(operation.description),
        tags: stringArray(operation.tags),
        pathParams: allParams.filter((param) => param.location === "path"),
        queryParams: allParams.filter((param) => param.location === "query"),
        headerParams: allParams.filter((param) => param.location === "header"),
        requestBody: extractRequestBody(operation.requestBody, bundledSpec),
        responses,
        returnsBinary: responses.some((response) => response.binary),
        returnsJson: responses.some((response) => isJsonContentType(response.contentType)),
        streamKind: streamKindForOperation(operation, responses),
        costHint: costHintForOperationId(operationId),
        deprecated: operation.deprecated === true,
        examples: extractExamples(operation),
      } satisfies Omit<OperationCard, "risk">;

      operations.push({ ...cardBase, risk: classifyRisk(cardBase) });
    }
  }

  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return { bundledSpec, operations, totalOperations, skippedOperations };
}

async function sourceForBundle(options: CompileSpecOptions): Promise<string | JsonObject> {
  if (options.document !== undefined) return options.document as JsonObject;
  const sourcePath = options.sourcePath ?? "spec/openapi.snapshot.json";
  if (options.sourcePath) return resolve(sourcePath);
  return parseJson(await readFile(resolve(sourcePath), "utf8"), sourcePath) as JsonObject;
}

function extractParameters(parameters: unknown[], spec: OpenApiDocument): ParamCard[] {
  return parameters
    .map((parameter) => resolveMaybeRef(parameter, spec))
    .map(asObject)
    .filter((parameter) => ["path", "query", "header"].includes(String(parameter.in)))
    .map((parameter) => ({
      name: String(parameter.name),
      location: parameter.in as ParamCard["location"],
      required: parameter.required === true || parameter.in === "path",
      schema: parameter.schema ?? {},
      description: stringValue(parameter.description),
    }));
}

function extractRequestBody(requestBody: unknown, spec: OpenApiDocument): BodyCard | undefined {
  if (requestBody === undefined) return undefined;
  const body = resolveMaybeRef(requestBody, spec);
  const content = asObject(asObject(body).content);
  const entry = preferredContentEntry(content);
  if (!entry) return undefined;

  const [contentType, media] = entry;
  const schema = asObject(media).schema;
  const schemaRef = refValue(schema);
  const schemaForFields = schemaRef ? resolveRef(schemaRef, spec) : schema;
  const multipart = contentType.toLowerCase().includes("multipart/form-data");

  return {
    contentType,
    required: asObject(body).required === true,
    schemaRef,
    schema: schemaRef ? undefined : schema,
    multipart,
    fileFields: multipart ? fileFieldsForSchema(schemaForFields, spec) : undefined,
  };
}

function extractResponses(responsesObject: JsonObject, spec: OpenApiDocument): ResponseCard[] {
  const responses: ResponseCard[] = [];
  for (const [status, rawResponse] of Object.entries(responsesObject)) {
    const response = resolveMaybeRef(rawResponse, spec);
    const content = asObject(asObject(response).content);
    const entries = Object.entries(content);
    if (entries.length === 0) {
      responses.push({ status, binary: false });
      continue;
    }
    for (const [contentType, media] of entries) {
      const schema = asObject(media).schema;
      responses.push({
        status,
        contentType,
        schema,
        binary: isBinaryContentType(contentType) || isBinarySchema(schema, spec),
      });
    }
  }
  return responses;
}

function preferredContentEntry(content: JsonObject): [string, JsonObject] | undefined {
  for (const contentType of BODY_TYPE_PREFERENCE) {
    const media = content[contentType];
    if (media !== undefined) return [contentType, asObject(media)];
  }
  const first = Object.entries(content)[0];
  return first ? [first[0], asObject(first[1])] : undefined;
}

function streamKindForOperation(operation: JsonObject, responses: ResponseCard[]): StreamKind {
  if (
    operation["x-fern-streaming"] === undefined &&
    operation["x-fern-sdk-streaming"] === undefined
  )
    return "none";
  const okResponse = responses.find((response) => response.status === "200") ?? responses[0];
  const contentType = okResponse?.contentType?.toLowerCase() ?? "";
  if (contentType.startsWith("audio/")) return "audio_bytes";
  if (isJsonContentType(contentType)) return "json_events";
  if (contentType.startsWith("text/")) return "text";
  return "none";
}

function groupForOperation(operation: JsonObject, pathTemplate: string): string[] {
  const fernGroup = operation["x-fern-sdk-group-name"];
  if (Array.isArray(fernGroup)) return fernGroup.map(String).filter(Boolean);
  if (typeof fernGroup === "string" && fernGroup) return [fernGroup];
  const tags = stringArray(operation.tags);
  if (tags.length > 0) return [tags[0] as string];
  const pathSegment = pathTemplate
    .split("/")
    .filter(Boolean)
    .find((part) => !/^v\d+$/iu.test(part));
  return [pathSegment ?? "root"];
}

function extractExamples(operation: JsonObject): ExampleCard[] {
  const examples: ExampleCard[] = [];
  const requestContent = asObject(asObject(operation.requestBody).content);
  for (const media of Object.values(requestContent).map(asObject)) {
    if (media.example !== undefined) examples.push({ value: media.example });
    for (const rawExample of Object.values(asObject(media.examples))) {
      const example = asObject(rawExample);
      examples.push({ summary: stringValue(example.summary), value: example.value });
    }
  }
  return examples;
}

function fileFieldsForSchema(schema: unknown, spec: OpenApiDocument): string[] {
  const resolved = resolveMaybeRef(schema, spec);
  const properties = asObject(asObject(resolved).properties);
  return Object.entries(properties)
    .filter(([, property]) => {
      const resolvedProperty = asObject(resolveMaybeRef(property, spec));
      return (
        isBinarySchema(property, spec) ||
        (resolvedProperty.type === "array" && isBinarySchema(resolvedProperty.items, spec))
      );
    })
    .map(([name]) => name);
}

function isBinarySchema(schema: unknown, spec: OpenApiDocument, seen = new Set<string>()): boolean {
  const ref = refValue(schema);
  if (ref) {
    if (seen.has(ref)) return false;
    seen.add(ref);
    return isBinarySchema(resolveRef(ref, spec), spec, seen);
  }
  const object = asObject(schema);
  if (object.format === "binary") return true;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = asArray(object[key]);
    if (variants.some((variant) => isBinarySchema(variant, spec, new Set(seen)))) return true;
  }
  return false;
}

function isBinaryContentType(contentType: string | undefined): boolean {
  const value = contentType?.toLowerCase() ?? "";
  return (
    value.startsWith("audio/") ||
    value === "application/zip" ||
    value === "application/x-zip" ||
    value === "application/octet-stream" ||
    /^application\/.*zip/iu.test(value)
  );
}

function isJsonContentType(contentType: string | undefined): boolean {
  const value = contentType?.toLowerCase() ?? "";
  return value === "application/json" || value.endsWith("+json");
}

export function resolveMaybeRef(value: unknown, spec: OpenApiDocument): unknown {
  const ref = refValue(value);
  return ref ? resolveRef(ref, spec) : value;
}

export function resolveRef(ref: string, spec: OpenApiDocument): unknown {
  if (!ref.startsWith("#/")) throw new Error(`Unsupported external ref after bundle: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"))
    .reduce<unknown>((current, part) => asObject(current)[part], spec);
}

export function schemaNameFromRef(ref: string): string {
  return ref.slice(ref.lastIndexOf("/") + 1);
}

function refValue(value: unknown): string | undefined {
  const ref = asObject(value).$ref;
  return typeof ref === "string" ? ref : undefined;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
