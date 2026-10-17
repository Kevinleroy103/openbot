# harness-claude fixtures

- `claude-live-messages.jsonl`, `claude-live-subagent.jsonl`: live SDK 0.3.300 / CLI 2.1.300 recordings
  copied from `vendor/scratch/claude/out/{messages,subagent}.jsonl` (sdk-claude.md §19), with home paths
  replaced by `<HOME>`. `messages` lines are `{t, phase, m}` (phases `turn1..3`, `canUseTool`,
  `interrupt-response`, `tail`); `subagent` lines are raw SDK frames.
- The scripted, zero-cost recording `claude-basic.jsonl` is read in place from
  `packages/contracts/test/fixtures/` (see that README).
