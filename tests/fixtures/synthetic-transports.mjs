// Test-only interception below no-egress.mjs. Never calls the real transports,
// even when the guard under test is absent or broken. Inherited by CLI children.
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import promises from "node:dns/promises";
import dgram from "node:dgram";

const fail = () => new Error("ELV_SYNTHETIC_TRANSPORT_REACHED");
net.Socket.prototype.connect = function () {
  throw fail();
};
tls.connect = function () {
  throw fail();
};
dgram.createSocket = function () {
  throw fail();
};
for (const target of [dns, promises, dns.Resolver.prototype, promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (!/^(lookup|resolve|reverse)/.test(name) || typeof target[name] !== "function") continue;
    target[name] = function (...args) {
      const callback = args.at(-1);
      if (typeof callback === "function") {
        queueMicrotask(() => callback(fail()));
        return;
      }
      throw fail();
    };
  }
}
globalThis.fetch = async function () {
  throw fail();
};
syncBuiltinESMExports();
