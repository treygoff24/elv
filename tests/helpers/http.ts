import type { IncomingMessage, ServerResponse } from "node:http";

// Observed host probes use this exact request, including on standalone listeners
// with no CLI client. Do not count that external traffic as ELV I/O.
// All authenticated, non-root, non-GET, upgrade, and non-Go requests still count.
export function rejectPortProbe(req: IncomingMessage, res: ServerResponse): boolean {
  if (
    req.method !== "GET" ||
    req.url !== "/" ||
    req.headers["user-agent"] !== "Go-http-client/1.1" ||
    req.headers["xi-api-key"] !== undefined ||
    req.headers.authorization !== undefined ||
    req.headers.cookie !== undefined ||
    req.headers.upgrade !== undefined
  )
    return false;
  res.writeHead(404);
  res.end();
  return true;
}
