import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_RTC_FILE_BYTES,
  MAX_RTC_LINE_BYTES,
  parseRtcScript,
  validateRtcAction,
  validateRtcFiles,
} from "../../src/rtc/actions";

describe("RTC NDJSON preflight", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "elv-rtc-actions-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("preserves public client events including future event fields", () => {
    const events = [
      {
        type: "conversation_initiation_client_data",
        dynamic_variables: { name: "A" },
        tool_mock_config: { enabled: true },
      },
      { type: "user_message", text: "Hello" },
      { type: "client_tool_result", tool_call_id: "tool-1", result: "Done", is_error: false },
      { type: "future_public_event", new_field: [1, { enabled: true }] },
    ];
    expect(
      parseRtcScript(events.map((data) => JSON.stringify({ type: "send", data })).join("\n")),
    ).toEqual(events.map((data) => ({ type: "send", data })));
  });

  it("supports explicit data escape hatch, PCM files, waits, and close", () => {
    expect(
      validateRtcAction({
        type: "send_data",
        data: "raw text",
        topic: "custom",
        reliable: false,
        destination_identities: ["agent"],
      }),
    ).toEqual({
      type: "send_data",
      data: "raw text",
      topic: "custom",
      reliable: false,
      destination_identities: ["agent"],
    });
    expect(validateRtcAction({ type: "send_data", base64: "AAEC", topic: "binary" })).toMatchObject(
      { base64: "AAEC" },
    );
    expect(
      validateRtcAction({ type: "send_audio_file", path: "input.pcm", sample_rate: 48000 }),
    ).toMatchObject({ sample_rate: 48000, channels: 1 });
    expect(validateRtcAction({ type: "wait", ms: 50 })).toEqual({ type: "wait", ms: 50 });
    expect(validateRtcAction({ type: "close" })).toEqual({ type: "close" });
  });

  it.each([
    { type: "send", data: [] },
    { type: "send", data: { text: "missing event type" } },
    { type: "send_data", data: {}, base64: "AA==" },
    { type: "send_data", base64: "not base64" },
    { type: "send_audio_file", path: "input.pcm", sample_rate: 16000 },
    { type: "send_audio_file", path: "input.pcm", channels: 2 },
    { type: "wait", ms: -1 },
    { type: "wait", ms: Infinity },
    { type: "close", data: { ignored: true } },
  ])("rejects invalid actions locally: %j", (action) => {
    expect(() => validateRtcAction(action)).toThrow();
  });

  it("refuses an explicit initialization after other outbound data", () => {
    expect(() =>
      parseRtcScript(
        [
          { type: "send", data: { type: "user_message", text: "Hello" } },
          { type: "send", data: { type: "conversation_initiation_client_data" } },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n"),
      ),
    ).toThrow(/initialization/i);
  });

  it("validates regular PCM files without modifying the caller input", () => {
    const file = join(dir, "input.pcm");
    writeFileSync(file, Buffer.alloc(1920));
    expect(() =>
      validateRtcFiles([{ type: "send_audio_file", path: file, sample_rate: 48000, channels: 1 }]),
    ).not.toThrow();
    writeFileSync(file, Buffer.alloc(3));
    expect(() =>
      validateRtcFiles([{ type: "send_audio_file", path: file, sample_rate: 48000, channels: 1 }]),
    ).toThrow(/PCM/i);
    expect(() =>
      validateRtcFiles([{ type: "send_audio_file", path: dir, sample_rate: 48000, channels: 1 }]),
    ).toThrow(/file/i);
  });

  it.each([
    { type: "send_audio_file", path: "input.pcm", sample_rate: null },
    { type: "send_audio_file", path: "input.pcm", channels: null },
    { type: "send_audio", audio_base_64: "NBI=", sample_rate: null },
    { type: "send_audio", audio_base_64: "NBI=", channels: null },
  ])("rejects explicit null PCM configuration instead of silently defaulting: %j", (action) => {
    expect(() => validateRtcAction(action)).toThrow(/48000.*mono/u);
  });

  it("reports physical line numbers after blank lines", () => {
    expect(() => parseRtcScript("\n \r\nnot-json")).toThrow(/line 3/u);
    expect(() => parseRtcScript("\n\n" + " ".repeat(1024 * 1024) + '{"type":"close"}')).toThrow(
      /line 3.*1 MiB/u,
    );
  });

  it("preserves every JSON value type in nested public event fields", () => {
    const data = {
      type: "client_tool_result",
      tool_call_id: "tool_1",
      is_error: false,
      result: {
        text: "caf\u00e9",
        number: 1.25,
        zero: 0,
        enabled: true,
        empty: null,
        nested: [{ values: [false, "", 42] }],
      },
      future_extension: { raw: { type: "future_nested_type", value: [null, false, 0] } },
    };
    const raw = JSON.stringify({ type: "send", data });
    expect(parseRtcScript(raw)).toEqual([{ type: "send", data }]);
  });

  it.each([
    { label: "null", data: null },
    { label: "false", data: false },
    { label: "zero", data: 0 },
    { label: "empty string", data: "" },
    { label: "UTF8 string", data: "caf\u00e9 \ud83c\udfb5" },
    { label: "array", data: [null, false, 3, { nested: true }] },
    { label: "object", data: { typed: "content", future: { field: [1, 2] } } },
  ])("preserves $label in the explicit data escape hatch", ({ data }) => {
    const action = {
      type: "send_data",
      data,
      topic: "",
      reliable: true,
      destination_identities: [],
    };
    expect(parseRtcScript(JSON.stringify(action))).toEqual([action]);
  });

  it.each([
    { type: "send_data" },
    { type: "send_data", data: null, base64: "AA==" },
    { type: "send_data", base64: 123 },
    { type: "send_data", base64: "" },
    { type: "send_data", base64: "AA===wrong" },
    { type: "send_data", data: {}, topic: null },
    { type: "send_data", data: {}, topic: 1 },
    { type: "send_data", data: {}, reliable: "true" },
    { type: "send_data", data: {}, reliable: null },
    { type: "send_data", data: {}, destination_identities: "agent" },
    { type: "send_data", data: {}, destination_identities: [""] },
    { type: "send_data", data: {}, destination_identities: [1] },
    { type: "send_data", data: {}, destination_identities: null },
  ])("rejects ambiguous data or incorrectly typed packet options: %j", (action) => {
    expect(() => parseRtcScript(JSON.stringify(action))).toThrow(
      /send_data|base64|topic|reliable|identities/u,
    );
  });

  it("normalizes inline and file PCM to 48 kHz mono without changing the audio bytes", () => {
    const file = join(dir, "small-valid.pcm");
    const bytes = Buffer.from([0x34, 0x12, 0xff, 0x7f, 0x00, 0x80]);
    writeFileSync(file, bytes);
    const actions = parseRtcScript(
      [
        { type: "send_audio", audio_base_64: bytes.toString("base64") },
        { type: "send_audio_file", path: file },
      ]
        .map((value) => JSON.stringify(value))
        .join("\r\n"),
    );
    expect(actions).toEqual([
      { type: "send_audio", audio_base_64: "NBL/fwCA", sample_rate: 48000, channels: 1 },
      { type: "send_audio_file", path: file, sample_rate: 48000, channels: 1 },
    ]);
    const before = JSON.stringify(actions);
    validateRtcFiles(actions);
    expect(JSON.stringify(actions)).toBe(before);
    expect(readFileSync(file)).toEqual(bytes);
  });

  it.each([
    { type: "send_audio", audio_base_64: "" },
    { type: "send_audio", audio_base_64: " " },
    { type: "send_audio", audio_base_64: "AA==" },
    { type: "send_audio", audio_base_64: "AAEC" },
    { type: "send_audio", audio_base_64: "A" },
    { type: "send_audio", audio_base_64: 12 },
    { type: "send_audio", audio_base_64: "NBI=", sample_rate: 16000 },
    { type: "send_audio", audio_base_64: "NBI=", sample_rate: "48000" },
    { type: "send_audio", audio_base_64: "NBI=", channels: 2 },
    { type: "send_audio_file", path: "input.pcm", channels: "1" },
    { type: "send_audio_file", path: "" },
    { type: "send_audio_file", path: "input\0.pcm" },
    { type: "send_audio_file", path: 1 },
  ])("rejects invalid PCM encoding, sample layout, or path: %j", (action) => {
    expect(() => parseRtcScript(JSON.stringify(action))).toThrow(
      /base64|audio_base_64|16-bit|48000|mono|path/u,
    );
  });

  it.each([
    { type: "send", data: { type: "user_audio_chunk", user_audio_chunk: "NBI=" } },
    { type: "send", data: { type: "user_audio_chunk" } },
    { type: "send", data: { type: "future_public_event", user_audio_chunk: "NBI=" } },
  ])("rejects WebSocket audio smuggled into RTC JSON events: %j", (action) => {
    expect(() => parseRtcScript(JSON.stringify(action))).toThrow(/send_audio.*send_audio_file/u);
  });

  it.each([0, 1, 2_147_483_647])("accepts the finite wait boundary %s", (ms) => {
    expect(validateRtcAction({ type: "wait", ms })).toEqual({ type: "wait", ms });
  });

  it.each([-1, 0.5, NaN, Infinity, -Infinity, 2_147_483_648, "1", null])(
    "rejects non-finite/out-of-range/non-integer wait %s",
    (ms) => {
      expect(() => validateRtcAction({ type: "wait", ms })).toThrow(/finite integer/u);
    },
  );

  it.each([
    { type: "send", data: { type: "user_message", text: "first" } },
    { type: "send_data", data: "first" },
    { type: "send_audio", audio_base_64: "NBI=" },
    { type: "send_audio_file", path: "input.pcm" },
    { type: "send", data: { type: "conversation_initiation_client_data" } },
  ])("rejects initialization after any earlier outbound action: %j", (first) => {
    const raw = [first, { type: "send", data: { type: "conversation_initiation_client_data" } }]
      .map((value) => JSON.stringify(value))
      .join("\n");
    expect(() => parseRtcScript(raw)).toThrow(/initialization/u);
  });

  it("allows waits before initialization and whitespace after a final close", () => {
    const values = [
      { type: "wait", ms: 0 },
      {
        type: "send",
        data: { type: "conversation_initiation_client_data", dynamic_variables: { count: 0 } },
      },
      { type: "close" },
    ];
    expect(
      parseRtcScript(
        "\r\n" + values.map((value) => JSON.stringify(value)).join("\r\n\r\n") + "\r\n \n",
      ),
    ).toEqual(values);
    expect(parseRtcScript(" \n\r\n")).toEqual([]);
  });

  it.each([{ type: "wait", ms: 0 }, { type: "close" }, { type: "send_data", data: false }])(
    "rejects any action after close: %j",
    (next) => {
      expect(() =>
        parseRtcScript(JSON.stringify({ type: "close" }) + "\n" + JSON.stringify(next)),
      ).toThrow(/close must be the final/u);
    },
  );

  it("enforces the 1 MiB limit in bytes, including multibyte UTF8", () => {
    expect(MAX_RTC_LINE_BYTES).toBe(1024 * 1024);
    const overhead = Buffer.byteLength(JSON.stringify({ type: "send_data", data: "" }));
    const data = "x".repeat(MAX_RTC_LINE_BYTES - overhead);
    const exactLine = JSON.stringify({ type: "send_data", data });
    expect(Buffer.byteLength(exactLine)).toBe(1024 * 1024);
    expect(parseRtcScript(exactLine)).toEqual([{ type: "send_data", data }]);
    const oversized = {
      type: "send_data",
      data: "\u20ac".repeat(Math.ceil(MAX_RTC_LINE_BYTES / 3)),
    };
    expect(JSON.stringify(oversized).length).toBeLessThan(MAX_RTC_LINE_BYTES);
    expect(() => parseRtcScript(JSON.stringify(oversized))).toThrow(/line 1.*1 MiB/u);
    expect(() => validateRtcAction(oversized)).toThrow(/action exceeds 1 MiB/u);
  });

  it("accepts a 16 MiB script but rejects one more byte", () => {
    const line = '{"type":"wait","ms":0}'.padEnd(1024 * 1024 - 1, " ") + "\n";
    const exactScript = line.repeat(16);
    expect(Buffer.byteLength(exactScript)).toBe(16 * 1024 * 1024);
    expect(parseRtcScript(exactScript)).toEqual(
      Array.from({ length: 16 }, () => ({ type: "wait", ms: 0 })),
    );
    expect(() => parseRtcScript(exactScript + "\n")).toThrow(/script exceeds 16 MiB/u);
  });

  it("caps scripts at 10000 actual actions rather than counting blank lines", () => {
    const line = '{"type":"wait","ms":0}\n\n';
    expect(parseRtcScript(line.repeat(10_000))).toHaveLength(10_000);
    expect(() => parseRtcScript(line.repeat(10_001))).toThrow(/10000 actions/u);
  });

  it("accepts exactly 64 MiB of PCM and rejects a larger even-sized real file", () => {
    expect(MAX_RTC_FILE_BYTES).toBe(64 * 1024 * 1024);
    const file = join(dir, "size-boundary.pcm");
    writeFileSync(file, Buffer.alloc(0));
    const action = validateRtcAction({ type: "send_audio_file", path: file });
    expect(() => validateRtcFiles([action])).toThrow(/nonempty/u);
    truncateSync(file, MAX_RTC_FILE_BYTES);
    expect(() => validateRtcFiles([action])).not.toThrow();
    truncateSync(file, MAX_RTC_FILE_BYTES + 2);
    expect(() => validateRtcFiles([action])).toThrow(/64 MiB/u);
  });

  it("rejects missing and odd PCM files but never reads event-data paths", () => {
    const missing = join(dir, "does-not-exist.pcm");
    expect(() =>
      validateRtcFiles([validateRtcAction({ type: "send_audio_file", path: missing })]),
    ).toThrow(/ENOENT/u);
    const odd = join(dir, "odd.pcm");
    writeFileSync(odd, Buffer.from([1]));
    expect(() =>
      validateRtcFiles([validateRtcAction({ type: "send_audio_file", path: odd })]),
    ).toThrow(/16-bit/u);
    expect(() =>
      validateRtcFiles([
        validateRtcAction({ type: "send", data: { type: "future_public_event", path: missing } }),
      ]),
    ).not.toThrow();
  });
});
