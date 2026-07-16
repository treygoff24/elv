=== completionReport ===
I'll do a read-only streaming/protocol review: first scan relevant skills and the `a9de3c2..HEAD` diff, then probe Music SSE, JSON events, WebSocket, and dry-run paths for verified bugs.Skills applied: agentfit (envelope/exit contracts), delegate safe-mode constraints. Next I'll map streaming/WS implementation files and the `a9de3c2..HEAD` protocol surface.## Skills applied
| Skill | Why |
| --- | --- |
| `agentfit` | Envelope/exit contracts, dry-run honesty, fail-closed behavior |
| `delegate-agent` | Safe/read-only mode constraints |
| Others | Not needed beyond streaming/protocol review |

**Mode:** read-only. No mutations. No `node_modules` here — verification was source + Node logic probes + existing tests (not a full vitest run).

**Range:** `a9de3c2..HEAD` (through `fa92709`), focus files under `src/core/response-normalizer.ts`, `src/ws/*`, `src/commands/ws.ts`, `src/core/{client,request-builder,files}.ts`, streaming tests.

---

# Round 3: streaming and protocol correctness

## Finding 1 — HIGH: `json_events` deletes paid partial output on any stream error

**Evidence**

```725:729:src/core/response-normalizer.ts
  } catch (error) {
    await ndjson.abort();
    if (audio) await audio.abort();
    throw error;
  }
```

```706:708:src/core/response-normalizer.ts
    pending += decoder.decode();
    const parsed = extractJsonObjects(pending);
    if (parsed.rest.trim()) throw new Error("Incomplete trailing JSON event");
```

Complete events are written incrementally during the loop (`writeJsonEvent`), then a truncated tail throws. `abort()` destroys and unlinks the temp files (`files.ts` temp writer). SSE on the same module **preserves** partials (`streamSseEventsResponse` catch + `partial: true`); this path still fails closed by deletion.

**Reproduction**

1. Stream N complete `{audio_base64:...}` objects (already flushed to the temp audio file).
2. End the body with a truncated object (`{"audio_base64":"`).
3. `normalizeResponse` throws; temps are deleted; caller gets a thrown error / generic envelope with **no** `files[]`.

Covered today only as “rejects incomplete trailing JSON events” (expects throw), not partial preservation.

**Smallest fix**

Mirror SSE: on catch, `close()` any writer that received bytes, mark `partial: true`, return `failure({ code: "invalid_json_events_stream", files, hints: credits-may-be-consumed })` instead of abort+throw. Add a test parallel to `sse-events-expansion.test.ts` partial case.

---

## Finding 2 — HIGH: WebSocket failures drop decoded audio/events (no partial `files[]`)

**Evidence**

```67:70:src/ws/session.ts
  } catch (error) {
    await abortSession(socket, events, audio, inactivity);
    throw error;
  }
```

```183:193:src/ws/session.ts
async function abortSession(...): Promise<void> {
  inactivity.clear();
  await Promise.allSettled([events.abort(), audio.abort()]);
  ...
}
```

```432:439:src/commands/ws.ts
  return {
    env: failure({
      cmd: "elv ws",
      error: { type: "network_error", code: "ws_session_failed", message },
      retry: { recommended: false, after_ms: null },
    }),
```

Any post-open failure (malformed JSON frame, pong send failure, mid-session network error) deletes `events.received.ndjson` and decoded `audio.*`. The error envelope has **no** `files`. Binary frames already written are orphaned on disk and also omitted from the envelope.

**Reproduction**

`tests/ws/ws-session.test.ts` “malformed JSON” / “pong failed” paths: session rejects; prior audio (if any) is not returned. Same structure as paid TTS realtime after audio chunks have already arrived.

**Smallest fix**

On session failure after any successful receive/write: close (don’t abort) events/audio/binary paths, attach them to the failure envelope with `partial: true`, and surface a credits/recovery hint. Keep abort only when nothing was written.

---

## Finding 3 — MEDIUM: WebSocket connect phase can hang forever

**Evidence**

