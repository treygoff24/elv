import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";
import { isRecord } from "../util/json";

export interface SessionOptions {
  handler: string[];
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
  turnTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface SessionStats {
  turns_started: number;
  turns_completed: number;
  turns_cancelled: number;
  turns_failed: number;
  cleanup_failures: number;
}

interface Turn {
  child: ChildProcess;
  eventId?: number;
  cancelled: boolean;
  finished: boolean;
  timeout: NodeJS.Timeout;
  killDone?: Promise<void>;
  done: Promise<void>;
}

export class SpeechEngineSession {
  private conversationId?: string;
  private lastEventId?: number;
  private current?: Turn;
  private pending?: { input: unknown; eventId?: number };
  private turns = new Set<Turn>();
  private idleTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private ws: WebSocket,
    private options: SessionOptions,
    private stats: SessionStats,
    private cleanupFailed: () => void,
  ) {
    this.idleTimer = setTimeout(() => this.close(1001, "Idle timeout"), options.idleTimeoutMs);
    ws.on("message", (data, binary) => {
      if (this.closed) return;
      if (binary) {
        this.close(1008, "JSON messages required");
        return;
      }
      try {
        this.receive(JSON.parse(data.toString()));
        this.idleTimer.refresh();
      } catch {
        this.close(1008, "Invalid protocol message");
      }
    });
    ws.on("error", () => this.close(1008, "WebSocket error"));
    ws.on("close", () => this.close());
  }

  async stop(): Promise<void> {
    this.close(1001, "Server stopping");
    await Promise.all(
      [...this.turns].map((turn) => {
        this.kill(turn);
        return turn.killDone;
      }),
    );
  }

  private close(code = 1000, reason = "Session closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.pending = undefined;
    clearTimeout(this.idleTimer);
    this.cancelCurrent();
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(code, reason);
  }

  private receive(message: unknown): void {
    if (!isRecord(message) || typeof message.type !== "string") throw new Error("Invalid message");
    switch (message.type) {
      case "ping":
        this.send({ type: "pong" });
        return;
      case "init":
        if (typeof message.conversation_id !== "string" || !message.conversation_id)
          throw new Error("Invalid conversation id");
        if (this.conversationId !== undefined && this.conversationId !== message.conversation_id)
          throw new Error("Conversation id changed");
        this.conversationId = message.conversation_id;
        return;
      case "user_transcript": {
        if (!this.conversationId || !Array.isArray(message.user_transcript))
          throw new Error("Missing initialization or transcript");
        if (
          !message.user_transcript.every(
            (item) =>
              isRecord(item) &&
              (item.role === "user" || item.role === "agent") &&
              typeof item.content === "string",
          )
        )
          throw new Error("Invalid transcript");
        const id = message.event_id;
        if (id !== undefined && (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0))
          throw new Error("Invalid event id");
        if (typeof id === "number" && id === this.lastEventId) return;
        this.lastEventId = id;
        this.cancelCurrent();
        const input = {
          conversation_id: this.conversationId,
          event_id: id,
          user_transcript: message.user_transcript,
        };
        // Retiring processes still consume resources during their kill grace.
        // Full-history transcripts supersede pending older turns.
        this.pending = { input, eventId: id };
        this.startPending();
        return;
      }
      case "close":
      case "error":
        this.close(message.type === "error" ? 1011 : 1000, "Provider ended session");
        return;
      default:
        // Unknown provider events cannot invoke handlers; tolerate protocol additions.
        return;
    }
  }

