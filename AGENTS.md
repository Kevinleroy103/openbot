# Working in OpenBot

OpenBot is an open-source, self-hosted, harness-agnostic Grok Bot. The **brain** (`apps/server`) runs orchestration, harness agent loops, persistence, the MCP gateway and the web UI. **Nodes** (`apps/node`, plus an in-process local node) execute tools.

Read first: `docs/decisions.md` (binding), `docs/architecture.md`, `docs/plan.md`. Research with evidence lives in `docs/research/`.

## Rules

- **Bun 1.4.2** for everything: `bun install`, `bun test`, `bun run`, `bunx tsc`. Workspaces use Bun's isolated linker, so a package can only import its **declared** dependencies.
- **Effect 4.0.4 only** (pinned via the root `catalog:` and `overrides`).
  - Use `Context.Service`, `Layer`, `Schema.TaggedError<Self>()(tag, fields)` (there is no `TaggedErrorClass` in 4.0.4), `Effect.fn`, and scoped resources (`Effect.acquireRelease`, `Layer.effect` with a scope).
  - The API reference is `vendor/effect-4.0.4` and the installed d.ts. `vendor/effect` is rc.117; do not trust it.
  - See "Common mistakes" in `docs/research/effect4-core.md`.
- **Dependency direction:** `contracts`/`node-protocol` → `core` → adapters and infrastructure → `apps/*`.
  - `core` never imports an SDK, SQL, React, `Bun.*` or `node:*`.
  - SDK types never leave their adapter package.
- **Never import from `vendor/`.** It is gitignored research material. Port code instead, keeping an MIT attribution header when the source is t3code.
- **Persist early.** Write files as you go. Long sessions can be interrupted.
- **Don't touch root manifests** (`package.json`, `bun.lock`, `turbo.json`) or run `bun add`/`bun install` during parallel work waves. Record missing dependencies instead.
- **Capabilities are honest.**
  - Never fake approvals, permission modes or remote placements a harness can't enforce.
  - Never silently enable bypass permissions.
  - Never forward claude.ai or ChatGPT credentials.
- **MCP tools** return `content` (text plus optional images) and **never `structuredContent`**. Error text starts with `ERROR:`. Results stay under about 10 KB. Schemas have no tuples. MCP tokens never go on argv.
- **Tests.** `bun test` runs against fakes and recorded fixtures. Live harness tests are gated by `OPENBOT_LIVE_CLAUDE`, `OPENBOT_LIVE_CODEX` and `OPENBOT_LIVE_OPENCODE`, and must stay trivially cheap.
- **Per-package checks:** `bunx tsc --noEmit -p packages/<name>` and `bun test packages/<name>`. The root `bunfig.toml` ignores `vendor/`; never run a bare `bun test` that crawls `vendor/`.
- **Don't commit** unless the user asks.