```51:57:src/ws/session.ts
  const inactivity = createInactivityTimer(socket, timeoutMs);
  ...
    await waitForOpen(socket, state);
    inactivity.reset();
```

`InactivityTimer` is only started **after** open. `waitForOpen` waits solely on `open`/`error`. A hung TCP connect (no RST, no open) never starts the inactivity timer → session blocks until OS-level connect timeout (often minutes), ignoring `--timeout-ms`.

**Reproduction**

Point `elv ws` at a black-hole address/port that accepts SYN into a filter without completing handshake; pass a small `--timeout-ms`. Observed: open wait is unbounded by the app timer.

**Smallest fix**

Arm the same timer (or a dedicated connect timer) before `waitForOpen`; on fire, `terminate()` and fail with a structured `ws_connect_timeout` error.

---

## Finding 4 — MEDIUM: inactivity timeout reports success; `timed_out` not on `ws` envelope

**Evidence**

```219:225:src/ws/session.ts
  handleTimeout(): void {
    this.didTimeOut = true;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    ...
  }
```

```155:178:src/ws/session.ts
  // manifest includes timed_out: inactivity.timedOut()
  return {
    ws: {
      catalog, path, events_sent, events_received, closed: state.closed,
      // no timed_out
    },
    files,
  };
```

Timeout closes the socket; `runWsSession` finishes successfully (`ok: true`, exit 0). Agents that only read `env.ws` / exit code treat a truncated paid session as full success unless they open `manifest.json`.

**Reproduction**

Scripted session against a server that never closes and stops messaging; wait past `--timeout-ms` → exit 0, `ws.closed: true`, timeout only inside manifest.

**Smallest fix**

Add `timed_out` to `WsInfo` / success envelope. Prefer non-zero exit or `warnings: [{ code: "ws_inactivity_timeout" }]` when timed out (and optionally `partial` on audio/events).

---

## Finding 5 — MEDIUM: stream audio extension ignores `output_format` on real call/http paths

**Evidence**

```77:87:src/core/request-builder.ts
  const path = resolvePath(...);          // path only, no query
  const url = requestUrl(path, normalized, ...); // query on URL only
  ...
  return baseRequest(..., path);          // HttpRequest.path has no ?output_format=
```

```312:312:src/core/client.ts
    requestPath: requestPath ?? req.path,
```

```818:824:src/core/response-normalizer.ts
function audioExtensionFromRequestPath(path: string | undefined): string {
  const outputFormat = requestPathSearchParams(path).get("output_format") ?? "";
  ...
}
```

Node probe: path-only → always `"mp3"`; with `?output_format=pcm_44100` → `"pcm"`.

Tests that pass `requestPath: "...?output_format=mp3_..."` hide this. Production `elv call` / `elv music detailed-stream --format pcm_*` write `*.mp3` for non-MP3 codecs (bytes correct, extension wrong). WS is fine (`url.searchParams.get("output_format")`).

**Smallest fix**

Set `HttpRequest.path` (or a dedicated `requestPath`) to `pathname + search` from the final URL, or pass `normalized.query.output_format` into the normalizer. Add a unit test that builds a real request with `output_format=pcm_44100` and asserts the audio file ends in `.pcm`.

---

## Finding 6 — MEDIUM: lenient base64 on `json_events` / WS audio vs strict SSE

**Evidence**

- SSE: `decodeBase64` rejects invalid alphabets (`response-normalizer.ts:663-677`), tested with `%%%` partial preservation.
- `json_events`: `Buffer.from(audio, "base64")` (`writeJsonEvent`) — Node is lenient (`"not!!valid"` → non-empty garbage buffer, no throw).
- WS `AudioWriter`: same lenient `Buffer.from`.

**Reproduction**

JSON event `{"audio_base64":"not!!valid"}` → success envelope with corrupted audio file, no error.

**Smallest fix**

Reuse `decodeBase64` (or shared helper) in `writeJsonEvent` and `AudioWriter.writeFromEvent`; on failure, preserve partials (Findings 1–2) and fail the stream/session.

---

