# elv agent usage

Use `elv ops search <query>` to find operations.
Use `elv ops schema <id> --example` before unfamiliar calls.
Use `elv call <id> --json …` for complete API coverage; aliases (`tts`, `stt`, `music`, `agents`, …) for common work.
Every command returns exactly one JSON object to stdout. Branch on exit code: 0 ok; 2 input; 3 auth;
4 needs --yes; 5 budget cap hit (raise --max-credits); 6 out of credits (top up); 7 retryable; 8 provider; 9 not-found.
Generated audio/video/zip/binary is saved to disk and returned in `files[]`.
Never pass API keys as args. Set `ELEVENLABS_API_KEY`.
For DELETE, outbound calls/messages, API-key mutation, and member changes, add `--yes`.
Cap spend with `--max-credits N` (or `ELV_MAX_CREDITS`); check balance with `elv usage`.
Do NOT --dry-run secret-create ops with real secret values (body is echoed).
