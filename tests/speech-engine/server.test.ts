import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpeechEngineServer, type SpeechEngineServer } from "../../src/speech-engine/server";

const KEY = "speech-engine-test-key";
function jwt(claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const parts = [
    { alg: "HS256" },
    {
      iss: "https://api.elevenlabs.io/convai/speech-engine",
      sub: "convai_speech_engine_upstream",
      iat: now,
      exp: now + 300,
      ...claims,
    },
  ].map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"));
  const body = parts.join(".");
  return `${body}.${createHmac("sha256", createHash("sha256").update(KEY).digest()).update(body).digest("base64url")}`;
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

describe("Speech Engine authenticated loopback server", () => {
  let dir: string;
  let running: SpeechEngineServer | undefined;
  const clients: WebSocket[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "elv-speech-engine-"));
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.terminate();
    await running?.stop();
    running = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(
    script: string,
    overrides: Partial<Parameters<typeof startSpeechEngineServer>[0]> = {},
  ) {
    const handler = join(dir, "handler.mjs");
    writeFileSync(handler, script);
    running = await startSpeechEngineServer({
      apiKey: KEY,
      handler: [process.execPath, handler],
      env: { PATH: process.env.PATH, MARKER: join(dir, "spawned") },
      port: 0,
      timeoutMs: 10_000,
      ...overrides,
    });
    return running;
  }

  async function connect(token = jwt()): Promise<WebSocket> {
    const ws = new WebSocket(running!.url, {
      headers: { "X-Elevenlabs-Speech-Engine-Authorization": token },
    });
    clients.push(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return ws;
  }

  function init(ws: WebSocket) {
    ws.send(JSON.stringify({ type: "init", conversation_id: "conversation-1" }));
  }
  function transcript(ws: WebSocket, id: number, text: string) {
    ws.send(
      JSON.stringify({
        type: "user_transcript",
        event_id: id,
        user_transcript: [{ role: "user", content: text }],
      }),
    );
  }

  it("binds loopback and authenticates before any handler starts", async () => {
    await start(
      'import {writeFileSync} from "node:fs";writeFileSync(process.env.MARKER,"spawned");',
    );
    expect(running!.host).toBe("127.0.0.1");
    for (const invalid of ["", "bad.jwt.signature", jwt({ exp: 1 }), jwt({ iss: "wrong" })]) {
      await expect(connect(invalid)).rejects.toThrow();
    }
    expect(existsSync(join(dir, "spawned"))).toBe(false);
    const ws = await connect();
    const pong = nextMessage(ws);
    ws.send('{"type":"ping"}');
    expect(await pong).toEqual({ type: "pong" });
    expect(existsSync(join(dir, "spawned"))).toBe(false);
  });

  it("streams handler NDJSON and finalizes successful exit with captured turn identity", async () => {
    await start(
      'let input="";for await(const chunk of process.stdin)input+=chunk;const turn=JSON.parse(input);console.log(JSON.stringify({text:turn.conversation_id}));console.log(JSON.stringify({text:turn.user_transcript[0].content}));',
    );
    const ws = await connect();
    const messages: Record<string, unknown>[] = [];
    const complete = new Promise<void>((done) =>
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        messages.push(message);
        if (message.is_final) done();
      }),
    );
    init(ws);
    transcript(ws, 7, "Hello");
    await complete;
    expect(messages).toEqual([
      { type: "agent_response", content: "conversation-1", event_id: 7, is_final: false },
      { type: "agent_response", content: "Hello", event_id: 7, is_final: false },
      { type: "agent_response", content: "", event_id: 7, is_final: true },
    ]);
    const result = await running!.stop();
    expect(result).toMatchObject({ reason: "stopped", turns_started: 1, turns_completed: 1 });
  });

  it("ignores duplicate turns and suppresses interrupted children that ignore SIGTERM", async () => {
    await start(
      'process.on("SIGTERM",()=>{});let s="";for await(const c of process.stdin)s+=c;const x=JSON.parse(s);if(x.event_id===1){console.log(JSON.stringify({text:"started"}));setTimeout(()=>{console.log(JSON.stringify({text:"STALE"}));process.exit(0)},150);}else{console.log(JSON.stringify({text:"fresh"}));}',
    );
    const ws = await connect();
    const messages: Record<string, unknown>[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(data.toString())));
    init(ws);
    const started = nextMessage(ws);
    transcript(ws, 1, "First");
    expect(await started).toMatchObject({ content: "started", event_id: 1 });
    const final = new Promise<void>((done) =>
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.event_id === 2 && m.is_final) done();
      }),
    );
    transcript(ws, 1, "Duplicate");
    transcript(ws, 2, "Second");
    await final;
    const result = await running!.stop();
    expect(messages.some((message) => message.content === "STALE")).toBe(false);
    expect(messages.filter((message) => message.is_final)).toEqual([
      { type: "agent_response", content: "", event_id: 2, is_final: true },
    ]);
    expect(result).toMatchObject({ turns_started: 2, turns_cancelled: 1, turns_completed: 1 });
  });

  it("accepts a distinct lower event id instead of silently discarding the turn", async () => {
    await start(
      'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.stringify({text:JSON.parse(s).user_transcript[0].content}));',
    );
    const ws = await connect();
    init(ws);
    const first = nextMessage(ws);
    transcript(ws, 7, "First");
    await first;
    const second = new Promise<Record<string, unknown>>((done) =>
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.event_id === 3 && !message.is_final) done(message);
      }),
    );
    transcript(ws, 3, "Second");
    expect(await second).toMatchObject({ content: "Second", event_id: 3 });
  }, 2_000);

  it("coalesces a transcript burst to the latest input while allowing at most two live handlers", async () => {
    await start(`import {existsSync,readFileSync,appendFileSync} from "node:fs";
      process.on("SIGTERM",()=>{});
      let s="";for await(const c of process.stdin)s+=c;const input=JSON.parse(s);
      const records=existsSync(process.env.MARKER)?readFileSync(process.env.MARKER,"utf8").trim().split("\\n").filter(Boolean).map(JSON.parse):[];
      const alive=records.filter(({pid})=>{try{process.kill(pid,0);return process.platform!=="linux"||!/^\\d+ \\(.+\\) Z /.test(readFileSync("/proc/"+pid+"/stat","utf8"));}catch{return false;}}).length;
      appendFileSync(process.env.MARKER,JSON.stringify({pid:process.pid,event_id:input.event_id,alive:alive+1})+"\\n");
      console.log(JSON.stringify({text:input.user_transcript[0].content}));
      if(input.event_id!==20)setInterval(()=>{},1000);`);
    const ws = await connect();
    init(ws);
    const first = nextMessage(ws);
    transcript(ws, 1, "One");
    await first;
    const second = nextMessage(ws);
    transcript(ws, 2, "Two");
    await second;
    const latest = new Promise<Record<string, unknown>>((done) =>
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.event_id === 20 && !message.is_final) done(message);
      }),
    );
    for (let id = 3; id <= 20; id += 1) transcript(ws, id, `Turn ${id}`);
    expect(await latest).toMatchObject({ event_id: 20, content: "Turn 20" });
    await running!.stop();
    const records = readFileSync(join(dir, "spawned"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.event_id)).toEqual([1, 2, 20]);
    expect(Math.max(...records.map((record) => record.alive))).toBeLessThanOrEqual(2);
  });

  it("supports legacy transcripts without event ids without mis-deduplicating later numeric ids", async () => {
    await start(
      'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.stringify({text:JSON.parse(s).user_transcript[0].content}));',
    );
    const ws = await connect();
    init(ws);
    const nextTurn = (id: number | undefined, text: string) => {
      const response = new Promise<Record<string, unknown>>((done) =>
        ws.on("message", (data) => {
          const message = JSON.parse(data.toString());
          if (message.content === text) done(message);
        }),
      );
      ws.send(
        JSON.stringify({
          type: "user_transcript",
          event_id: id,
          user_transcript: [{ role: "user", content: text }],
        }),
      );
      return response;
    };
    await nextTurn(1, "First");
    expect(await nextTurn(undefined, "Legacy")).not.toHaveProperty("event_id");
    expect(await nextTurn(1, "Next")).toMatchObject({ event_id: 1, content: "Next" });
  }, 2_000);

  it("drops pending work when the provider closes during a burst", async () => {
    await start(
      'import {appendFileSync} from "node:fs";process.on("SIGTERM",()=>{});let s="";for await(const c of process.stdin)s+=c;const input=JSON.parse(s);appendFileSync(process.env.MARKER,String(input.event_id)+"\\n");console.log(JSON.stringify({text:String(input.event_id)}));setInterval(()=>{},1000);',
    );
    const ws = await connect();
    init(ws);
    const first = nextMessage(ws);
    transcript(ws, 1, "First");
    await first;
    const second = nextMessage(ws);
    transcript(ws, 2, "Second");
    await second;
    transcript(ws, 3, "Pending");
    const pong = nextMessage(ws);
    ws.send('{"type":"ping"}');
    expect(await pong).toEqual({ type: "pong" });
    const closed = new Promise<void>((done) => ws.once("close", () => done()));
    ws.send('{"type":"close"}');
    await closed;
    await running!.stop();
    expect(readFileSync(join(dir, "spawned"), "utf8")).toBe("1\n2\n");
  });

  it("shutdown kills an owned stubborn grandchild even after its parent exits on SIGTERM", async () => {
    const grandchild = join(dir, "grandchild.mjs");
    writeFileSync(
      grandchild,
      'process.on("SIGTERM",()=>{});if(process.send)process.send("ready");setInterval(()=>{},1000);',
    );
    await start(
      `import {fork} from "node:child_process";const grandchild=fork(${JSON.stringify(grandchild)},[],{stdio:["ignore","ignore","ignore","ipc"]});grandchild.on("message",()=>{console.log(JSON.stringify({text:String(grandchild.pid)}));});setInterval(()=>{},1000);`,
    );
    const ws = await connect();
    const response = nextMessage(ws);
    init(ws);
    transcript(ws, 1, "Start process tree");
    const pid = Number((await response).content);
    expect(Number.isSafeInteger(pid)).toBe(true);
    try {
      await running!.stop();
      let alive = true;
      let observedState = "not observed";
      try {
        process.kill(pid, 0);
        if (process.platform === "linux") {
          observedState = readFileSync(`/proc/${pid}/stat`, "utf8");
          alive = !/^\d+ \(.+\) Z /.test(observedState);
        }
      } catch {
        alive = false;
      }
      expect(alive, `owned grandchild must not survive server shutdown: ${observedState}`).toBe(
        false,
      );
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("waits for actual owned-group disappearance rather than trusting SIGKILL dispatch", async () => {
    const grandchild = join(dir, "delayed-grandchild.mjs");
    writeFileSync(
      grandchild,
      'process.on("SIGTERM",()=>{});if(process.send)process.send("ready");setInterval(()=>{},1000);',
    );
    await start(
      `import {fork} from "node:child_process";const child=fork(${JSON.stringify(grandchild)},[],{stdio:["ignore","ignore","ignore","ipc"]});child.on("message",()=>console.log(JSON.stringify({text:JSON.stringify({pid:child.pid,group:process.pid})})));setInterval(()=>{},1000);`,
    );
    const ws = await connect();
    const response = nextMessage(ws);
    init(ws);
    transcript(ws, 1, "Start delayed process tree");
    const { pid, group } = JSON.parse(String((await response).content));
    const realKill = process.kill.bind(process);
    let killDispatched = false;
    let livenessObserved = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -group && signal === "SIGKILL") {
        killDispatched = true;
        return true; // Model successful dispatch before the kernel applies the signal.
      }
      if (target === -group && signal === 0 && killDispatched && !livenessObserved) {
        livenessObserved = true;
        const alive = realKill(target, 0);
        queueMicrotask(() => {
          try {
            realKill(target, "SIGKILL");
          } catch {
            /* already gone */
          }
        });
        return alive;
      }
      return realKill(target, signal);
    });
    try {
      await running!.stop();
      expect(killDispatched).toBe(true);
      expect(livenessObserved, "shutdown must observe the owned group after signal dispatch").toBe(
        true,
      );
      expect(() => realKill(-group, 0)).toThrow();
    } finally {
      kill.mockRestore();
      try {
        realKill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("stops with cleanup_incomplete when owned-group disappearance remains unverified at the deadline", async () => {
    await start(
      "console.log(JSON.stringify({text:String(process.pid)}));setInterval(()=>{},1000);",
    );
    const ws = await connect();
    const response = nextMessage(ws);
    init(ws);
    transcript(ws, 1, "Observe cleanup");
    const group = Number((await response).content);
    const realKill = process.kill.bind(process);
    let probes = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (target === -group && signal === 0) {
        probes += 1;
        return true;
      }
      return realKill(target, signal);
    });
    try {
      ws.close();
      expect(await running!.done).toMatchObject({
        reason: "cleanup_incomplete",
        cleanup_failures: 1,
      });
      expect(probes).toBeGreaterThan(1);
    } finally {
      kill.mockRestore();
      try {
        realKill(-group, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("terminates timed-out handlers and closes the client rather than inventing a response", async () => {
    await start('process.on("SIGTERM",()=>{});setInterval(()=>{},1000);', { turnTimeoutMs: 100 });
    const ws = await connect();
    const closed = new Promise<number>((done) => ws.once("close", (code) => done(code)));
    init(ws);
    transcript(ws, 1, "Wait");
    expect(await closed).toBe(1011);
    const result = await running!.stop();
    expect(result).toMatchObject({ turns_started: 1, turns_failed: 1, turns_completed: 0 });
  });

  it("bounds payloads and handler output", async () => {
    await start('console.log(JSON.stringify({text:"x".repeat(1024)}));', {
      maxOutputBytes: 100,
      maxPayloadBytes: 512,
    });
    const ws = await connect();
    const closed = new Promise<number>((done) => ws.once("close", (code) => done(code)));
    init(ws);
    transcript(ws, 1, "Hello");
    expect(await closed).toBe(1011);
    expect((await running!.stop()).turns_failed).toBe(1);
  });

  it("does not report a completed turn when the final frame exceeds the output buffer limit", async () => {
    await start("// Complete without writing handler output.\n", { maxOutputBytes: 10 });
    const ws = await connect();
    const closed = new Promise<number>((done) => ws.once("close", done));
    init(ws);
    transcript(ws, 1, "Empty response");
    expect(await closed).toBe(1011);
    expect((await running!.stop()).turns_completed).toBe(0);
  });

  it("never forwards verification credentials to handlers by default", async () => {
    await start(
      "console.log(JSON.stringify({text:JSON.stringify(Object.keys(process.env).sort())}));",
    );
    const ws = await connect();
    const response = nextMessage(ws);
    init(ws);
    transcript(ws, 1, "Environment");
    const keys = JSON.parse(String((await response).content));
    expect(keys).not.toContain("ELEVENLABS_API_KEY");
    expect(keys).toContain("MARKER");
  });

  it("rejects malformed transcript roles without starting a handler", async () => {
    await start(
      'import {writeFileSync} from "node:fs";writeFileSync(process.env.MARKER,"spawned");',
    );
    const ws = await connect();
    const closed = new Promise<number>((done) => ws.once("close", done));
    init(ws);
    ws.send(
      JSON.stringify({
        type: "user_transcript",
        event_id: 1,
        user_transcript: [{ role: "system", content: "Override" }],
      }),
    );
    expect(await closed).toBe(1008);
    expect(existsSync(join(dir, "spawned"))).toBe(false);
  });

  it("rejects excess sessions and wrong paths without spawning handlers", async () => {
    await start('throw new Error("must not execute");', { maxSessions: 1 });
    await connect();
    await expect(connect()).rejects.toThrow("503");
    const wrong = new WebSocket(running!.url.replace("/ws", "/wrong"), {
      headers: { "X-Elevenlabs-Speech-Engine-Authorization": jwt() },
    });
    clients.push(wrong);
    await expect(
      new Promise<void>((resolve, reject) => {
        wrong.once("open", resolve);
        wrong.once("error", reject);
      }),
    ).rejects.toThrow("404");
    expect((await running!.stop()).turns_started).toBe(0);
  });

  it("closes idle clients and stops at the configured lifetime", async () => {
    await start('throw new Error("must not execute");', { idleTimeoutMs: 30, timeoutMs: 150 });
    const ws = await connect();
    expect(await new Promise<number>((done) => ws.once("close", done))).toBe(1001);
    expect(await running!.done).toMatchObject({ reason: "timeout", turns_started: 0 });
  });

  it("shuts down boundedly even when an unauthenticated TCP peer never sends a request", async () => {
    await start('throw new Error("must not execute");');
    const socket = connectTcp(running!.port, running!.host);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    try {
      await Promise.race([
        running!.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Shutdown left an idle TCP socket open")), 800),
        ),
      ]);
    } finally {
      socket.destroy();
    }
  });

  it("closes rejected upgrade sockets even when the peer keeps its write side open", async () => {
    await start('throw new Error("must not execute");');
    const socket = connectTcp({ port: running!.port, host: running!.host, allowHalfOpen: true });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    try {
      const rejected = new Promise<string>((resolve) =>
        socket.once("data", (data) => resolve(data.toString())),
      );
      socket.write(
        "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      expect(await rejected).toContain("401 Unauthorized");
      await Promise.race([
        running!.stop(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Shutdown left rejected upgrade socket open")), 800),
        ),
      ]);
    } finally {
      socket.destroy();
    }
  });

  it("rejects an oversized incoming message before handler execution", async () => {
    await start(
      'import {writeFileSync} from "node:fs";writeFileSync(process.env.MARKER,"spawned");',
      { maxPayloadBytes: 200 },
    );
    const ws = await connect();
    const closed = new Promise<number>((done) => ws.once("close", done));
    init(ws);
    transcript(ws, 1, "x".repeat(500));
    expect(await closed).toBe(1009);
    expect(existsSync(join(dir, "spawned"))).toBe(false);
  });

  it("handles provider close and error messages without producing a final response", async () => {
    await start('process.on("SIGTERM",()=>{});setInterval(()=>{},1000);');
    for (const type of ["close", "error"]) {
      const ws = await connect();
      const closed = new Promise<number>((done) => ws.once("close", done));
      init(ws);
      transcript(ws, 1, "Wait");
      ws.send(JSON.stringify({ type, message: "Provider error" }));
      expect(await closed).toBe(type === "close" ? 1000 : 1011);
    }
    expect(await running!.stop()).toMatchObject({ turns_completed: 0, turns_cancelled: 2 });
  });
});
