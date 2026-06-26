export function readPath(obj: unknown, path: string): unknown {
  const clean = path.startsWith("$.") ? path.slice(2) : path;
  if (!clean) throw new Error("status path must be a non-empty dotted path");
  if (clean.includes(".."))
    throw new Error("Recursive descent is not supported; use a dotted path");
  if (clean.includes("*")) {
    throw new Error("Wildcards use [] for arrays (e.g. voices[].name); * is not supported");
  }
  const segments = clean.split(".");
  // [] is only valid as a whole segment ([]) or a segment suffix (key[]); reject
  // [0]-style indexing (use .0) and malformed segments like foo[]bar.
  for (const segment of segments) {
    if ((segment.includes("[") || segment.includes("]")) && !/^[^[\]]*\[\]$/u.test(segment)) {
      throw new Error(
        "Only dotted paths and [] array projection are supported, e.g. data.items.0.status or voices[].name",
      );
    }
  }
  return walk(obj, segments);
}

function walk(current: unknown, segments: string[]): unknown {
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment) throw new Error("status path must be a dotted path without empty segments");
    if (segment.endsWith("[]")) {
      const key = segment.slice(0, -2);
      const target = key ? indexInto(current, key) : current;
      if (!Array.isArray(target)) return undefined;
      const rest = segments.slice(index + 1);
      // rest === [] → returns each element verbatim (voices[] yields the array).
      // Nested wildcards (a[].b[].c) group per level (array-of-arrays), preserving
      // structure rather than flattening into one stream.
      return target.map((element) => walk(element, rest));
    }
    current = indexInto(current, segment);
    if (current === undefined) return undefined;
  }
  return current;
}

function indexInto(current: unknown, segment: string): unknown {
  if (Array.isArray(current) && /^\d+$/u.test(segment)) return current[Number(segment)];
  if (isRecord(current)) return current[segment];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
