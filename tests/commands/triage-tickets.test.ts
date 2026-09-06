import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorRecord, parseEnvelope, recordValue, runCli } from "../helpers/cli-result";
import { rejectPortProbe } from "../helpers/http";

const agentPath = "/v1/convai/agents/agent_1/triage-tickets";
const workspacePath = "/v1/convai/triage-tickets";
const ticketPath = `${workspacePath}/ticket_1`;
const agent = ["--agent-id", "agent_1"];
const ticket = ["--ticket-id", "ticket_1"];
const conversationBody = {
  conversation_id: "conversation_1",
  qa_comment: "Incorrect refund policy",
  turn_comments: [{ turn_index: 0, comment: "No policy lookup" }],
};
const routes = [
  {
    args: ["list", ...agent],
    id: "list_agent_conversation_tickets_route",
    method: "GET",
    path: agentPath,
  },
  {
    args: ["list-workspace"],
    id: "list_workspace_conversation_tickets_route",
    method: "GET",
    path: workspacePath,
  },
  {
    args: ["create", "--json", JSON.stringify(conversationBody)],
    id: "create_agent_conversation_ticket_route",
    method: "POST",
    path: workspacePath,
    body: conversationBody,
  },
  {
    args: ["create-manual", ...agent, "--json", '{"qa_comment":"Follow up"}'],
    id: "create_manual_agent_ticket_route",
    method: "POST",
    path: agentPath,
    body: { qa_comment: "Follow up" },
  },
  {
    args: ["assignable-users", ...agent],
    id: "get_assignable_users_route",
    method: "GET",
    path: `${agentPath}/assignable-users`,
  },
  {
    args: ["get", ...ticket],
    id: "get_agent_conversation_ticket_route",
    method: "GET",
    path: ticketPath,
  },
  {
    args: ["update", ...ticket, "--json", '{"status":"in_progress","assignee_user_id":null}'],
    id: "update_agent_conversation_ticket_route",
    method: "PATCH",
    path: ticketPath,
    body: { status: "in_progress", assignee_user_id: null },
  },
  {
    args: ["delete", ...ticket],
    id: "delete_agent_conversation_ticket_route",
    method: "DELETE",
    path: ticketPath,
  },
  {
    args: ["comment", ...ticket, "--json", '{"comment":"Policy updated"}'],
    id: "add_ticket_comment_route",
    method: "POST",
    path: `${ticketPath}/comments`,
    body: { comment: "Policy updated" },
  },
  {
    args: ["turn-comment", ...ticket, "--json", '{"turn_index":0,"comment":"Expected lookup"}'],
    id: "add_turn_comment_route",
    method: "POST",
    path: `${ticketPath}/turn-comments`,
    body: { turn_index: 0, comment: "Expected lookup" },
  },
];

