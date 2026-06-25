# Security policy

## Supported versions

The supported release line is `0.1.x`. Security fixes are published on that line until a newer supported line is announced.

## Reporting a vulnerability

Please report suspected vulnerabilities privately by emailing trey@newayfunds.com. Do not open a public GitHub issue for a vulnerability.

Include the affected version, the command or feature involved, a short reproduction if you can share one safely, and the impact you believe is possible. You should receive an initial response within 72 hours.

## API key handling

`elv` reads the ElevenLabs API key from the `ELEVENLABS_API_KEY` environment variable. It sends that value only as the `xi-api-key` request header.

`elv` must never print the API key to stdout, logs, `--dry-run` previews, WebSocket session files, or test snapshots. Users must NEVER pass the key as a CLI argument and must NEVER commit it.

Dry-run and WebSocket output redact key-named fields and query parameters. If you find a path that exposes a key, treat it as a vulnerability and report it privately.
