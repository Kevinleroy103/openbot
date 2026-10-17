# Fixtures

- `opencode-basic.jsonl` is a copy of `packages/contracts/test/fixtures/opencode-basic.jsonl`
  (recorded at zero model cost against a scripted fake model, `opencode serve` + `@opencode/client`
  events; one `{seq, t, source, payload}` frame per line). Scenarios: text, reasoning, auto-allowed
  read, shell permission, write reject, question form, MCP tool, interrupt.
- `opencode-server-live.jsonl` is a copy of the research recording
  `vendor/scratch/opencode-server/out/events.jsonl` (the user's CLI 2.0.6 in `serve --stdio` mode,
  a real free model, one turn calling a plugin tool `openbot_ping`), with the local workspace path
  replaced by `/workspace/`. One raw SSE event per line.
