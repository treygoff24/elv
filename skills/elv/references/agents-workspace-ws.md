# Agents, workspace, Dubbing Project, and WebSockets

Read this reference for conversational-agent resources, administrative changes,
transcript edits, or realtime sessions. These branches have stronger side-effect
and credential boundaries than ordinary reads.

## Conversational agents

```bash
elv agents list --fields agent_id,name
elv agents rag-query --agent-id AGENT_ID --query "refund policy"
elv agents tests create --json-file test.json --dry-run
elv agents tests run --agent-id AGENT_ID --json-file run.json --dry-run
elv agents procedures list --agent-id AGENT_ID --branch-id BRANCH_ID
```

Use `agents tests create` followed by `agents tests run`; `agents simulate` maps
to a provider-deprecated operation. Discover Procedure create/update/compile and
branch-management inputs through the nested help and dry-run every mutation.

Outbound calls or messages require `--yes` after the recipient and payload are
confirmed. Agent and Procedure deletions inherit the same confirmation gate.

## Workspace administration

```bash
elv workspace members list
elv workspace service-accounts list
elv workspace service-accounts create --name deployer --dry-run
```

Member, API-key, service-account, credential, sharing, and integration changes
are administrative side effects. Preview first and add `--yes` only after the
workspace and principal are confirmed. Credential-producing responses are
written to sensitive mode-`0600` files; record the path without rendering or
copying the value into context.

## Dubbing Project transcripts

```bash
elv dubbing-project transcript get --project-id PROJECT_ID
elv dubbing-project transcript update-segments \
  --project-id PROJECT_ID --json-file segments.json --dry-run
```

Use the source/target transcript subcommands shown by
`elv dubbing-project --help`. Bulk segment updates are atomic provider requests:
validate the entire JSON file before executing. Target regeneration is treated
as generation; with a credit ceiling, an unbounded estimate fails before the
network call.

## WebSocket sessions

List the installed protocol catalog and inspect the selected command:

```bash
elv ws --list
elv ws tts-realtime --help
```

Common catalog names include `tts-realtime`, `tts-multi`, `stt-realtime`,
`convai`, and `convai-monitor`. The installed list is authoritative.

Scripted examples:

```bash
elv ws tts-realtime --query voice_id=VOICE_ID \
  --send script.ndjson --out ./session --dry-run
elv ws stt-realtime --query entity_detection=true \
  --send transcribe.ndjson --out ./session --dry-run
elv ws convai-monitor --query conversation_id=ID --out ./monitor --dry-run
```

Named protocols validate their script actions and query rules. Realtime STT can
use `send_binary_file` actions. A raw URL is forward-compatible but does not gain
catalog metadata, so inspect it as an unknown-cost external session.

Receive-only monitoring does not require confirmation. Any outbound agent or
monitor action requires `--yes`; preview the session first. With a configured
credit ceiling, supported TTS, STT, and agent sessions fail closed when cost
cannot be bounded.

Speech Engine is not an outbound client target: ElevenLabs connects to the
server you host.
