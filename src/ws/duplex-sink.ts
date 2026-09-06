import { writeSync } from "node:fs";

const STDERR_FD = 2;
const EAGAIN_SLEEP_MS = 1;
const sleepSlot = new Int32Array(new SharedArrayBuffer(4));

/**
 * Writes one duplex event line straight to file descriptor 2.
 *
 * `process.stderr` is an asynchronous writer when stderr is a pipe: a consumer that
 * reads more slowly than the provider streams leaves bytes queued in the stream, and
 * `emitAndExit`'s `process.exit()` discards that queue. The envelope would then claim
 * events the agent never received. Writing synchronously turns consumer backpressure
 * into a blocking write, so nothing can be queued when the process exits.
 */
export function writeDuplexEventLine(line: string): void {
  const buffer = Buffer.from(`${line}\n`, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(STDERR_FD, buffer, offset, buffer.length - offset);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // libuv puts stdio pipes in non-blocking mode, so a full pipe reports EAGAIN
      // instead of blocking. Sleep and retry rather than dropping the event.
      if (code === "EAGAIN") {
        blockFor(EAGAIN_SLEEP_MS);
        continue;
      }
      // The consumer closed stderr; the final envelope on stdout still reports the session.
      if (code === "EPIPE") return;
      throw error;
    }
  }
}

function blockFor(ms: number): void {
  Atomics.wait(sleepSlot, 0, 0, ms);
}
