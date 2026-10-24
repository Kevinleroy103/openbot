# Recorded harness fixtures

Copied from `vendor/scratch/contracts/fixtures` (domain-contract.md §F.5). Recorded at zero model cost
against scripted fake model servers; one JSON frame per line: `{seq, t, source, payload}`.

| File                   | Harness                                                                              | Frames | Scenarios                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------- |
| `claude-basic.jsonl`   | Claude Agent SDK `query()` (streaming input, `includePartialMessages`, `canUseTool`) | 113    | text, thinking, Bash approval allow, Write deny, AskUserQuestion, interrupt, turn after interrupt                       |
| `codex-basic.jsonl`    | `codex app-server` v2 JSON-RPC                                                       | 140    | text, reasoning summary, command approval accept/decline, MCP tools + elicitation approval, interrupt, requestUserInput |
| `opencode-basic.jsonl` | `opencode serve` + `@opencode/client` events                                         | 157    | text, reasoning, auto-allowed read, shell permission, write reject, question form, MCP tool, interrupt                  |

`source` values: `openbot.control` (what OpenBot sent: `send`, `interrupt`, request answers) and the
native stream (`claude.sdk.message`, `claude.canUseTool`, `claude.canUseTool.response`, `codex.rpc.in`, `codex.rpc.out`, `opencode.event`).

`*.ledger.txt` pin how every native event was handled by the test reducers
(`test/support/reduce/*`): `mapped`, `state`, `elsewhere` or `no-home`. Regenerate with
`OPENBOT_UPDATE_LEDGERS=1 bun test packages/contracts` and review the diff.

Harness adapter packages reuse these files for their normalizer tests (read them from
`packages/contracts/test/fixtures/`). The reducers under `test/support/reduce` are test helpers
only; adapters own the real normalizers (native -> `HarnessEvent`).
