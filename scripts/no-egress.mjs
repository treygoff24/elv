// Node preload that refuses outbound network access, so an offline check stays
// offline even when something upstream supplies real credentials.
//
//   node --import ./scripts/no-egress.mjs dist/cli.js spec status
//   NODE_OPTIONS="--import /abs/path/scripts/no-egress.mjs" some-wrapper elv ...
//
// Why a preload instead of unsetting ELEVENLABS_API_KEY: the estate shim (and
// any other credential-injecting wrapper) re-adds the key after the caller
// unsets it, so an unset variable proves nothing about egress. NODE_OPTIONS is
// inherited by every descendant Node process, including the one a wrapper
// finally execs, so the block travels with the run.
//
// SCOPE — what this does and does not guarantee.
//
//   Blocked:  TCP connect (net), TLS connect (tls), DNS resolution (dns and
//             dns/promises, including Resolver instances), and global fetch,
//             for any destination that is not loopback. http/https/ws all ride
//             on net or tls, so they are covered transitively.
//   Allowed:  loopback IPv4/IPv6 literals, the name "localhost", Unix-domain
//             sockets, and any host named in ELV_NO_EGRESS_ALLOW (comma
//             separated). An allowlisted host is explicitly outside the
//             guarantee; it exists so a broker or launcher that needs a
//             non-loopback local address can still run.
//   NOT covered: raw dgram/UDP, ICMP, non-Node child processes, and anything
//             reaching the network through a native addon. This is a strong
//             check on the CLI's own network primitives, not a sandbox. Pair it
//             with a real no-egress environment when that stronger claim is
//             needed.
//
// A blocked attempt throws an Error whose message starts with the marker below,
// so callers can distinguish "we stopped it" from an ordinary network failure.

import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

export const MARKER = "ELV_NO_EGRESS_BLOCKED";

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost"]);

const extraAllowed = new Set(
  (process.env.ELV_NO_EGRESS_ALLOW ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0),
);

/** @param {string} host */
function isLoopback(host) {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare.length === 0) return true; // no host given: net defaults to localhost
  if (LOOPBACK_NAMES.has(bare)) return true;
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  if (bare.startsWith("::ffff:")) return isLoopback(bare.slice("::ffff:".length));
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** @param {string} host */
function isAllowed(host) {
  return isLoopback(host) || extraAllowed.has(host.replace(/^\[|\]$/g, "").toLowerCase());
}

/**
 * @param {string} what
 * @param {string} host
 */
function blocked(what, host) {
  return new Error(
    `${MARKER}: ${what} to ${host || "(unknown host)"} refused by scripts/no-egress.mjs. ` +
      `Only loopback and ELV_NO_EGRESS_ALLOW hosts are permitted.`,
  );
}

// net.connect accepts (options), (port, host), or (path) — normalise all three.
// net.connect(port, host) reaches Socket.prototype.connect as a single nested
// [options, callback] array, so unwrap that first. A Unix socket has a `path`
// and no host, and is always allowed.
/** @param {unknown[]} args @returns {{ unix: boolean; host: string }} */
function connectTarget(args) {
  const first = args[0];
  if (Array.isArray(first)) return connectTarget(first);
  if (typeof first === "object" && first !== null) {
    const options = /** @type {{ path?: unknown; host?: unknown }} */ (first);
    if (typeof options.path === "string") return { unix: true, host: "" };
    return { unix: false, host: typeof options.host === "string" ? options.host : "" };
  }
  if (typeof first === "string" && !/^\d+$/.test(first)) return { unix: true, host: "" };
  const second = args[1];
  return { unix: false, host: typeof second === "string" ? second : "" };
}

const realSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  const target = connectTarget(args);
  if (!target.unix && !isAllowed(target.host)) throw blocked("TCP connect", target.host);
  return realSocketConnect.apply(this, /** @type {never} */ (args));
};

const realTlsConnect = tls.connect;
// @ts-expect-error - replacing an overloaded builtin with a checked wrapper
tls.connect = function connect(...args) {
  const target = connectTarget(args);
  if (!target.unix && !isAllowed(target.host)) throw blocked("TLS connect", target.host);
  return realTlsConnect.apply(tls, /** @type {never} */ (args));
};

// DNS is where a provider hostname is first touched. Blocking it turns an
// accidental outbound call into a failure before any packet leaves.
const GUARDED = Symbol.for("elv.no-egress.guarded");
/** @param {Record<string, unknown>} target @param {string[]} names */
function guardResolvers(target, names) {
  // node:dns/promises and dns.promises are the same object; wrapping it twice
  // would work but double every check.
  if (target[GUARDED] === true) return;
  target[GUARDED] = true;
  for (const name of names) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function guarded(/** @type {unknown[]} */ ...args) {
      const host = typeof args[0] === "string" ? args[0] : "";
      if (!isAllowed(host)) {
        const error = blocked(`DNS ${name}`, host);
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          queueMicrotask(() => callback(error));
          return undefined;
        }
        throw error;
      }
      return original.apply(this, args);
    };
  }
}

const RESOLVER_METHODS = [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveAny",
  "resolveCname",
  "resolveMx",
  "resolveNs",
  "resolveSrv",
  "resolveTxt",
];

guardResolvers(/** @type {never} */ (dns), RESOLVER_METHODS);
guardResolvers(/** @type {never} */ (dns.promises), RESOLVER_METHODS);
guardResolvers(/** @type {never} */ (dnsPromises), RESOLVER_METHODS);
guardResolvers(/** @type {never} */ (dns.Resolver.prototype), RESOLVER_METHODS);
// The promise API has its own Resolver class, not a view of the callback one.
guardResolvers(/** @type {never} */ (dnsPromises.Resolver.prototype), RESOLVER_METHODS);

// fetch rides on net underneath, but undici buries the throw in an opaque
// TypeError. Checking the URL first keeps the marker visible to the caller.
const realFetch = globalThis.fetch;
if (typeof realFetch === "function") {
  globalThis.fetch = function fetch(input, init) {
    // A host we cannot read is a host we cannot vouch for: fail closed.
    let host = null;
    try {
      const raw =
        typeof input === "string" || input instanceof URL
          ? input
          : /** @type {Request} */ (input).url;
      host = new URL(String(raw)).hostname;
    } catch {
      host = null;
    }
    if (host === null || !isAllowed(host)) return Promise.reject(blocked("fetch", host ?? ""));
    return realFetch(input, init);
  };
}
