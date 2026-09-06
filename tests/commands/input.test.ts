import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { addFiles, addPairs } from "../../src/commands/input";
import type { AgentInput } from "../../src/core/types";
import { errorRecord, parseEnvelope, runCli } from "../helpers/cli-result";
import { rejectPortProbe } from "../helpers/http";

describe("command input helpers", () => {
  it("adds query/path pairs and accumulates array file fields", () => {
    const input: AgentInput = {};

    addPairs(input, "query", ["page=2"]);
    addPairs(input, "path", ["voice_id=v1"]);
    addFiles(input, ["files[]=a.wav", "files[]=b.wav"]);

    expect(input.query).toEqual({ page: "2" });
    expect(input.path).toEqual({ voice_id: "v1" });
    expect(input.files).toMatchObject({
      files: [expect.stringContaining("a.wav"), expect.stringContaining("b.wav")],
    });
  });

  it("rejects malformed key-value pairs", () => {
    expect(() => addPairs({}, "query", ["missing-equals"])).toThrow(/key=value/u);
  });

  it("accumulates explicitly marked query arrays without changing scalar last-wins semantics", () => {
    const input: AgentInput = {};
    addPairs(input, "query", ["source[]=qa", "source[]=manual", "page=1", "page=2"]);
    expect(input.query).toEqual({ source: ["qa", "manual"], page: "2" });
    addPairs(input, "query", ["source=agent"]);
    expect(input.query).toEqual({ source: "agent", page: "2" });
  });

  it("appends to bucketed JSON arrays and preserves equals signs and empty values", () => {
    const input: AgentInput = { query: { source: ["existing"], untouched: true } };
    addPairs(input, "query", ["source[]=a=b", "source[]="]);
    expect(input.query).toEqual({ source: ["existing", "a=b", ""], untouched: true });
  });

  it.each(["existing", 0, false, null, { nested: true }])(
    "rejects explicit array appends to an existing non-array value: %j",
    (existing) => {
      const input: AgentInput = { query: { source: existing } };
      expect(() => addPairs(input, "query", ["source[]=qa"])).toThrow(/source.*array/u);
      expect(input.query).toEqual({ source: existing });
    },
  );

  it("rejects an empty query array name without stripping brackets from path parameters", () => {
    expect(() => addPairs({}, "query", ["[]=qa"])).toThrow(/non-empty/u);
    const input: AgentInput = {};
    addPairs(input, "path", ["voice_id[]=first", "voice_id[]=second", "[]=literal"]);
    expect(input.path).toEqual({ "voice_id[]": "second", "[]": "literal" });
  });

  it("serializes explicit query arrays as repeated HTTP parameters and rejects empty names before network", async () => {
    const urls: string[] = [];
    const server = createServer((req, res) => {
      if (rejectPortProbe(req, res)) return;
      urls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing mock server address");
      const env = {
        ELEVENLABS_BASE_URL: `http://127.0.0.1:${address.port}`,
        ELEVENLABS_API_KEY: "test_key_CANARY",
      };
      const result = await runCli(
        [
          "call",
          "list_agent_conversation_tickets_route",
          "--json",
          '{"path":{"agent_id":"agent_1"},"query":{"sources":["agent"]}}',
          "--query",
          "sources[]=qa",
          "--query",
          "sources[]=manual",
          "--query",
          "page_size=1",
          "--query",
          "page_size=2",
        ],
        env,
      );
      expect(result.code, result.stdout).toBe(0);
      expect(parseEnvelope(result.stdout)).toMatchObject({ ok: true, data: { received: true } });
      expect(urls).toHaveLength(1);
      const query = new URL(urls[0]!, env.ELEVENLABS_BASE_URL).searchParams;
      expect([...query.entries()]).toEqual([
        ["sources", "agent"],
        ["sources", "qa"],
        ["sources", "manual"],
        ["page_size", "2"],
      ]);
      const invalid = await runCli(["http", "GET", "/query-array-test", "--query", "[]=qa"], env);
      expect(invalid.code, invalid.stdout).toBe(2);
      expect(errorRecord(parseEnvelope(invalid.stdout)).message).toContain("non-empty");
      expect(urls).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
