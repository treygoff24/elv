export function readPath(obj: unknown, path: string): unknown {
  const clean = path.startsWith("$.") ? path.slice(2) : path;
  if (!clean) throw new Error("status path must be a non-empty dotted path");
  if (clean.includes("..")) throw new Error("Recursive descent is not supported; use a dotted path");
  if (clean.includes("[") || clean.includes("]") || clean.includes("*")) {
    throw new Error("Only dotted path syntax is supported, e.g. data.items.0.status");
  }

  let current = obj;
  for (const segment of clean.split(".")) {
    if (!segment) throw new Error("status path must be a dotted path without empty segments");
    if (Array.isArray(current) && /^\d+$/u.test(segment)) {
      current = current[Number(segment)];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
