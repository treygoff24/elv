import { open } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type * as LiveKit from "@livekit/rtc-node";
import { decodeBase64 } from "../core/encoding";
import { fileRecord, tempFileWriter, writeManifest, type TempFileWriter } from "../core/files";
import { duplexEventLine } from "../ws/events";
import { isRecord, type JsonObject, type JsonValue } from "../util/json";
import { errorMessage } from "../util/error";
import { validateRtcAction, validateRtcFiles, type RtcAction } from "./actions";
import { redactRtcText, redactRtcValue } from "./logs";
import {
  emptyRtcInfo,
  type OpenArtifact,
  type ParentMessage,
  type RtcAudioOutput,
  type WorkerMessage,
  type WorkerOptions,
} from "./types";
import type { FileRecord } from "../core/types";

function post(message: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("RTC supervisor disconnected"));
      return;
    }
    process.send(message, (error: Error | null) => (error ? reject(error) : resolve()));
  });
}

class ActionQueue {
  private actions: { id: number; action: RtcAction }[] = [];
  private waiter?: (value: { id: number; action: RtcAction } | undefined) => void;
  private ended = false;
  push(id: number, action: RtcAction): void {
    if (this.ended) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ id, action });
    } else {
      if (this.actions.length >= 2) throw new Error("RTC action queue exceeded its bound");
      this.actions.push({ id, action });
    }
  }
  end(): void {
    this.ended = true;
    if (!this.actions.length) {
      this.waiter?.(undefined);
      this.waiter = undefined;
    }
  }
  next(): Promise<{ id: number; action: RtcAction } | undefined> {
    const action = this.actions.shift();
    if (action) return Promise.resolve(action);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("RTC cleanup deadline exceeded")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleCleanup(promises: Promise<unknown>[]): Promise<void> {
  const results = await bounded(Promise.allSettled(promises), 750);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function run(options: WorkerOptions): Promise<void> {
  const rtc = emptyRtcInfo();
  const files: FileRecord[] = [];
  const controller = new AbortController();
  const queue = new ActionQueue();
  let error: { code: string; message: string } | undefined;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const stop = (reason: string, problem?: { code: string; message: string }) => {
    if (controller.signal.aborted) return;
    rtc.reason = reason;
    rtc.timed_out = reason === "timeout";
    error = problem;
    controller.abort();
    queue.end();
    resolveStop();
  };
  const failed = (problem: unknown, code = "rtc_session_failed") =>
    stop("error", { code, message: redactRtcText(errorMessage(problem), options.token) });
  const onMessage = (raw: unknown) => {
    if (!isRecord(raw)) return;
    const message = raw as unknown as ParentMessage;
    try {
      if (message.type === "stop") stop(message.reason);
      else if (message.type === "input_end") queue.end();
      else if (message.type === "action") queue.push(message.id, validateRtcAction(message.action));
    } catch (problem) {
      failed(problem, "rtc_input_error");
    }
  };
  process.on("message", onMessage);
  process.once("disconnect", () => stop("supervisor_disconnected"));
  process.once("SIGTERM", () => stop("terminated"));
  const timer = setTimeout(
    () => stop("timeout", { code: "rtc_timeout", message: "RTC session reached its deadline" }),
    options.timeoutMs ?? 20_000,
  );
  let sdk: typeof LiveKit | undefined;
  let room: LiveKit.Room | undefined;
  let source: LiveKit.AudioSource | undefined;
  let localTrack: LiveKit.LocalAudioTrack | undefined;
  let localPublication: LiveKit.LocalTrackPublication | undefined;
  let events: TempFileWriter | undefined;
  let eventBytes = 0;
  let reservedEventBytes = 0;
  let reservedAudioBytes = 0;
  let eventChain = Promise.resolve();
  const captures = new Map<
    string,
    { reader: ReadableStreamDefaultReader<LiveKit.AudioFrame>; done: Promise<void> }
  >();
  const captureTasks: Promise<void>[] = [];
  let progressPending = false;
  const progress = () => {
    if (progressPending) return;
    progressPending = true;
    void post({ type: "progress", rtc })
      .catch(() => undefined)
      .finally(() => {
        progressPending = false;
      });
  };
  const openWriter = async (path: string, mime: string, audio?: OpenArtifact["audio"]) => {
    const writer = tempFileWriter(path);
    writer.stream.on("error", () => {});
    await post({
      type: "open_artifact",
      artifact: { path, temporary_path: String(writer.stream.path), mime, audio },
    });
    return writer;
  };
  const record = async (value: JsonValue) => {
    const line = duplexEventLine(redactRtcValue(value, options.token));
    eventBytes += Buffer.byteLength(line) + 1;
    if (eventBytes > options.maxEventBytes)
      throw new Error("RTC event output exceeded its byte limit");
    await events!.write(`${line}\n`);
    await post({ type: "event", line });
  };
  const publish = async (data: JsonObject) => {
    if (controller.signal.aborted) return;
    await room!.localParticipant!.publishData(new TextEncoder().encode(JSON.stringify(data)), {
      reliable: true,
    });
    rtc.events_sent += 1;
    progress();
  };
  const captureAudio = async (
    track: LiveKit.RemoteTrack,
    participant: LiveKit.RemoteParticipant,
  ) => {
    const id = track.sid ?? `track-${captureTasks.length}`;
    if (captures.has(id)) return;
    if (captureTasks.length >= options.maxTracks)
      throw new Error("RTC remote track limit exceeded");
    const index = captureTasks.length + 1;
    const path = join(options.outDir, `audio-${index}.pcm`);
    const metadata: Omit<RtcAudioOutput, "path" | "bytes"> = {
      track_id: redactRtcText(id, options.token),
      participant: redactRtcText(participant.identity, options.token),
      sample_rate: 48000,
      channels: 1,
      format: "pcm_s16le",
    };
    const reader = new sdk!.AudioStream(track, {
      sampleRate: 48000,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    const done = (async () => {
      let writer: TempFileWriter | undefined;
      let bytes = 0;
      try {
        writer = await openWriter(path, "audio/pcm", metadata);
        while (!controller.signal.aborted) {
          const frame = await reader.read();
          if (frame.done) break;
          const data = frame.value;
          if (
            data.sampleRate !== 48000 ||
            data.channels !== 1 ||
            data.data.byteLength !== data.samplesPerChannel * 2
          )
            throw new Error("RTC SDK returned an inconsistent PCM frame");
          const pcm = Buffer.from(
            new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength),
          );
          if (reservedAudioBytes + pcm.length > options.maxAudioBytes)
            throw new Error("RTC received audio exceeded its byte limit");
          reservedAudioBytes += pcm.length;
          await writer.write(pcm);
          bytes += pcm.length;
          rtc.audio_output_bytes += pcm.length;
          progress();
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        captures.delete(id);
        if (writer) {
          if (bytes) {
            const actualPath = await writer.close();
            const file = { ...(await fileRecord(actualPath, { hash: true })), mime: "audio/pcm" };
            const audio = { ...metadata, path: actualPath, bytes };
            files.push(file);
            rtc.audio_tracks.push(audio);
            await post({ type: "artifact", file, audio });
          } else await writer.abort();
        }
      }
    })();
    captures.set(id, { reader, done });
    captureTasks.push(done);
    void done.catch((problem) => {
      if (!controller.signal.aborted) failed(problem, "rtc_media_error");
    });
  };
  const capturePcm = async (bytes: Buffer) => {
    if (rtc.audio_input_bytes + bytes.length > options.maxAudioBytes)
      throw new Error("RTC sent audio exceeded its byte limit");
    for (let offset = 0; offset < bytes.length && !controller.signal.aborted; offset += 1920) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 1920));
      // rtc-node 0.13.34 passes the whole backing buffer to FFI, ignoring byteOffset.
      // A fresh array is required here; a subarray view would resend the wrong samples.
      const samples = new Int16Array(chunk.length / 2);
      for (let index = 0; index < samples.length; index += 1)
        samples[index] = chunk.readInt16LE(index * 2);
      await source!.captureFrame(new sdk!.AudioFrame(samples, 48000, 1, samples.length));
      rtc.audio_input_bytes += chunk.length;
      progress();
    }
  };
  const action = async (item: RtcAction) => {
    if (controller.signal.aborted) return;
    switch (item.type) {
      case "send":
        if (item.data.type === "conversation_initiation_client_data")
          throw new Error(
            "RTC initialization has already been sent; provide overrides in the finite bootstrap",
          );
        await publish(item.data);
        return;
      case "send_data": {
        const bytes =
          item.base64 !== undefined
            ? decodeBase64(item.base64, "RTC data")
            : Buffer.from(typeof item.data === "string" ? item.data : JSON.stringify(item.data));
        await room!.localParticipant!.publishData(bytes, {
          reliable: item.reliable ?? true,
          topic: item.topic,
          destination_identities: item.destination_identities,
        });
        rtc.events_sent += 1;
        progress();
        return;
      }
      case "send_audio":
      case "send_audio_file": {
        validateRtcFiles([item]);
        await localPublication!.waitForSubscription();
        if (controller.signal.aborted) return;
        if (item.type === "send_audio")
          await capturePcm(decodeBase64(item.audio_base_64, "RTC input"));
        else {
          const handle = await open(item.path, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size % 2 || stat.size > 64 * 1024 * 1024)
              throw new Error("Invalid PCM input file");
            const buffer = Buffer.alloc(1920);
            for (;;) {
              if (controller.signal.aborted) break;
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              if (bytesRead % 2) throw new Error("PCM input changed to an incomplete sample");
              await capturePcm(buffer.subarray(0, bytesRead));
            }
          } finally {
            await handle.close();
          }
        }
        return;
      }
      case "wait":
        await delay(item.ms, undefined, { signal: controller.signal });
        return;
      case "close":
        await source!.waitForPlayout();
        stop("closed");
        return;
    }
  };
  try {
    // The first actual disk write precedes native loading and any signaling connection.
    events = await openWriter(
      join(options.outDir, "events.received.ndjson"),
      "application/x-ndjson",
    );
    await record({ type: "rtc_state", state: "connecting" });
    sdk = await import("@livekit/rtc-node");
    room = new sdk.Room();
    room.on(sdk.RoomEvent.DataReceived, (payload) => {
      if (controller.signal.aborted) return;
      reservedEventBytes += payload.byteLength + 128;
      if (reservedEventBytes > options.maxEventBytes) {
        failed(new Error("RTC incoming event byte limit exceeded"), "rtc_limit_exceeded");
        return;
      }
      const copy = Buffer.from(payload);
      eventChain = eventChain
        .then(async () => {
          let value: JsonValue;
          try {
            value = JSON.parse(copy.toString("utf8")) as JsonValue;
          } catch {
            value = { type: "rtc_data", text: redactRtcText(copy.toString("utf8"), options.token) };
          }
          rtc.events_received += 1;
          await record(value);
          progress();
          if (
            isRecord(value) &&
            value.type === "ping" &&
            isRecord(value.ping_event) &&
            typeof value.ping_event.event_id === "number"
          )
            await publish({ type: "pong", event_id: value.ping_event.event_id });
          if (isRecord(value) && value.type === "error")
            failed(
              new Error(
                typeof value.message === "string"
                  ? value.message
                  : "ElevenLabs reported an RTC error",
              ),
              "rtc_provider_error",
            );
        })
        .catch((problem) => failed(problem, "rtc_event_error"));
    });
    room.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (track.kind === sdk!.TrackKind.KIND_AUDIO)
        void captureAudio(track, participant).catch((problem) =>
          failed(problem, "rtc_media_error"),
        );
    });
    room.on(sdk.RoomEvent.TrackUnsubscribed, (track) => {
      if (track.sid)
        void captures
          .get(track.sid)
          ?.reader.cancel()
          .catch(() => undefined);
    });
    room.on(sdk.RoomEvent.ParticipantDisconnected, (participant) => {
      if (participant.identity.startsWith("agent")) stop("agent_disconnected");
    });
    room.on(sdk.RoomEvent.Disconnected, () => stop("disconnected"));
    const connected = room.connect(options.serverUrl, options.token, {
      autoSubscribe: true,
      dynacast: false,
      dataStream: { maxPayloadByteLength: options.maxEventBytes },
    });
    await Promise.race([connected, stopped]);
    if (controller.signal.aborted) throw new Error("RTC session ended before connection completed");
    source = new sdk.AudioSource(48000, 1, 200);
    localTrack = sdk.LocalAudioTrack.createAudioTrack("elv-pcm-input", source);
    localPublication = await room.localParticipant!.publishTrack(
      localTrack,
      new sdk.TrackPublishOptions({ source: sdk.TrackSource.SOURCE_MICROPHONE, dtx: false }),
    );
    const initialization = options.script.findIndex(
      (item) => item.type === "send" && item.data.type === "conversation_initiation_client_data",
    );
    if (initialization >= 0) {
      for (const item of options.script.slice(0, initialization)) await action(item);
      await publish((options.script[initialization] as Extract<RtcAction, { type: "send" }>).data);
    } else await publish({ type: "conversation_initiation_client_data" });
    rtc.reason = "connected";
    progress();
    await post({ type: "ready" });
    const play = async () => {
      for (const item of options.script.slice(initialization >= 0 ? initialization + 1 : 0)) {
        await action(item);
        if (controller.signal.aborted) return;
      }
      if (options.duplex) {
        for (;;) {
          const next = await queue.next();
          if (!next || controller.signal.aborted) break;
          await action(next.action);
          await post({ type: "ack", id: next.id });
        }
        if (!controller.signal.aborted) {
          await source!.waitForPlayout();
          stop("input_ended");
        }
      } else await stopped;
    };
    await Promise.race([
      play().catch((problem) => {
        if (!controller.signal.aborted) failed(problem, "rtc_action_error");
      }),
      stopped,
    ]);
  } catch (problem) {
    if (!controller.signal.aborted) failed(problem);
  } finally {
    clearTimeout(timer);
    controller.abort();
    queue.end();
    process.removeListener("message", onMessage);
    try {
      await settleCleanup([...captures.values()].map(({ reader }) => reader.cancel()));
      await settleCleanup([
        room?.disconnect() ?? Promise.resolve(),
        localTrack?.close(false) ?? Promise.resolve(),
        source?.close() ?? Promise.resolve(),
      ]);
      await settleCleanup([eventChain, ...captureTasks]);
      if (events) {
        const path = await events.close();
        const file = { ...(await fileRecord(path, { hash: true })), mime: "application/x-ndjson" };
        files.push(file);
        await post({ type: "artifact", file });
      }
      rtc.closed = true;
      rtc.partial =
        Boolean(error) ||
        rtc.timed_out ||
        !["closed", "input_ended", "agent_disconnected", "disconnected"].includes(rtc.reason);
      const manifest = await writeManifest(options.outDir, { rtc, files } as unknown as JsonValue);
      files.push({ ...(await fileRecord(manifest, { hash: true })), mime: "application/json" });
    } catch (problem) {
      error ??= {
        code: "rtc_cleanup_error",
        message: redactRtcText(errorMessage(problem), options.token),
      };
      rtc.partial = true;
    }
    try {
      if (sdk) await bounded(sdk.dispose(), 750);
    } catch {
      error ??= {
        code: "rtc_cleanup_error",
        message: "Native RTC disposal failed or exceeded its deadline",
      };
      rtc.partial = true;
    }
    await post({ type: "result", result: { rtc, files }, error });
  }
}

if (process.env.ELV_RTC_WORKER === "1" && process.send) {
  process.once("message", (message: ParentMessage) => {
    if (message.type !== "start") {
      process.exitCode = 1;
      return;
    }
    void run(message.options).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
