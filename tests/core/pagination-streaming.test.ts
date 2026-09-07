import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAllPages } from "../../src/core/pagination";
import { failure, success } from "../../src/core/envelope";
import type { Envelope, FileRecord } from "../../src/core/types";
import type { OperationCard } from "../../src/openapi/types";
import type { JsonValue } from "../../src/util/json";

let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "elv-pages-stream-"));
});

afterEach(() => {
  rmSync(out, { recursive: true, force: true });
});

function op(overrides: Partial<OperationCard> = {}): OperationCard {
  return {
    operationId: "list_things",
    method: "GET",
    pathTemplate: "/v1/convai/things",
    group: [],
    tags: [],
    risk: "read",
    pathParams: [],
    queryParams: [
      { name: "page_size", location: "query", required: false, schema: { type: "integer" } },
      { name: "cursor", location: "query", required: false, schema: { type: "string" } },
    ],
    headerParams: [],
    responses: [{ status: "200", contentType: "application/json", binary: false }],
    returnsBinary: false,
    returnsJson: true,
    streamKind: "none",
    deprecated: false,
    examples: [],
    ...overrides,
  };
}

function ok(data: JsonValue): Envelope {
  return success({ cmd: "elv call list_things", operation_id: "list_things", data, hints: [] });
}

/** Pages of `perPage` items, `pages` deep, cursor-linked exactly as the provider does. */
function pagedFetcher(pages: number, item: (page: number, index: number) => JsonValue) {
  let fetched = 0;
  const fetch = async (): Promise<Envelope> => {
    const page = fetched;
    fetched += 1;
    return ok({
      items: [item(page, 0)],
      next_cursor: page + 1 < pages ? `cur_${page + 1}` : null,
      has_more: page + 1 < pages,
    });
  };
  return {
    fetch,
    get calls() {
      return fetched;
    },
  };
}

/**
 * A distinct, fully materialized string per page. Built from a Buffer on purpose:
 * `"x".repeat(n)` and `padEnd` produce shared or lazily concatenated strings that never
 * show up in heap statistics, which would make a retention measurement read as clean
 * whether or not the pages are actually being accumulated.
 */
function blobOfSize(seed: number, size: number): string {
  return Buffer.alloc(size, 97 + (seed % 26)).toString("latin1");
}

function collectedFile(env: Envelope): { path: string; text: string } {
  if (!env.ok) throw new Error(`expected success: ${JSON.stringify(env)}`);
  const file = env.files?.find((candidate) => candidate.mime === "application/json");
  if (!file) throw new Error("expected a combined JSON artifact");
  return { path: file.path, text: readFileSync(file.path, "utf8") };
}

