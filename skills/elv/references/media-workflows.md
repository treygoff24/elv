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

The public API contract does not include ElevenCreative's UI-only editors,
Image & Video, Avatars, Ads, or Flows. Keep private endpoints out of the plan.
