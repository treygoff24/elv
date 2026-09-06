import { createServer } from "node:http";
import { isIP, type Socket } from "node:net";
import { WebSocketServer } from "ws";
import { verifySpeechEngineJwt } from "./auth";
import { SpeechEngineSession, type SessionOptions, type SessionStats } from "./session";

export interface SpeechEngineServerOptions extends Partial<SessionOptions> {
  apiKey: string;
  handler: string[];
  host?: string;
  port?: number;
  path?: string;
  maxSessions?: number;
  maxPayloadBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SpeechEngineResult extends SessionStats {
  reason: string;
  connections_accepted: number;
  connections_rejected: number;
}

export interface SpeechEngineServer {
  host: string;
  port: number;
  path: string;
  url: string;
  done: Promise<SpeechEngineResult>;
  stop(reason?: string): Promise<SpeechEngineResult>;
}

export function validateServerOptions(options: SpeechEngineServerOptions) {
  const host = options.host === "localhost" ? "127.0.0.1" : (options.host ?? "127.0.0.1");
  if (!isIP(host)) throw new Error("--host must be a literal IP address or localhost");
  const port = options.port ?? 3001;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("--port must be an integer from 0 to 65535");
  const path = options.path ?? "/ws";
  if (!path.startsWith("/") || /[?#\s\\]/.test(path))
    throw new Error("--path must be an absolute URL path without a query or fragment");
  if (
    !options.handler.length ||
    options.handler.some((value) => typeof value !== "string" || value.includes("\0")) ||
    !options.handler[0]
  )
    throw new Error("--handler-json must be a nonempty argv array of strings");
  const limits = {
    maxSessions: options.maxSessions ?? 4,
    maxPayloadBytes: options.maxPayloadBytes ?? 1024 * 1024,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
    turnTimeoutMs: options.turnTimeoutMs ?? 30_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    timeoutMs: options.timeoutMs ?? 600_000,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new Error(`${name} must be a positive integer no greater than 2147483647`);
  }
  return { ...options, ...limits, host, port, path, env: options.env ?? {} };
}

export async function startSpeechEngineServer(
  options: SpeechEngineServerOptions,
): Promise<SpeechEngineServer> {
  const config = validateServerOptions(options);
  if (!config.apiKey.trim())
    throw new Error("An API key is required to verify Speech Engine connections");
  const stats = {
    connections_accepted: 0,
    connections_rejected: 0,
    turns_started: 0,
    turns_completed: 0,
    turns_cancelled: 0,
    turns_failed: 0,
    cleanup_failures: 0,
  };
  const http = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
    response.writeHead(404, { "Content-Length": "0" });
    response.end();
  });
  http.headersTimeout = 10_000;
  http.requestTimeout = 10_000;
  http.maxConnections = Math.max(32, config.maxSessions * 2);
  const sockets = new Set<Socket>();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    perMessageDeflate: false,
  });
  const sessions = new Set<SpeechEngineSession>();
  let stopping = false;
  http.on("upgrade", (request, socket, head) => {
    const reject = (status: string) => {
      stats.connections_rejected += 1;
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () =>
        socket.destroy(),
      );
    };
    if (stopping) {
      reject("503 Service Unavailable");
      return;
    }
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      reject("400 Bad Request");
      return;
    }
    if (request.method !== "GET" || path !== config.path) {
      reject("404 Not Found");
      return;
    }
    const header = request.headers["x-elevenlabs-speech-engine-authorization"];
    const count = request.rawHeaders
      .filter((_, index) => index % 2 === 0)
      .filter((name) => name.toLowerCase() === "x-elevenlabs-speech-engine-authorization").length;
    if (
      typeof header !== "string" ||
      count !== 1 ||
      !verifySpeechEngineJwt(header, config.apiKey)
    ) {
      reject("401 Unauthorized");
      return;
    }
    if (sessions.size >= config.maxSessions) {
      reject("503 Service Unavailable");
      return;
    }
    request.socket.setTimeout(0);
    wss.handleUpgrade(request, socket, head, (ws) => {
      stats.connections_accepted += 1;
      const session = new SpeechEngineSession(ws, config, stats, () => {
        void stop("cleanup_incomplete");
      });
      sessions.add(session);
      ws.on("close", () => {
        void session.stop().finally(() => sessions.delete(session));
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Speech Engine listener has no address");
  let resolveDone!: (result: SpeechEngineResult) => void;
  const done = new Promise<SpeechEngineResult>((resolve) => {
    resolveDone = resolve;
  });
  const stop = (reason = "stopped") => {
    if (stopping) return done;
    stopping = true;
    clearTimeout(lifetime);
    config.signal?.removeEventListener("abort", aborted);
    const closing = [...sessions].map((session) => session.stop());
    const force = setTimeout(() => {
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
    }, 300);
    void Promise.all([
      ...closing,
      new Promise<void>((resolve) => wss.close(() => resolve())),
      new Promise<void>((resolve) => http.close(() => resolve())),
    ]).then(() => {
      clearTimeout(force);
      resolveDone({ reason: stats.cleanup_failures ? "cleanup_incomplete" : reason, ...stats });
    });
    return done;
  };
  const aborted = () => {
    void stop("signal");
  };
  const lifetime = setTimeout(() => {
    void stop("timeout");
  }, config.timeoutMs);
  http.on("error", () => {
    void stop("server_error");
  });
  config.signal?.addEventListener("abort", aborted, { once: true });
  if (config.signal?.aborted) void stop("signal");
  return {
    host: config.host,
    port: address.port,
    path: config.path,
    url: `ws://${isIP(config.host) === 6 ? `[${config.host}]` : config.host}:${address.port}${config.path}`,
    done,
    stop,
  };
}
