# Round 4 read-only review: agent ergonomics and compatibility

Review the current workspace after Rounds 1-3. Do not edit files. Assess the
CLI as a non-interactive agent interface: first-try discovery, one-envelope
output, exit codes, bounded payloads, actionable errors/hints, dry-run parity,
deprecations, old aliases/configs, profile precedence, deterministic sorting,
and documentation/command accuracy.

Inspect `a9de3c2..HEAD`, the reviewed plan, current docs, and tests. Run bounded
read-only CLI probes when they clarify behavior. Look for newly added commands
that are impossible to invoke, schema/body mismatches, parent/help dead ends,
unbounded capabilities/list output, or compatibility regressions.

Do not install dependencies or create an out-of-tree copy. The reviewed source
tree already has its dependencies; otherwise prefer static inspection and the
existing tests over environment setup.

Return only verified findings ordered by severity, with exact evidence,
reproduction, and the smallest correct fix. List material suspicions you
disproved. End with approve, approve with fixes, or reject.
