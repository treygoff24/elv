# Review: 0.4.0 API-parity work (92b0574..4a5c409)

Reviewed 2026-09-06 by Fable with five Opus reviewers, one per subsystem, all read-only. Range: nine commits, 102 files, +13,240/−552. Gate re-run at HEAD 4a5c409 on Node 26.5.0: typecheck, lint, format, and 850 tests pass (9 skipped: 6 native RTC gated on `ELV_RTC_TEST_URL`, 3 live integration). The journal's 856/3 figure includes the native RTC cases run against a local LiveKit server, which this run did not have.

Per-slice reports with repro commands and measured output: `/var/tmp/elv-review-{rtc,speech,ws,core,openapi}.md` on the devbox (not committed; ~400 lines each).

## Verdict

The work is sound and not meaningfully overbuilt. Every reviewer independently reached the same verdict: the safety-critical pieces (external-ref rejection, risk classification of all 24 new operations, JWT verification, token redaction, sensitive-file handling, the RTC worker split) are correct, and the tests bind real behavior rather than mirroring the implementation. Total justified simplification is roughly 250 lines out of ~9,000 new source lines, not a redesign.

Against that: six confirmed bugs I would not ship, four of which were reproduced by measurement rather than reading. Three of them contradict what the envelope tells the agent (reports success while losing data, reports success after a mid-script disconnect, reports a healthy handler turn as failed). Those are the ones that matter for an agent-first CLI.

## Ship-blockers (fix before 0.4.0 goes to npm)

| # | Where | What | Evidence |
|---|---|---|---|
| 1 | `src/core/errors.ts:283`, `src/commands/ws.ts:169` | Duplex events on stderr are truncated at `process.exit`. With a slow consumer, 401 events → 60 KB of 216 KB delivered, final event lost; envelope says `ok: true, events_received: 401`. | Measured against mock server |
| 2 | `src/commands/ws.ts:101`, `:379` | `--token-env` forwards a single-use token to an arbitrary host. Catalog matching is by path only, so `wss://attacker.example/v1/speech-to-text/realtime` inherits `stt-realtime` and gets `?token=…` appended. Profile key is not forwarded (the changelog claim is literally true), but the adjacent secret is. Envelope also labels the attacker host with the catalog name. | Reproduced with `--dry-run` |
| 3 | `src/rtc/session.ts:406-475` | Duplex stdin has zero listeners, including `error`, while the generator is suspended at `yield`, which is where a session spends nearly all its time. A stream error there is an unhandled EventEmitter error: process dies with no envelope. `ws/session.ts` avoids this via `readline`. | Reproduced |
| 4 | `src/core/files.ts:255-268` | Output publication is `link()`-only, tolerating only `EEXIST`. 0.3.0 used `rename()`. exFAT/FAT32 removable media and SMB/CIFS without Unix extensions fail every output write with `internal_error` and no hint. Undocumented in AGENTS.md, untested. The switch itself was justified (0.3.0 had a real clobber TOCTOU); the fix is an `open(candidate, "wx")` + copy fallback on `EPERM`/`ENOTSUP`/`EXDEV`, not a bare `rename` fallback. | Confirmed by reading + `git show 92b0574:src/core/files.ts` |
| 5 | `src/core/response-normalizer.ts:221-228` | New inline `media` path returns `redact(data)` on stdout for `get_project_by_id`, whose schema carries `preview_url`, `cover_image_url`, `article_image_url`. `URL_CREDENTIAL` covers `sig=`/`x-amz-signature=` but not CloudFront's `Signature=`/`Policy=`/`Key-Pair-Id=`. Before this change `data` was withheld entirely for credential-bearing responses. Flows/assets currently expose only `content_url`, which is covered. | Mechanism confirmed; exploitation depends on whether those Studio URLs are CloudFront-signed |
| 6 | `src/speech-engine/session.ts:186`, `:214` | `child.stdin.end()` races child exit; on EPIPE the stdin `error` listener calls `failTurn` unconditionally. A handler that emits a complete response and exits 0 without draining stdin is scored `turns_failed` and the conversation closes 1011 once the transcript exceeds the pipe buffer (~200 KB). Transcripts carry full history, so every long call eventually hits this. Documented handler contract does not require draining stdin. | Measured: passes at 100 KB, fails at 200/300/400 KB |

## Should fix (medium)

