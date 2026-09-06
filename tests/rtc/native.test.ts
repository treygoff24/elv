import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type * as LiveKit from "@livekit/rtc-node";
import { parseEnvelope, recordValue, filesArray } from "../helpers/cli-result";
import type { RtcAction } from "../../src/rtc/actions";

const serverUrl = process.env.ELV_RTC_TEST_URL;
const native = serverUrl ? describe : describe.skip;

function jwt(room: string, identity: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const data = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "devkey", sub: identity, nbf: now - 5, exp: now + 120, video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true } })}`;
  return `${data}.${createHmac("sha256", "secret").update(data).digest("base64url")}`;
}

function tone(frequency: number, frames = 40): Buffer {
  const bytes = Buffer.alloc(frames * 960 * 2);
  for (let i = 0; i < bytes.length / 2; i += 1)
    bytes.writeInt16LE(Math.round(7000 * Math.sin((2 * Math.PI * frequency * i) / 48000)), i * 2);
  return bytes;
}

function amplitude(bytes: Buffer, frequency: number): number {
  let real = 0;
  let imaginary = 0;
  const samples = bytes.length / 2;
  for (let i = 0; i < samples; i += 1) {
    const sample = bytes.readInt16LE(i * 2);
    real += sample * Math.cos((2 * Math.PI * frequency * i) / 48000);
    imaginary += sample * Math.sin((2 * Math.PI * frequency * i) / 48000);
  }
  return samples ? (2 * Math.hypot(real, imaginary)) / samples : 0;
}

async function deadline<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Local RTC fixture timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertManifest(envelope: ReturnType<typeof parseEnvelope>): void {
  const files = filesArray(envelope);
  const manifests = files.filter(
    (file) =>
      basename(String(file.path)).startsWith("manifest") && file.mime === "application/json",
  );
  expect(manifests, "every completed RTC receipt must name its final manifest").toHaveLength(1);
  const manifest = manifests[0]!;
  for (const file of files) {
    const bytes = readFileSync(String(file.path));
    expect(file.bytes, String(file.path)).toBe(bytes.length);
    expect(file.sha256, String(file.path)).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  const parsed = recordValue(JSON.parse(readFileSync(String(manifest.path), "utf8")));
  const result = envelope.ok
    ? recordValue(envelope.data)
    : recordValue(recordValue(recordValue(envelope.error).raw).rtc);
  const { conversation_id: _conversationId, ...rtc } = result;
  expect(parsed.rtc).toEqual(rtc);
  expect(recordValue(parsed.rtc).transport).toBe("webrtc");
  expect(parsed.files).toEqual(files.filter((file) => file.path !== manifest.path));
}

native("real local LiveKit CLI data and PCM transport (not live ElevenLabs)", () => {
  let sdk: typeof LiveKit;
  let directory: string;
  let roomName: string;
  let oracle: LiveKit.Room;
  const tracks: LiveKit.LocalAudioTrack[] = [];
  const readers: ReadableStreamDefaultReader<LiveKit.AudioFrame>[] = [];
  const tasks: Promise<unknown>[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    const url = new URL(serverUrl!);
    if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1")
      throw new Error(
        "RTC integration fixture must be an explicit loopback dev server, never a provider",
      );
    sdk = await import("@livekit/rtc-node");
  });
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "elv-rtc-native-"));
    roomName = `elv-product-${randomUUID()}`;
    oracle = new sdk.Room();
    await deadline(
      oracle.connect(serverUrl!, jwt(roomName, "agent-local-canary"), {
        autoSubscribe: true,
        dynacast: false,
      }),
    );
  });
  afterEach(async () => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
    await deadline(Promise.allSettled(tasks.splice(0)), 5000).catch(() => undefined);
    await deadline(
      Promise.allSettled(readers.splice(0).map((reader) => reader.cancel())),
      5000,
    ).catch(() => undefined);
    await deadline(oracle.disconnect(), 5000);
    await deadline(Promise.allSettled(tracks.splice(0).map((track) => track.close())), 5000);
    rmSync(directory, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (sdk) await sdk.dispose();
  });

  function startCli(script: RtcAction[], flags: string[] = [], detached = false) {
    const token = jwt(roomName, "elv-client-canary");
    const path = join(directory, "script.ndjson");
    writeFileSync(path, script.map((action) => JSON.stringify(action)).join("\n"));
    const args = [
      "rtc",
      "--server-url",
      serverUrl!,
      "--token-env",
      "ELV_LOCAL_RTC_TOKEN",
      "--send",
      path,
      "--out",
      join(directory, "output"),
      "--timeout-ms",
      "15000",
      "--yes",
      ...flags,
    ];
    const binary = process.env.ELV_RTC_BIN;
    const child = spawn(
      binary ?? process.execPath,
      binary ? args : ["--import", "tsx", "src/cli.ts", ...args],
      {
        detached,
        env: {
          ...process.env,
          ELEVENLABS_API_KEY: "",
          ELV_MAX_CREDITS: "",
          ELV_LOCAL_RTC_TOKEN: token,
        },
      },
    );
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      },
    );
    return { child, token, result };
  }

  async function publishTone(frequency: number) {
    const source = new sdk.AudioSource(48000, 1, 200);
    const track = sdk.LocalAudioTrack.createAudioTrack(`tone-${frequency}`, source);
    tracks.push(track);
    const publication = await oracle.localParticipant!.publishTrack(
      track,
      new sdk.TrackPublishOptions({ source: sdk.TrackSource.SOURCE_MICROPHONE, dtx: false }),
    );
    const send = async () => {
      await deadline(publication.waitForSubscription());
      const pcm = tone(frequency);
      for (let offset = 0; offset < pcm.length; offset += 1920) {
        const bytes = pcm.subarray(offset, offset + 1920);
        // rtc-node 0.13.34 protoInfo ignores Int16Array.byteOffset; own each frame's buffer.
        const samples = Int16Array.from(
          new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
        );
        await source.captureFrame(new sdk.AudioFrame(samples, 48000, 1, samples.length));
      }
      await source.waitForPlayout();
    };
    return { id: publication.sid!, send };
  }

  function receiveClientAudio(minimumBytes: number): Promise<Buffer> {
    let resolveAudio!: (bytes: Buffer) => void;
    const result = new Promise<Buffer>((resolve) => {
      resolveAudio = resolve;
    });
    oracle.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (participant.identity !== "elv-client-canary" || track.kind !== sdk.TrackKind.KIND_AUDIO)
        return;
      const reader = new sdk.AudioStream(track, {
        sampleRate: 48000,
        numChannels: 1,
        frameSizeMs: 20,
      }).getReader();
      readers.push(reader);
      const collect = (async () => {
        const frames: Buffer[] = [];
        let bytes = 0;
        while (bytes < minimumBytes) {
          const next = await reader.read();
          if (next.done) break;
          const copy = Buffer.from(
            new Uint8Array(
              next.value.data.buffer,
              next.value.data.byteOffset,
              next.value.data.byteLength,
            ),
          );
          if (amplitude(copy, 440) < 100) continue;
          frames.push(copy);
          bytes += copy.length;
        }
        resolveAudio(Buffer.concat(frames));
      })();
      tasks.push(collect);
    });
    return result;
  }

  it("exchanges reliable public JSON, auto-pong, and distinct bidirectional PCM through the CLI worker", async () => {
    const first = await publishTone(880);
    const second = await publishTone(1320);
    const incoming: { data: Record<string, unknown>; kind: unknown; topic: unknown }[] = [];
    const clientAudio = receiveClientAudio(24000);
    const input = join(directory, "caller-input.pcm");
    const pcm = tone(440);
    writeFileSync(input, pcm);
    let token = "";
    oracle.on(sdk.RoomEvent.DataReceived, (bytes, _participant, kind, topic) => {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      incoming.push({ data, kind, topic });
      if (data.type === "conversation_initiation_client_data") {
        const respond = async () => {
          await oracle.localParticipant!.publishData(
            new TextEncoder().encode(
              JSON.stringify({
                type: "agent_response",
                agent_response_event: {
                  agent_response: `Hello ${token}`,
                  url: `https://example.test/?token=${token}`,
                },
              }),
            ),
            { reliable: true },
          );
          await oracle.localParticipant!.publishData(
            new TextEncoder().encode(
              JSON.stringify({ type: "ping", ping_event: { event_id: 77 } }),
            ),
            { reliable: true },
          );
          await Promise.all([first.send(), second.send()]);
        };
        tasks.push(respond());
      }
    });
    const started = startCli([
      {
        type: "send",
        data: {
          type: "conversation_initiation_client_data",
          dynamic_variables: { exact: "preserved" },
        },
      },
      { type: "send", data: { type: "future_public_event", nested: { value: "future" } } },
      { type: "send_audio_file", path: input, sample_rate: 48000, channels: 1 },
      { type: "wait", ms: 500 },
      { type: "close" },
    ]);
    token = started.token;
    const result = await deadline(started.result);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const envelope = parseEnvelope(result.stdout);
    assertManifest(envelope);
    expect(incoming[0]).toMatchObject({
      data: {
        type: "conversation_initiation_client_data",
        dynamic_variables: { exact: "preserved" },
      },
      kind: sdk.DataPacketKind.KIND_RELIABLE,
    });
    expect(incoming.every((packet) => !packet.topic)).toBe(true);
    expect(
      incoming.some(
        ({ data }) =>
          data.type === "future_public_event" && recordValue(data.nested).value === "future",
      ),
    ).toBe(true);
    expect(incoming.some(({ data }) => data.type === "pong" && data.event_id === 77)).toBe(true);
    const capturedInput = await deadline(clientAudio);
    expect(amplitude(capturedInput, 440)).toBeGreaterThan(amplitude(capturedInput, 880) * 5);
    expect(readFileSync(input)).toEqual(pcm);
    const data = recordValue(envelope.data);
    expect(data).toMatchObject({ closed: true, partial: false, audio_input_bytes: pcm.length });
    const outputs = data.audio_tracks as unknown as {
      track_id: string;
      path: string;
      sample_rate: number;
      channels: number;
    }[];
    expect(outputs).toHaveLength(2);
    for (const [id, frequency, other] of [
      [first.id, 880, 1320],
      [second.id, 1320, 880],
    ] as const) {
      const output = outputs.find((candidate) => candidate.track_id === id)!;
      expect(output).toMatchObject({ sample_rate: 48000, channels: 1 });
      const bytes = readFileSync(output.path);
      let energy = 0;
      let crossings = 0;
      for (let i = 0; i < bytes.length / 2; i += 1) {
        const value = bytes.readInt16LE(i * 2);
        energy += value * value;
        if (i && Math.sign(value) !== Math.sign(bytes.readInt16LE((i - 1) * 2))) crossings += 1;
      }
      const windows = Array.from({ length: Math.floor(bytes.length / 4096) }, (_, index) =>
        amplitude(bytes.subarray(index * 4096, (index + 1) * 4096), frequency),
      );
      expect(
        amplitude(bytes, frequency),
        JSON.stringify({
          track: id,
          frequency,
          bytes: bytes.length,
          rms: Math.sqrt(energy / (bytes.length / 2)),
          crossings,
          maxWindowAmplitude: Math.max(...windows),
          otherAmplitude: amplitude(bytes, other),
        }),
      ).toBeGreaterThan(amplitude(bytes, other) * 5);
    }
    expect(result.stdout + result.stderr).not.toContain(token);
    const eventFile = filesArray(envelope).find((file) => file.mime === "application/x-ndjson")!;
    const events = readFileSync(String(eventFile.path), "utf8");
    expect(events).not.toContain(token);
    for (const line of events.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  }, 20_000);

  it("supports live PCM and client events through duplex without temporary input files", async () => {
    let resolveLive!: () => void;
    const received = new Promise<void>((resolve) => {
      resolveLive = resolve;
    });
    oracle.on(sdk.RoomEvent.DataReceived, (bytes) => {
      const data = JSON.parse(new TextDecoder().decode(bytes));
      if (data.type === "user_message" && data.text === "duplex hello") resolveLive();
    });
    const audio = receiveClientAudio(3840);
    const started = startCli([], ["--duplex"]);
    started.child.stdin.write(
      JSON.stringify({ type: "send", data: { type: "user_message", text: "duplex hello" } }) + "\n",
    );
    started.child.stdin.write(
      JSON.stringify({
        type: "send_audio",
        audio_base_64: tone(440, 5).toString("base64"),
        sample_rate: 48000,
        channels: 1,
      }) + "\n",
    );
    const decoded = await deadline(audio);
    expect(decoded.length).toBeGreaterThanOrEqual(3840);
    expect(amplitude(decoded, 440)).toBeGreaterThan(amplitude(decoded, 880) * 5);
    started.child.stdin.end(JSON.stringify({ type: "close" }) + "\n");
    const result = await deadline(started.result);
    await deadline(received);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(recordValue(parseEnvelope(result.stdout).data)).toMatchObject({
      closed: true,
      audio_input_bytes: 9600,
    });
    expect(result.stdout + result.stderr).not.toContain(started.token);
  }, 20_000);

  it("enforces the combined received-audio cap across concurrently active tracks", async () => {
    const first = await publishTone(880);
    const second = await publishTone(1320);
    oracle.on(sdk.RoomEvent.DataReceived, (bytes) => {
      if (
        JSON.parse(new TextDecoder().decode(bytes)).type === "conversation_initiation_client_data"
      )
        tasks.push(Promise.all([first.send(), second.send()]));
    });
    const started = startCli(
      [{ type: "wait", ms: 2000 }, { type: "close" }],
      ["--max-audio-bytes", "6000"],
    );
    const result = await deadline(started.result);
    expect(result.code).not.toBe(0);
    const envelope = parseEnvelope(result.stdout);
    assertManifest(envelope);
    expect(recordValue(envelope.error).code).toBe("rtc_media_error");
    const raw = recordValue(recordValue(envelope.error).raw);
    const rtc = recordValue(raw.rtc ?? raw);
    expect(Number(rtc.audio_output_bytes)).toBeGreaterThan(0);
    expect(Number(rtc.audio_output_bytes)).toBeLessThanOrEqual(6000);
    const audioFiles = filesArray(envelope).filter((file) => file.mime === "audio/pcm");
    expect(audioFiles.length).toBeGreaterThan(0);
    expect(audioFiles.reduce((bytes, file) => bytes + Number(file.bytes), 0)).toBeLessThanOrEqual(
      6000,
    );
  }, 20_000);

  it("times out a real joined session and preserves a closed partial receipt", async () => {
    let initialized = false;
    oracle.on(sdk.RoomEvent.DataReceived, (bytes) => {
      if (
        JSON.parse(new TextDecoder().decode(bytes)).type === "conversation_initiation_client_data"
      )
        initialized = true;
    });
    const started = startCli([{ type: "wait", ms: 5000 }], ["--timeout-ms", "2000"]);
    const result = await deadline(started.result);
    expect(initialized).toBe(true);
    const envelope = parseEnvelope(result.stdout);
    assertManifest(envelope);
    expect(result.code).not.toBe(0);
    expect(recordValue(envelope.error).code).toBe("rtc_timeout");
    const rtc = recordValue(recordValue(recordValue(envelope.error).raw).rtc);
    expect(rtc).toMatchObject({ closed: true, partial: true, timed_out: true });
    expect(filesArray(envelope).length).toBeGreaterThan(0);
    expect(result.stdout + result.stderr).not.toContain(started.token);
  }, 20_000);

  it("aborts a real joined duplex session with stdin still open and exits with partial artifacts", async () => {
    let resolveInit!: () => void;
    const initialized = new Promise<void>((resolve) => {
      resolveInit = resolve;
    });
    oracle.on(sdk.RoomEvent.DataReceived, (bytes) => {
      if (
        JSON.parse(new TextDecoder().decode(bytes)).type === "conversation_initiation_client_data"
      )
        resolveInit();
    });
    const started = startCli([], ["--duplex"]);
    await deadline(initialized);
    started.child.kill("SIGTERM");
    const result = await deadline(started.result);
    const envelope = parseEnvelope(result.stdout);
    assertManifest(envelope);
    expect(result.code).not.toBe(0);
    expect(recordValue(envelope.error).code).toBe("rtc_aborted");
    const rtc = recordValue(recordValue(recordValue(envelope.error).raw).rtc);
    expect(rtc).toMatchObject({ closed: true, partial: true });
    expect(result.stdout + result.stderr).not.toContain(started.token);
  }, 20_000);

  it.skipIf(process.platform !== "linux")(
    "handles SIGINT for the owned CLI/worker process group and preserves the manifest",
    async () => {
      let resolveInit!: () => void;
      const initialized = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      oracle.on(sdk.RoomEvent.DataReceived, (bytes) => {
        if (
          JSON.parse(new TextDecoder().decode(bytes)).type === "conversation_initiation_client_data"
        )
          resolveInit();
      });
      const started = startCli([], ["--duplex"], true);
      await deadline(initialized);
      const pid = started.child.pid!;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const group = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      expect(group).toBe(pid);
      process.kill(-group, "SIGINT");
      const result = await deadline(started.result);
      const envelope = parseEnvelope(result.stdout);
      expect(recordValue(envelope.error).code).toBe("rtc_aborted");
      expect(recordValue(recordValue(recordValue(envelope.error).raw).rtc)).toMatchObject({
        closed: true,
        partial: true,
      });
      assertManifest(envelope);
      expect(result.stdout + result.stderr).not.toContain(started.token);
    },
    20_000,
  );
});
