# Media workflows

Read this reference for speech, transcription, music, sound effects, voice, and
dubbing work. Run the chosen alias's `--help` before composing uncommon options.

## Generation pattern

Generation is a two-pass operation:

1. Dry-run with the intended input, output target, model, and credit ceiling.
2. Confirm the preview, then run without `--dry-run`.

Use placeholders instead of real secrets in previews. Save outputs explicitly
when a later step depends on their path.

## Text to speech

```bash
elv voices list --fields voice_id,name
elv tts --voice-id VOICE_ID --text "Hello" \
  --model eleven_flash_v2_5 --max-credits 100 --out speech.mp3 --dry-run
elv tts --voice-id VOICE_ID --text "Hello" \
  --model eleven_flash_v2_5 --max-credits 100 --out speech.mp3
```

`--voice "Name"` resolves an exact name or unique substring. `--timestamps`
writes audio plus a timestamp sidecar. For long text, use a file input shown by
`elv tts --help` rather than placing the entire script in the shell command.

## Speech to text

```bash
elv stt --file note.m4a --model scribe_v2
elv stt --file note.m4a --model scribe_v2 \
  --webhook --webhook-id WEBHOOK_ID
SCRIBE_TOKEN=... elv stt --file note.m4a --model scribe_v2 \
  --token-env SCRIBE_TOKEN
```

`--webhook` is a boolean provider field; it is not a callback URL. Supply a
configured webhook ID when required. A single-use token belongs in the named
environment variable, not in an argument.

`--timestamps` accepts `none`, `word`, or `character`, not `segment`.
Rebuild speaker turns from `words[].speaker_id` when needed. Plain STT calls
return the completed transcript synchronously. In 0.4.0, `--wait` preserves that
success and polls only an asynchronous transcription ID; `--wait --dry-run`
returns the preview without polling. Version 0.3.0 could return a complete file
then fail with a missing-ID error, so inspect existing files before retrying.
A September 5, 2026 run transcribed a 47-minute, 47 MB m4a in about two minutes;
that is one observed duration, not a latency guarantee.

## Sound effects and music

```bash
elv sfx --prompt "distant thunder" --duration 5 \
  --max-credits 100 --out thunder.mp3 --dry-run
elv music --prompt "warm jazz trio" --model music_v2 \
  --length-ms 30000 --max-credits 1000 --out track.mp3 --dry-run
elv music detailed-stream --prompt "warm jazz trio" --model music_v2 \
  --out ./music-session --dry-run
```

`music detailed-stream` writes audio and metadata NDJSON separately. Discover
Music Finetune commands with `elv music finetunes`; generation accepts
`--finetune-id` when the installed help exposes it.

`elv call compose_detailed` returns separate audio and JSON metadata files from
a multipart response. Pass a directory to `--out` and inspect every returned
path. An interrupted response may still retain usable partial artifacts.

## Voice workflows

```bash
elv voices list --search narration --fields voice_id,name
elv voices find "Rachel"
elv voices get VOICE_ID
elv voice-change --voice-id VOICE_ID --file in.mp3 --out out.mp3 --dry-run
elv voice-isolate --file noisy.mp3 --out clean.mp3 --dry-run
elv voices clone-instant --name "My Voice" --file sample.mp3 --dry-run
elv voices accents --language en
elv voices replicate --voice-id VOICE_ID \
  --target-workspace-id WORKSPACE_ID --dry-run
```

Cross-residency replication is an external side effect and requires deliberate
confirmation after preview. Voice creation and mutation may also require
confirmation; follow exit 4 rather than adding `--yes` preemptively.

## Dubbing

```bash
elv dubbing create --file in.mp4 --source en --target es --wait --dry-run
elv dubbing audio --id DUB_ID --language es --out dubbed.mp3
elv dubbing list --limit 20
```

For transcript inspection or editing, use the Dubbing Project reference in
[`agents-workspace-ws.md`](agents-workspace-ws.md).

## Model discipline

`elv models list` reports models visible to the current account; it is not an
exhaustive cross-product catalog. Prefer current installed help and provider
responses over a memorized model list. For new examples, start with `scribe_v2`
for STT and a current Flash model for low-latency TTS, then honor the user's
quality, language, latency, and availability requirements.

## Flows and Assets

`flows image|video|speech create --json-file request.json --dry-run` previews
model-specific generation input. Remove `--dry-run` to execute; add `--wait`
to poll to completion (`--timeout-ms`, default 600000, and `--interval-ms` bound
the poll; a `wait_timeout` exits 7 with a hint naming the `get` re-poll). Discover the body with `ops schema
create_image_generation --example` (or the video/text-to-speech operation).
`assets upload --file reference.png` creates reusable input media.

Generation costs are model-specific and cannot currently be bounded; a
configured credit ceiling blocks Flows creation even with `--yes`.
Signed `content_url` values are written to private sensitive response files.
IDs, status, and cursors remain inline with URLs redacted. Read the private
artifact only when a downstream download needs the URL; do not echo it.

Image & Video, speech generation, and Assets have public APIs. Other private
editor endpoints are not part of the contract.