- **RTC exit codes inverted** (`src/commands/rtc.ts:316-327`): every non-`RtcSessionError` lands as exit 2 "fix your arguments", including "RTC worker is missing; rebuild or reinstall". `ws.ts` correctly defaults unknowns to 8.
- **RTC mid-script server disconnect reports `ok: true`** (`src/rtc/worker.ts:382`, `:471-475`): `"disconnected"` is in the not-partial allow-list; remaining script actions are silently abandoned. Nothing in `RtcInfo` reports script progress.
- **RTC worker env is allowlisted to five vars** (`src/rtc/session.ts:50-56`): drops `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY`, etc. Behind a TLS-intercepting proxy every command works except `elv rtc`, with no hint.
- **RTC session info has three envelope shapes** (`src/core/types.ts:109-119`, `src/commands/rtc.ts:294`, `:309`): `data` on success, `error.raw.rtc` on failure, while `ws` has a top-level `ws` field for both. Add `rtc?: RtcInfo` to `EnvelopeBase`.
- **RTC failures never recommend retry or hint at preserved files** (`src/commands/rtc.ts:312`): `retry.recommended` hardcoded false even for `rtc_timeout`/connection refused; `ws.ts` does both.
- **Duplex rejects `{"type":"close"}` after a terminal message** (`src/ws/events.ts:207`): `this.closed` is checked before the close branch. Static scripts never hit it because `actionsBeforeClose` strips the close. An agent that ends a TTS context then closes politely gets exit 2, a terminated socket, and `partial: true` files after a billed synthesis.
- **`flows video create --wait` has an unraisable 10-minute ceiling** (`src/commands/aliases/flows.ts:115-124` → `shared.ts:217-232`): no `--timeout-ms`/`--interval-ms` plumbed; a 12-minute Veo render exits 7 `wait_timeout` with no hint toward `flows video get --generation-id`, so the obvious agent move is to resubmit a paid generation. Same ceiling applies to `stt`/`dubbing --wait`, pre-existing.
- **Speech Engine `--host 0.0.0.0` binds every interface** with no gate beyond the `--yes` loopback already needs (`src/speech-engine/server.ts:35`). Flag help promises "non-loopback requires intentional exposure"; nothing implements it. AGENTS.md and the skill say "loopback" flatly; only README hedges. JWT has no `jti`, so a captured token replays for `exp + 60`. Also the advertised readiness URL is `ws://0.0.0.0:PORT/ws`, which nothing can connect to.
- **Speech Engine handler stderr is `"ignore"`** (`src/speech-engine/session.ts:141`): a crashing handler yields 1011 + "Handler failed or exceeded limits" + a counter. No flag to see why. For a CLI whose feature is running user handler code, this is the difference between usable and opaque.
- **Speech Engine one unverifiable process-group cleanup stops the whole server**, ending up to three healthy sessions (`session.ts:270-274` → `server.ts:140-142`). Deliberate fail-closed, but the blast radius is undocumented.
- **`@livekit/rtc-node` as a hard production dependency** (`package.json:58`): 13 MB, native FFI binaries, and pulls in pino (~38 packages). Every `npm i -g eleven-agent-cli` pays for it; the worker already loads it via dynamic `import()` at `src/rtc/worker.ts:326`. Make it an optional peer and have `elv rtc` return a clear "install @livekit/rtc-node@0.13.34" error. Judgment call — it's the only finding here that's mine rather than a reviewer's.

## Low

- One malformed provider `context_id` (e.g. `null`) kills a paid WS session instead of falling back to the default writer (`src/ws/audio-writer.ts:103`).
- Binary WS frames emit no duplex event on stderr; file lands on disk silently (`src/ws/session.ts:217`).
- `{"type":"close"}` in a `--send` seed is ignored under `--duplex` (`session.ts:434`, `:455`).
- Duplex input error swallowed when the remote closes concurrently: exit 0 with success envelope (`session.ts:517`).
- Agent WS audio always written as `.mp3` regardless of the agent's real encoding; `ws-mock.test.ts:262` locks the mislabel in (`audio-writer.ts:77`).
- RTC `rtc_cleanup_incomplete` is the only terminal path with no manifest (`session.ts:335-347`).
- RTC `RTC_WORKER_EXIT_GRACE_MS` derivation counts four stages; the code runs five, one unbounded (`types.ts:4-7`).
- `validateInput` builds AJV unconditionally (~21 ms) before the `params.length === 0` early return (`src/core/client.ts:477`).
- Page-size clamp is silent: `--limit 500` against a max-100 param silently returns 100 (`src/core/pagination.ts:57`).
- `OutTargetError` inside the multipart path is rewrapped as `provider_error` (`multipart-response.ts:113`); currently unreachable thanks to preflight.
- Headerless multipart parts and bare-LF bodies rejected; defensible strictness, undocumented and untested (`multipart-response.ts:197`, `:351`).
- `.sensitive.bin` marker doubled on caller-named `-sensitive.bin` targets (`response-normalizer.ts:122`).
- Speech Engine readiness file never removed; a supervisor restarting with a stable `--ready-file` gets exit 2 (`speech-engine.ts:159`).
- Speech Engine burst coalescing drops intermediate transcripts entirely (test shows ids 3–19 never run); docs say "interrupt", not "drop" (`session.ts:217-222`).
- Speech Engine spec allows `request_headers` (including workspace-secret references) that `serve` cannot host; it verifies only the JWT header. The wire protocol itself is SDK-derived and absent from the pinned spec; `docs/api-coverage.md` discloses this correctly.
- `elv capabilities` reports the local snapshot path and cache-compile time as spec provenance while `spec status` reports the real URL and fetch time (`capabilities.ts:301`). Pre-existing.
- `ops schema upload_asset --example` puts the binary `asset` field in `--json` instead of `--file asset=…`. Pre-existing for multipart ops, newly prominent.
- `config doctor --online` uses `redirect: "error"` on the unauthenticated root probe, which manufactures false negatives behind any proxy that 3xx-redirects; refusing redirects matters on the credit check (which carries the key), not here.