  private startTurn(input: unknown, eventId: number | undefined): void {
    const child = spawn(this.options.handler[0]!, this.options.handler.slice(1), {
      shell: false,
      detached: process.platform !== "win32",
      env: this.options.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let resolveDone!: () => void;
    const turn: Turn = {
      child,
      eventId,
      cancelled: false,
      finished: false,
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      timeout: setTimeout(() => this.failTurn(turn), this.options.turnTimeoutMs),
    };
    this.current = turn;
    this.turns.add(turn);
    this.stats.turns_started += 1;
    let pending = "";
    let bytes = 0;
    const decoder = new StringDecoder("utf8");
    const consume = (line: string) => {
      if (!line.trim()) return;
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || typeof record.text !== "string" || Object.keys(record).length !== 1)
        throw new Error("Expected handler text record");
      if (this.isCurrent(turn)) this.response(turn, record.text, false);
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      if (!this.isCurrent(turn)) return;
      bytes += chunk.length;
      if (bytes > this.options.maxOutputBytes) {
        this.failTurn(turn);
        return;
      }
      pending += decoder.write(chunk);
      try {
        let index: number;
        while ((index = pending.indexOf("\n")) >= 0) {
          consume(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
      } catch {
        this.failTurn(turn);
      }
    });
    child.on("error", () => this.failTurn(turn));
    child.stdin!.on("error", () => this.failTurn(turn));
    child.on("close", (code) => {
      clearTimeout(turn.timeout);
      if (this.isCurrent(turn)) {
        try {
          if (code !== 0) throw new Error("Handler failed");
          consume(pending + decoder.end());
          if (this.isCurrent(turn)) {
            this.response(turn, "", true);
            if (this.isCurrent(turn)) {
              turn.finished = true;
              this.stats.turns_completed += 1;
              this.current = undefined;
            }
          }
        } catch {
          this.failTurn(turn);
        }
      }
      // A parent can exit while descendants in its owned group remain alive.
      // Do not resolve cleanup (and let the CLI exit) before escalation finishes.
      this.kill(turn);
      void turn.killDone!.then(() => {
        this.turns.delete(turn);
        resolveDone();
        this.startPending();
      });
    });
    child.stdin!.end(`${JSON.stringify(input)}\n`);
  }

  private startPending(): void {
    if (this.closed || this.current || !this.pending || this.turns.size >= 2) return;
    const { input, eventId } = this.pending;
    this.pending = undefined;
    this.startTurn(input, eventId);
  }

  private isCurrent(turn: Turn): boolean {
    return !this.closed && !turn.cancelled && !turn.finished && this.current === turn;
  }

  private failTurn(turn: Turn): void {
    if (!this.isCurrent(turn)) return;
    this.stats.turns_failed += 1;
    turn.finished = true;
    this.kill(turn);
    this.current = undefined;
    this.close(1011, "Handler failed or exceeded limits");
  }

  private cancelCurrent(): void {
    if (!this.current) return;
    const turn = this.current;
    this.current = undefined;
    if (turn.finished || turn.cancelled) return;
    turn.cancelled = true;
    this.stats.turns_cancelled += 1;
    this.kill(turn);
  }

  private kill(turn: Turn): void {
    if (turn.killDone) return;
    clearTimeout(turn.timeout);
    const pid = turn.child.pid;
    if (!pid) {
      turn.killDone = Promise.resolve();
      return;
    }
    const target = process.platform === "win32" ? pid : -pid;
    const signal = (name: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") return turn.child.kill(name);
        else process.kill(target, name);
        return true;
      } catch {
        return false; /* The owned process group already exited. */
      }
    };
    const grace = signal("SIGTERM")
      ? new Promise<void>((resolve) => setTimeout(resolve, 250))
      : Promise.resolve();
    turn.killDone = grace.then(async () => {
      signal("SIGKILL");
      if (!(await waitForExit(target))) {
        this.stats.cleanup_failures += 1;
        this.close(1011, "Handler cleanup could not be verified");
        this.cleanupFailed();
      }
    });
  }

  private response(turn: Turn, content: string, final: boolean): void {
    if (this.isCurrent(turn))
      this.send({ type: "agent_response", content, event_id: turn.eventId, is_final: final });
  }

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    const data = JSON.stringify(message);
    if (this.ws.bufferedAmount + Buffer.byteLength(data) > this.options.maxOutputBytes) {
      this.close(1011, "Response buffer limit");
      return;
    }
    this.ws.send(data, (error) => {
      if (error) this.close(1011, "Response transport failed");
    });
  }
}

// Signal delivery is asynchronous. Observe only the owned process/group and
// fail conservatively if disappearance cannot be established before the deadline.
// A group containing unreaped zombies may remain observable; that is unverified
// cleanup, not evidence that those zombies are still executing code.
async function waitForExit(target: number): Promise<boolean> {
  const deadline = performance.now() + 1000;
  for (;;) {
    try {
      process.kill(target, 0);
    } catch (error) {
      return isRecord(error) && error.code === "ESRCH";
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
  }
}