describe("--all streams pages to disk", () => {
  it("collects thousands of pages without inlining any of them", async () => {
    const pages = 3000;
    const pager = pagedFetcher(pages, (page) => ({ id: `thing-${page}` }));

    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      command: { kind: "call" },
      fetchPage: pager.fetch,
      maxPages: pages + 10,
    });

    expect(pager.calls).toBe(pages);
    if (!env.ok) throw new Error("expected success");
    expect(env.data).toBeUndefined();
    expect(env.data_summary).toEqual({ type: "array", count: pages });
    expect(env.truncated).toBe(true);
    expect(env.warnings).toBeUndefined();
    // The envelope stays a fixed-size handle to the artifact, whatever the page count.
    expect(Buffer.byteLength(JSON.stringify(env))).toBeLessThan(2048);

    const parsed = JSON.parse(collectedFile(env).text) as { id: string }[];
    expect(parsed).toHaveLength(pages);
    expect(parsed[0]).toEqual({ id: "thing-0" });
    expect(parsed[pages - 1]).toEqual({ id: "thing-2999" });
  });

  it("keeps peak memory flat while collecting far more items than fit in the envelope", async () => {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    const pages = 150;
    const bytesPerItem = 400_000;

    gc();
    const baseline = getHeapStatistics().used_heap_size;
    let peakDuringRun = 0;

    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      command: { kind: "call" },
      fetchPage: async () => {
        const page = fetched;
        fetched += 1;
        if (page === pages - 1) {
          // Everything collected so far is either on disk or unreachable; whatever is
          // still live after a full GC is what the collector actually retains.
          gc();
          peakDuringRun = getHeapStatistics().used_heap_size - baseline;
        }
        return ok({
          items: [{ id: page, blob: blobOfSize(page, bytesPerItem) }],
          next_cursor: page + 1 < pages ? `cur_${page + 1}` : null,
          has_more: page + 1 < pages,
        });
      },
      maxPages: pages + 10,
    });

    expect(fetched).toBe(pages);
    if (!env.ok) throw new Error("expected success");
    expect(env.data_summary?.count).toBe(pages);
    const collectedBytes = (pages - 1) * bytesPerItem;
    expect(collectedBytes).toBeGreaterThan(48 * 1024 * 1024);
    // Accumulating the pages in memory would retain all of collectedBytes.
    expect(peakDuringRun).toBeLessThan(collectedBytes / 4);

    const parsed = JSON.parse(collectedFile(env).text) as { id: number }[];
    expect(parsed).toHaveLength(pages);
    expect(parsed[pages - 1]?.id).toBe(pages - 1);
  });

  it("writes byte-identical output to the buffered JSON.stringify form", async () => {
    const items: JsonValue[] = [
      { id: "a", nested: { list: [1, 2, 3], flag: true }, note: "héllo — ünïcode" },
      [],
      {},
      null,
      "scalar",
      42,
      { deep: { deeper: [{ x: null }, { y: [] }] } },
    ];
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      command: { kind: "call" },
      fetchPage: async () => {
        const page = fetched;
        fetched += 1;
        return ok({
          items: [items[page] as JsonValue],
          next_cursor: page + 1 < items.length ? `cur_${page + 1}` : null,
          has_more: page + 1 < items.length,
        });
      },
    });

    expect(collectedFile(env).text).toBe(`${JSON.stringify(items, null, 2)}\n`);
  });

  it("writes an empty array when every page is empty", async () => {
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      command: { kind: "call" },
      fetchPage: async () => {
        const page = fetched;
        fetched += 1;
        return ok({ items: [], next_cursor: page === 0 ? "cur_1" : null, has_more: page === 0 });
      },
    });

    expect(fetched).toBe(2);
    if (!env.ok) throw new Error("expected success");
    expect(env.data_summary).toEqual({ type: "array", count: 0 });
    expect(collectedFile(env).text).toBe("[]\n");
  });

  it("publishes nothing when a later page fails, leaving no temporary file behind", async () => {
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      saveJson: join(out, "things.json"),
      command: { kind: "call" },
      fetchPage: async () => {
        const page = fetched;
        fetched += 1;
        if (page < 2) {
          return ok({ items: [{ id: page }], next_cursor: `cur_${page + 1}`, has_more: true });
        }
        return failure({
          cmd: "elv call list_things",
          error: { type: "provider_error", code: "failed", message: "Page unavailable" },
        });
      },
    });

    expect(fetched).toBe(3);
    expect(env.ok).toBe(false);
    // A partially collected run must never leave something that reads as the whole set.
    expect(readdirSync(out)).toEqual([]);
  });

  it("publishes nothing when the very first page fails", async () => {
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      saveJson: join(out, "things.json"),
      command: { kind: "call" },
      fetchPage: async () =>
        failure({
          cmd: "elv call list_things",
          error: { type: "provider_error", code: "failed", message: "Page unavailable" },
        }),
    });

    expect(env.ok).toBe(false);
    expect(env.files).toBeUndefined();
    expect(readdirSync(out)).toEqual([]);
  });

  it("discards the partial file and leaves no temp when a page throws", async () => {
    let fetched = 0;
    await expect(
      collectAllPages({
        op: op(),
        input: {},
        out,
        saveJson: join(out, "things.json"),
        command: { kind: "call" },
        fetchPage: async () => {
          const page = fetched;
          fetched += 1;
          if (page === 0) return ok({ items: [{ id: 0 }], next_cursor: "cur_1", has_more: true });
          throw new Error("connection reset");
        },
      }),
    ).rejects.toThrow("connection reset");

    expect(readdirSync(out)).toEqual([]);
  });

  it("never overwrites an existing collection at the requested path", async () => {
    const target = join(out, "things.json");
    writeFileSync(target, '{"pre":"existing"}', "utf8");

    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      saveJson: target,
      command: { kind: "call" },
      fetchPage: async () => {
        const page = fetched;
        fetched += 1;
        return ok({
          items: [{ id: page }],
          next_cursor: page === 0 ? "cur_1" : null,
          has_more: page === 0,
        });
      },
    });

    const file = collectedFile(env);
    expect(file.path).not.toBe(target);
    expect(readFileSync(target, "utf8")).toBe('{"pre":"existing"}');
    expect(JSON.parse(file.text)).toEqual([{ id: 0 }, { id: 1 }]);
  });

  it("retains the private artifacts of every page, including the last one", async () => {
    const pages = 25;
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      command: { kind: "call" },
      fetchPage: async () => {
        const page = fetched;
        fetched += 1;
        return {
          ...(ok({
            items: [{ id: page, content_url: "[REDACTED]" }],
            next_cursor: page + 1 < pages ? `cur_${page + 1}` : null,
            has_more: page + 1 < pages,
          }) as Envelope & { files?: FileRecord[] }),
          files: [
            {
              path: join(out, `page-${page}-sensitive.json`),
              mime: "application/json",
              bytes: 10,
              sha256: null,
              sensitive: true,
            },
          ],
        };
      },
      maxPages: pages + 5,
    });

    if (!env.ok) throw new Error("expected success");
    const sensitive = env.files?.filter((file) => file.sensitive) ?? [];
    expect(sensitive).toHaveLength(pages);
    expect(sensitive[pages - 1]?.path).toContain(`page-${pages - 1}-sensitive.json`);
    // The combined collection still leads the list, as it did when it was buffered.
    expect(env.files?.[0]?.path).toBe(collectedFile(env).path);
  });

  it("uses --limit as the page size without capping the collected set", async () => {
    const requested: unknown[] = [];
    const pages = 4;
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      limit: 3,
      command: { kind: "call" },
      fetchPage: async (input) => {
        requested.push(input.query);
        const page = fetched;
        fetched += 1;
        return ok({
          items: [{ id: page * 2 }, { id: page * 2 + 1 }],
          next_cursor: page + 1 < pages ? `cur_${page + 1}` : null,
          has_more: page + 1 < pages,
        });
      },
    });

    expect(requested[0]).toEqual({ page_size: 3 });
    expect(requested[pages - 1]).toEqual({ page_size: 3, cursor: `cur_${pages - 1}` });
    if (!env.ok) throw new Error("expected success");
    expect(env.data_summary).toEqual({ type: "array", count: pages * 2 });
    expect(JSON.parse(collectedFile(env).text)).toHaveLength(pages * 2);
  });

  it("still publishes the collection when pagination stops on a repeated cursor", async () => {
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: { query: { cursor: "stuck" } },
      out,
      command: { kind: "call" },
      fetchPage: async () => {
        fetched += 1;
        return ok({ items: [{ id: fetched }], next_cursor: "stuck", has_more: true });
      },
    });

    expect(fetched).toBe(1);
    if (!env.ok) throw new Error("expected success");
    expect(env.warnings?.map((warning) => warning.code)).toContain("pagination_cursor_repeated");
    expect(JSON.parse(collectedFile(env).text)).toEqual([{ id: 1 }]);
  });

  it("still publishes the collection when the page cap is hit", async () => {
    let fetched = 0;
    const env = await collectAllPages({
      op: op(),
      input: {},
      out,
      command: { kind: "call" },
      fetchPage: async () => {
        fetched += 1;
        return ok({ items: [{ id: fetched }], next_cursor: `cur_${fetched}`, has_more: true });
      },
      maxPages: 4,
    });

    expect(fetched).toBe(4);
    if (!env.ok) throw new Error("expected success");
    expect(env.warnings?.map((warning) => warning.code)).toContain("pagination_page_cap_hit");
    expect(JSON.parse(collectedFile(env).text)).toHaveLength(4);
  });
});