describe("agent triage tickets and conversation summaries", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  const requests: { method: string; path: string; query: URLSearchParams; body: string }[] = [];

  function run(args: string[]) {
    return runCli(args, {
      ELEVENLABS_BASE_URL: baseUrl,
      ELEVENLABS_API_KEY: "test_key_CANARY",
      ELV_CACHE_DIR: directory,
    });
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "elv-triage-"));
    server = createServer(async (req, res) => {
      if (rejectPortProbe(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (url.pathname === agentPath || url.pathname === workspacePath) {
        const secondPage = url.searchParams.get("cursor") === "page_2";
        res.end(
          JSON.stringify({
            agent_conversation_tickets: [
              { agentqa_ticket_id: secondPage ? "ticket_2" : "ticket_1", status: "open" },
            ],
            has_more: !secondPage,
            next_cursor: secondPage ? null : "page_2",
          }),
        );
      } else if (url.pathname.endsWith("/summary")) {
        res.end(
          JSON.stringify({
            conversation_id: "conversation_1",
            transcript_summary: "Refund resolved",
            messages_omitted: true,
          }),
        );
      } else {
        res.end(JSON.stringify({ agentqa_ticket_id: "ticket_1" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing mock server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(routes)(
    "dry-runs $id with the published method, path, and body",
    async ({ args, id, method, path, body }) => {
      const before = requests.length;
      const result = await run(["agents", "tickets", ...args, "--dry-run"]);
      expect(result.code, result.stdout).toBe(0);
      const envelope = parseEnvelope(result.stdout);
      expect(envelope).toMatchObject({ v: 1, ok: true, operation_id: id });
      const data = recordValue(envelope.data);
      const request = recordValue(data.request);
      expect(request.method).toBe(method);
      expect(request.path).toBe(
        path.replace("agent_1", "{agent_id}").replace("ticket_1", "{agentqa_ticket_id}"),
      );
      if (args.includes("--agent-id"))
        expect(recordValue(request.input).path).toEqual({ agent_id: "agent_1" });
      if (args.includes("--ticket-id"))
        expect(recordValue(request.input).path).toEqual({ agentqa_ticket_id: "ticket_1" });
      expect(recordValue(request.input).body).toEqual(body);
      if (method === "DELETE") expect(data.would_require_yes).toBe(true);
      expect(requests).toHaveLength(before);
    },
  );

  it.each(routes)(
    "sends $id through the HTTP transport",
    async ({ args, id, method, path, body }) => {
      const before = requests.length;
      const result = await run(["agents", "tickets", ...args, "--yes"]);
      expect(result.code, result.stdout).toBe(0);
      expect(requests).toHaveLength(before + 1);
      const request = requests.at(-1)!;
      expect(request.method).toBe(method);
      expect(request.path).toBe(path);
      expect(request.body ? JSON.parse(request.body) : undefined).toEqual(body);
      expect(parseEnvelope(result.stdout)).toMatchObject({ v: 1, ok: true, operation_id: id });
    },
  );

  it("sends every agent filter, repeated sources, and the cursor to the HTTP transport", async () => {
    const before = requests.length;
    const result = await run([
      "agents",
      "tickets",
      "list",
      ...agent,
      "--status",
      "open",
      "--conversation-id",
      "conversation_1",
      "--source",
      "qa",
      "--source",
      "manual",
      "--owner-user-id",
      "agent",
      "--assignee-user-id",
      "unassigned",
      "--issue-type",
      "knowledge_gap",
      "--label",
      "refund policy",
      "--cursor",
      "page_2",
      "--limit",
      "7",
      "--fields",
      "agentqa_ticket_id",
    ]);
    expect(result.code, result.stdout).toBe(0);
    expect(requests).toHaveLength(before + 1);
    const request = requests.at(-1)!;
    expect(request.method).toBe("GET");
    expect(request.path).toBe(agentPath);
    expect([...request.query.entries()].sort()).toEqual(
      [
        ["status", "open"],
        ["conversation_id", "conversation_1"],
        ["sources", "qa"],
        ["sources", "manual"],
        ["owner_user_id", "agent"],
        ["assignee_user_id", "unassigned"],
        ["issue_type", "knowledge_gap"],
        ["label", "refund policy"],
        ["cursor", "page_2"],
        ["page_size", "7"],
      ].sort(),
    );
    expect(recordValue(parseEnvelope(result.stdout).data).agent_conversation_tickets).toEqual([
      { agentqa_ticket_id: "ticket_2" },
    ]);
  });

  it("collects workspace pages and retains filters across pagination", async () => {
    const output = join(directory, "tickets.json");
    const before = requests.length;
    const result = await run([
      "agents",
      "tickets",
      "list-workspace",
      "--status",
      "open",
      "--assignee-user-id",
      "unassigned",
      "--all",
      "--save-json",
      output,
    ]);
    expect(result.code, result.stdout).toBe(0);
    expect(requests).toHaveLength(before + 2);
    const pages = requests.slice(before);
    expect(pages.map((page) => page.path)).toEqual([workspacePath, workspacePath]);
    expect(pages.map((page) => page.query.get("cursor"))).toEqual([null, "page_2"]);
    for (const page of pages) {
      expect(page.query.get("status")).toBe("open");
      expect(page.query.get("assignee_user_id")).toBe("unassigned");
    }
    const saved: unknown = JSON.parse(readFileSync(output, "utf8"));
    expect(saved).toEqual([
      { agentqa_ticket_id: "ticket_1", status: "open" },
      { agentqa_ticket_id: "ticket_2", status: "open" },
    ]);
  });

  it("preserves JSON-file payloads and explicit null assignments over HTTP", async () => {
    const body = { status: "resolved", assignee_user_id: null };
    const file = join(directory, "update.json");
    writeFileSync(file, JSON.stringify(body));
    const result = await run(["agents", "tickets", "update", ...ticket, "--json-file", file]);
    expect(result.code, result.stdout).toBe(0);
    const request = requests.at(-1)!;
    expect(request.method).toBe("PATCH");
    expect(request.path).toBe(ticketPath);
    expect(JSON.parse(request.body)).toEqual(body);
    expect(parseEnvelope(result.stdout).operation_id).toBe(
      "update_agent_conversation_ticket_route",
    );
  });

  it("gets a compact conversation summary with a bounded message count", async () => {
    const result = await run([
      "agents",
      "conversations",
      "summary",
      "--conversation-id",
      "conversation_1",
      "--max-messages",
      "12",
    ]);
    expect(result.code, result.stdout).toBe(0);
    const request = requests.at(-1)!;
    expect(request.method).toBe("GET");
    expect(request.path).toBe("/v1/convai/conversations/conversation_1/summary");
    expect([...request.query.entries()]).toEqual([["max_messages", "12"]]);
    expect(parseEnvelope(result.stdout)).toMatchObject({
      operation_id: "get_conversation_summary_route",
      data: { transcript_summary: "Refund resolved", messages_omitted: true },
    });
  });

  it.each([
    ["tickets", "list"],
    ["tickets", "get"],
    ["tickets", "delete"],
    ["tickets", "create-manual", "--json", '{"qa_comment":"Issue"}'],
    ["tickets", "assignable-users"],
    ["conversations", "summary"],
    ["tickets", "create", "--json", "{}"],
    ["tickets", "comment", ...ticket, "--json", '{"comment":""}'],
    ["tickets", "turn-comment", ...ticket, "--json", '{"turn_index":-1,"comment":"Issue"}'],
    ["tickets", "update", ...ticket, "--json", '{"status":"invalid"}'],
    ["tickets", "list", ...agent, "--status", "invalid"],
    ["conversations", "summary", "--conversation-id", "conversation_1", "--max-messages", "201"],
    ["conversations", "summary", "--conversation-id", "conversation_1", "--max-messages", "1.5"],
    [
      "conversations",
      "summary",
      "--conversation-id",
      "conversation_1",
      "--max-messages",
      "invalid",
    ],
  ])("rejects invalid input without network: %j", async (...args) => {
    const before = requests.length;
    const result = await run(["agents", ...args, "--dry-run"]);
    expect(result.code, result.stdout).toBe(2);
    expect(parseEnvelope(result.stdout).ok).toBe(false);
    expect(requests).toHaveLength(before);
  });

  it("gates ticket deletion before any network request", async () => {
    const before = requests.length;
    const result = await run(["agents", "tickets", "delete", ...ticket]);
    expect(result.code, result.stdout).toBe(4);
    expect(errorRecord(parseEnvelope(result.stdout)).code).toBe("confirmation");
    expect(requests).toHaveLength(before);
  });
});