## Finding 7 — LOW: SSE partial path can abort audio if first frame fails after audio write

**Evidence**

```619:634:src/core/response-normalizer.ts
  if (audio) await audioWriter().write(audio);
  await ndjson.write(...);
  return { event: true, audioBytes: audio?.byteLength ?? 0 };
```

`audioBytes` is only increased from the return value. If `ndjson.write` throws on the **first** event after audio was written: `eventCount === 0`, `audioBytes === 0` → catch aborts audio despite bytes already in the temp stream.

**Smallest fix**

Track `audioBytes` (or a `wroteAudio` flag) inside the writer / before the risky second write; or close/preserve whenever `audio` is defined and its stream size &gt; 0.

---

## Disproved / verified clean

| Suspicion | Result |
| --- | --- |
| SSE arbitrary chunk / CRLF / lone-CR hold / multiline `data:` / `[DONE]` / comment frames | **Clean** — `feedSse` + `sse-events-expansion.test.ts` (byte-at-a-time body) |
| Music SSE partial on bad trailing base64 | **Clean** — preserves NDJSON+audio with `partial: true` + credit hint |
| Round 1 `json_events` escape `\\\\` bug | **Fixed** (`char === "\\"`) + test with `\"` + `}` |
| Round 2 `//evil` host rebinding + profile key | **Fixed** (`path.startsWith("//")` reject; origin check) |
| Round 2 raw-path `--yes` / STT budget bypass | **Fixed** (`catalogEntryForRawPath` + tests for monitor/STT path forms) |
| Catalog vs raw path protocol/gates diverge | **Disproved** for monitor confirm + STT budget |
| Monitor receive-only without `--send` | **Works**; outbound script still needs `--yes` |
| Auto-pong with `event_id` | **Works** (session test) |
| STT binary exact send + inbound binary files | **Works** |
| Script-relative `send_binary_file` path resolution | **Works** (`dirname(script)` + preflight size check) |
| Dry-run connects / skips redaction | **Disproved** — dry-run before network; secrets redacted; `would_require_yes` / budget fields present |
| Absolute `wss://` gets profile API key | **Disproved** |
| Message-handler reject hangs session | **Disproved** — terminate + reject within timeout tests |
| HTTP/raw Music path loses `streamKind` | **Disproved** — registry match spreads full card including `sse_events` |

---

## Verdict: **approve with fixes**

**Ship Music SSE as implemented** for the D1 contract (chunk-safe parse, audio extraction, partial paid output). Do **not** claim end-to-end streaming correctness until Findings **1–2** (paid file loss on `json_events` and WS) are fixed — same failure class the plan called out for SSE. Findings **3–5** should land in the same pass (connect hang, timeout honesty, correct codec extension). **6–7** are smaller hardening.

Suggested gate: extend partial-preservation tests to `json_events` + WS error envelopes; add connect-timeout and `timed_out` envelope tests; assert `output_format=pcm_*` → `.pcm` via real `buildHttpRequest` → `normalizeResponse`.

---

## Delegate completion report

- **Status:** completed (read-only)
- **What I found:** Music SSE path is solid; two high paid-output-loss gaps remain on `json_events` and WS failure cleanup; medium connect-hang, timeout-as-success, and audio-extension-from-path bugs; minor base64 strictness/SSE counter edge cases
- **Files reviewed:** `src/core/response-normalizer.ts`, `src/core/{client,request-builder,files}.ts`, `src/ws/{session,events,catalog,audio-writer}.ts`, `src/commands/ws.ts`, `src/openapi/compile-spec.ts`, streaming/WS tests, Round 1–2 reviews + plan D/F notes
- **Files changed:** none
- **Verification:** static analysis + Node probes (base64 lenience, SSE chunk logic, audio extension path); existing tests as evidence; full vitest **not** run (no `node_modules` in this copy)
- **Remaining risks / follow-ups:** live provider Music SSE event-shape drift (only mocked keys tested); WS orphan binary frames on abort; coordinator should re-run `tests/core/sse*`, `tests/core/json-events*`, `tests/ws/*` after fixes