## Delete / simplify (~250 lines)

| Lines | Where | Change |
|---|---|---|
| ~74 + 6 tests | `src/rtc/logs.ts` | `RtcLogCollector` is inert: `workerEnvironment()` forces `NODE_ENV=production`, which silences the `lk-rtc` logger entirely. Three real failing runs: `diagnostics_present=false`. Only evidence it works is a mock that writes to the stream itself. Either drop the forced `NODE_ENV` (worker already contains the stdout noise) or shrink the collector to native-crash scope and say so. |
| ~40 | `src/rtc/session.ts:406-475` | `readRtcActions`/`nextChunk` re-attach four listeners per chunk. Single attach + bounded queue is ~30 lines and fixes blocker 3. Not a straight `readline` swap: the 1 MiB unterminated-line cap must survive. |
| ~30 | `src/commands/ws.ts:300`, `:383`, `:415`, `:425` | Protocol-string branching that belongs in the catalog as data: `tokenParam`, `costModel`, `rejectsV3` on `WsCatalogFields`. Adding a protocol becomes one row, not four edits. |
| ~25 | `src/commands/ws.ts:407-463` | `wsPreflight` returns nine fields for one decision; five overlapping budget views. One discriminated `{policy, estimate, decision}`. |
| ~25 | `src/core/files.ts:288-337` | `reusablePublishedFile` stat-stability dance (dev/ino/size/mtime/ctime before and after read) guards against a foreign in-place rewrite that no `elv` process performs. Content hash already answers the question. Also `:270-271` `if (!contentHash) throw` is dead. |
| ~30 | `src/commands/aliases/agents.ts:44-145` | 11 exported builders nothing imports; five differ only by operation id and body-presence. One factory. The 5-tuple `actions` table at `:608` encodes scope positionally; use objects. |
| ~10 + perf | `src/ws/session.ts:473-483` | Every duplex line is `JSON.parse`d twice (once for the error-code distinction, once for real). Hot path, 1 MiB lines. |
| — | `src/core/multipart-response.ts:248` | `Buffer.alloc(2 MiB)` per non-audio part, up to 16 parts, for a few hundred bytes of JSON. Chunk list + `Buffer.concat`. |
| ~15 | `src/speech-engine/*` | Triple API-key check (server's throw is unreachable from the CLI), duplicated argv-shape validation, `validateServerOptions` called twice. |
| ~10 | `src/rtc/session.ts:65-73` | `inside()` hardens the parent against path escape by its own forked worker. |
| ~10 | `src/commands/rtc.ts:79-97` | `boundedFile` O_NONBLOCK read loop where `ws.ts:561` uses `readFileSync`. Also: `--send` capped at 4 MiB here and 16 MiB in `actions.ts:107`; the 4 wins silently. |
| ~5 + 6 tests | `src/ws/audio-writer.ts:47-50` | `AudioWriter.close()` has no production caller since both sites moved to `closeAll()`; six test assertions exist only to exercise it. |
| ~5 | misc | `createInactivityTimer` one-line wrapper used once; `resolveTargetForInput` exists only to rethrow; `?? input.query.output_format` at `ws.ts:167` unreachable; `worker.ts:44` queue-bound throw unreachable; `worker.ts:294` hardcodes `64 * 1024 * 1024` instead of `MAX_RTC_FILE_BYTES`; `config doctor --offline` flag exists only to conflict with `--online`. |

Judged and kept: the RTC worker process (justified — the LiveKit SDK writes JSON log lines to stdout, which would break the one-envelope contract in-process; verified end-to-end against a dead port: one stdout line, exit 8, manifest preserved). The custom multipart parser (busboy et al. don't do partial-recovery-to-disk). The `link()`-based publication design (only the missing fallback is wrong). The Speech Engine `sockets` set, canonical base64url check, `cleanupFailed` threading, and the two-turn cap.

## Test gaps worth closing

- **Native RTC suite never runs in the gate** (`tests/rtc/native.test.ts:11-12`). The six skipped tests are the ones that prove PCM transport, data packets, auto-pong, audio cap, timeout, and process-group abort — the subsystem's reason to exist. They are well-built (re-hash every file, Goertzel amplitude comparison). Run them against a local LiveKit dev server in CI, or document that the gate proves nothing about transport.
- No test with a slow/blocked stderr consumer (blocker 1) or `--token-env` against a raw absolute target (blocker 2). No handler that declines to drain stdin (blocker 6). No non-loopback bind test. No concurrent multi-session Speech Engine test despite shared mutable `stats`.
- `tests/openapi/docs-coverage-counts.test.ts:19-23` only requires the digits 388/387 to appear somewhere in five files; checks neither paths, schemas, nor the pinned SHA.
- `ALIAS_FAMILIES` (81 hand-maintained ids in `capabilities.ts`) is never asserted against the registry. All 81 currently resolve; one assertion closes it permanently.
- `tests/rtc/supervisor-faults.test.ts:213-241` sleeps 6.5 s real time because `RTC_SUPERVISOR_GRACE_MS` has no injection point: 75% of the RTC suite's wall clock.
- `tests/commands/config-doctor.test.ts` doesn't use the `rejectPortProbe` helper its sibling added for exactly this environment's stray Go-http-client probes.
- Nothing in the pinned spec grounds any WebSocket wire rule (zero `stream-input`, `text-to-dialogue`, or `convai/conversation` WS paths). The 110 green WS tests prove client-internal consistency against a mock the same change set wrote, not provider conformance. Not a defect of this change; a bound on what green means.
- Smoke matrix skips `flows video`, `flows speech`, and any flows exit-2 row.

## Docs drift

- AGENTS.md and `skills/elv/references/agents-workspace-ws.md` say Speech Engine "hosts on loopback"; code accepts `0.0.0.0`.
- AGENTS.md doesn't mention the hard-link filesystem requirement README added.
- Duplex is invisible to the machine surface: `elv ws --list` has no duplex field and `elv capabilities` never mentions `--duplex`. Only README/AGENTS.md/skill know.
- All eleven `inputError()` sites in `ws.ts` return envelopes with no `hints[]`, unlike `ops.ts`, `spec.ts`, `view.ts`.
- `--yes` overrides unbounded cost on raw WS sessions but not on named STT/convai/duplex (fail-closed at exit 5 before the `--yes` gate). Documented, defensible, but an agent that learns the escape on one path will retry it fruitlessly on the other.

## Verified and clean

External-ref rejection resisted all eight bypass shapes tried (file:, https:, scheme-less relative, bare relative, absolute POSIX, ref-to-ref, buried in components, percent-encoded scheme); the repo test stands up a real loopback server and asserts zero requests. All 24 new operations correctly classified; both DELETEs gated at exit 4; all three Flows generation ops fail closed under a ceiling at exit 5 before network; 0 pre-existing operations reclassified. Parameter pre-validation accepts `$ref` enums, nullable `anyOf`, repeated-flag arrays, and sentinel values; rejects bounds violations pre-network. Documented counts (388/387/300/1507, SHA `587ca2ac…`) hold. JWT verifier: timing-safe, canonical base64url, HS256 pinned, no `alg: none`. Duplicate-header smuggling closed. API key never reaches handler env, envelope, stderr, or readiness file. RTC token never in argv or envelope; redaction layers exact-token matching (raw/JSON-escaped/percent-encoded) on shared machinery and tolerates lone surrogates. `stt --wait` cannot loop forever. Duplicate scalar query rejection does not break legitimate arrays. Sensitive spills are 0600 under hostile umask; `view` refuses on filename before parsing. No reviewer found a test in their slice that would pass with its assertion removed, except the docs-count substring test.

## Recommended order

1. Blockers 1–6. Each is a small, localized fix with a clear red-to-green test (slow stderr consumer; raw-host `--token-env`; stdin error while suspended; publication on a `link()`-refusing mock; CloudFront-signed `preview_url`; non-draining handler at 300 KB).
2. RTC exit-code inversion, disconnect-as-success, `rtc` envelope field, env passthrough. These are all in two files and share one test file.
3. `flows --wait` timeout plumbing + hint; duplex close-after-terminal; Speech Engine bind gate + stderr flag.
4. The delete/simplify table, in one behavior-preserving pass gated by the existing suite.
5. Native RTC suite in CI; the four test gaps tied to blockers.

Not recommended: any redesign. The subsystem boundaries are right.
