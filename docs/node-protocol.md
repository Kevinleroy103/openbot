# OpenBot node protocol (v1)

How a **node** (the "hands": `apps/node`, or any program in any language) talks to the **brain** (`apps/server`). The TypeScript source of truth is `packages/node-protocol` (`@openbot/node-protocol`); this document is the language-neutral description, so a node can be written without Effect.

`PROTOCOL_VERSION = 1`. Decisions: D1.2, D1.3, D1.7 in `docs/decisions.md`; research: `docs/research/hands-architecture-synthesis.md` §S.4–S.7.

---

## 1. Overview

```
node ──(1) POST /node/pair {code, publicKey, …}─────────────────────────▶ brain   once
node ──(2) WebSocket /node  Authorization: OpenBot-Node v1 …───────────▶ brain   control socket (dialed OUT by the node)
         ◀── node.hello {brainSig} ── (brain = RpcClient NodeRpcs, node = RpcServer)
         ── node.requestApproval / node.openStream / node.event ──▶ (node = RpcClient BrainRpcs, brain = RpcServer)
node ──(3) WebSocket /node/stream/:id  Authorization: Bearer <token>────▶ brain   one per data stream (pty, tunnel, screencast, …)
```

- One **control socket** per node, always dialed by the node (NAT-friendly). It carries two RPC groups in opposite directions, multiplexed by message direction (§4).
- **Data streams** (bytes) never ride the control socket. Each one is a separate WebSocket the node dials, authenticated with a one-time token (§7).
- The brain machine runs the same handlers in-process as the **local node**; it does not use this wire.

## 2. Identity and pairing

1. The owner clicks **Add computer** in the UI. The brain mints a **pairing code**: 8 characters from the Crockford base32 alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, displayed `ABCD-EFGH`, single use, valid 10 minutes, stored as `sha256("openbot-pairing-v1|" + code)`. Input is normalized: upper-case, spaces and dashes removed, `I`/`L` → `1`, `O` → `0`.
2. The node generates an **Ed25519** key pair (WebCrypto). The private key never leaves the node; it is stored as base64url PKCS#8 with mode 0600.
3. `POST /node/pair` with JSON:

   ```json
   {"code":"ABCD-EFGH","publicKey":"<base64url raw 32-byte key>","hostname":"box","platform":"linux","arch":"x64","nodeVersion":"0.1.0","protocol":{"min":1,"max":1}}
   ```

   `arch`, `nodeVersion` and `protocol` are optional. Response:

   ```json
   {"nodeId":"nod_01J…","brainPublicKey":"<base64url raw 32-byte key>","brainOrigin":"https://brain.example"}
   ```

   The node **pins** `brainPublicKey` and stores `nodeId` and `brainOrigin`. Static bearer tokens are not used.

All binary values in the protocol (keys, signatures, nonces, tokens) are **base64url without padding** (RFC 4648 §5).

## 3. Control socket: signed upgrade and `node.hello`

### 3.1 Upgrade

The node opens `wss://<brain>/node` with:

```
Authorization: OpenBot-Node v1 id=<nodeId>,ts=<unix ms>,nonce=<base64url 16 random bytes>,sig=<base64url signature>
x-openbot-protocol: 1-1            (informational)
```

`sig` is Ed25519 over the UTF-8 string

```
openbot-node-v1|<nodeId>|<ts>|<nonce>|<brainOrigin>
```

`brainOrigin` is the origin from pairing (`scheme://host[:port]`, `ws`→`http`, `wss`→`https`). Every value in the header must match `[A-Za-z0-9_-]+` (and `ts` is decimal digits).

The brain checks, in order: header shape → the node is paired and not revoked → `|now − ts| ≤ 60 s` → the nonce was not used in the last 2 min → the signature. On failure it answers `401` without upgrading. The nonce is remembered only after the signature verifies.

### 3.2 `node.hello` (mutual authentication)

The first RPC on every connection is the brain calling `node.hello`:

```json
{"jsonrpc":"2.0","id":0,"method":"node.hello","params":{"protocol":{"min":1,"max":1},"brainVersion":"0.1.0","brainSig":"<base64url>"}}
```

`brainSig` is the brain's Ed25519 signature over

```
openbot-brain-v1|<nodeId>|<nonce from this connection's upgrade>|<brainOrigin>
```

The node verifies it with the **pinned** brain key. Until it has done so, the node answers **every other request** with the typed error `NotAuthenticated`. If verification fails, `node.hello` fails with `NotAuthenticated` and the node closes the socket. A DNS or proxy hijack therefore cannot drive a node.

The success value is `NodeHello`:

```json
{"nodeId":"nod_…","version":"0.1.0","hostname":"box","platform":"linux","arch":"x64","protocol":1,
 "roots":[{"id":"work","path":"/home/u/openbot","mode":"rw"}],
 "capabilities":["fs@1","shell@1","pty@1","browser@1"],"tunnels":["codex.exec-server"],
 "policy":{"ceiling":"ask","remoteManaged":false},"brainVerified":true,
 "desktop":{"missing":[],"width":1920,"height":1200}}
```

`protocol` is the highest version in both ranges. `desktop` (absent on older nodes) describes per-bot desktops: `missing` names the required programs the node lacks (`Xvfb`, `x11vnc`, `xdotool`, `xfwm4 or openbox`, `ImageMagick (import)`). Whether desktops are offered is the `desktop@1` capability: `missing` is empty when they are, and also when the owner turned them off on the node (config `desktop.enabled: false`, `--no-desktop`, or a `computer: never` ceiling). Close codes used on the control socket:

| Code | Meaning |
|---|---|
| `4401` | node revoked or unknown key. Do not redial until re-paired. |
| `4403` | `node.hello` failed |
| `4426` | no common protocol version |
| `4000` | brain asked the node to reconnect (a newer connection replaced this one) |

### 3.3 Liveness and redial

- Both sides' clients send `@effect/rpc/Ping`; answer with `@effect/rpc/Pong`. Any decoded frame counts as liveness. The brain's client ping timeout is 15 s (the node's 5 s); independently, each side closes the control socket after 20 s without any frame (half-open detection: the brain marks the node offline, the node redials).
- The node redials with exponential backoff from 250 ms to 30 s with ±50 % jitter, resetting only after a connection stayed up 10 s.
- RPC streams do not survive a disconnect: in-flight calls fail, and the node interrupts in-flight handlers (killing their process groups).

## 4. Wire format (JSON-RPC 2.0, Effect RPC dialect)

Serialization is Effect's `RpcSerialization.jsonRpc()`. These rules were verified against a hand-written peer (`packages/node-protocol/test/mux.test.ts`, "foreign peer").

1. **One JSON-RPC message per WebSocket text frame.** A JSON array is a batch.
2. **Direction.** A frame with a `method` is for **your server**, except `@effect/rpc/Pong`. A frame without `method` (`result`, `error`, `chunk`) is for **your client**. Request ids of the two directions are independent; a response always belongs to the side that sent the request.
3. **Requests.**

   ```json
   {"jsonrpc":"2.0","id":2,"method":"shell.exec","params":{…},"headers":[["k","v"]],"traceId":"…","spanId":"…","sampled":true}
   ```

   `headers`, `traceId`, `spanId` and `sampled` are optional. `id` is a number or a string.
4. **Results.** Success: `{"jsonrpc":"2.0","id":2,"result":<value>}`. RPCs without a success schema return `null`.
5. **Typed errors.**

   ```json
   {"jsonrpc":"2.0","id":1,"error":{"_tag":"Cause","code":0,"message":"…",
     "data":[{"_tag":"Fail","error":{"_tag":"PathDenied","path":"/etc/x","reason":"outside roots"}}]}}
   ```

   `data` is the flat list of cause reasons: `Fail` (typed error), `Die` (defect), `Interrupt`.
6. **Streams** (`stream: true` RPCs, e.g. `shell.exec`).
   - Each chunk: `{"jsonrpc":"2.0","chunk":true,"id":2,"result":[<value>, …]}`.
   - The end: a normal result (`result: null`) or error frame with the same `id`.
   - **After every chunk the receiver must send** `{"jsonrpc":"2.0","method":"@effect/rpc/Ack","params":{"requestId":2}}`. An Effect server waits for the Ack before sending the next chunk.
   - **`requestId` must have the same JSON type as the request `id`** (number vs string). A mismatched Ack silently stalls the stream.
7. **Interrupt.** `{"jsonrpc":"2.0","method":"@effect/rpc/Interrupt","params":{"requestId":2}}` cancels a call. The server answers with an error frame whose `data` contains `{"_tag":"Interrupt",…}` reasons; the node kills the work (process group) in its finalizer.
8. **Payload-less RPCs:** omit `params` or send `null`. `{}` fails with `Expected null`.
9. **Pings:** answer `@effect/rpc/Ping` with `{"jsonrpc":"2.0","method":"@effect/rpc/Pong"}`.
10. **Headers** are `[[name, value], …]`. Every request a node sends gets `x-openbot-node-id` **stamped by the brain**; anything the node itself sends under `x-openbot-*` is removed. Brain handlers never trust a node id from a payload.

## 5. RPCs

Every **bot-originated, side-effecting** call carries `inv: {invocationId, botId, runId, toolCallId?}` for node policy, idempotency and the audit log. UI-originated browser calls carry `botId` only; the brain authorizes those.

### 5.1 `NodeRpcs` (served by the node)

| RPC | Payload | Success | Errors |
|---|---|---|---|
| `node.hello` | `{protocol:{min,max}, brainVersion, brainSig}` | `NodeHello` | `NotAuthenticated` |
| `fs.read` | `{inv, path, offset?, limit?, encoding?: utf8\|base64}` | `{content, encoding, sha256, size, truncated}` | `PathDenied`, `PolicyRefused`, `FsError`, `NotAuthenticated` |
| `fs.download` | `{inv, path, cwd?, maxBytes?, streamId, streamToken}` (a leading `~/` is the node's home; relative paths use `cwd`) | `{path, name, size, mtimeMs, head}` (`head` = first ≤ 4 KiB, base64), answered once the `transfer` stream is dialed; the bytes follow on it (§7) | `PathDenied`, `PolicyRefused` (`read-file` ceiling), `FsError` (`EISDIR`, `EFBIG` over `maxBytes` or the node's own cap, …), `TunnelFailed` |
| `fs.upload` | `{inv, path, size, streamId, streamToken}` (brain → node: files sent to a bot land in its workspace `inbox/`; parents are created) | `{path, sha256, size}`, answered once the node has received the bytes on the `transfer` stream (§7), verified them and renamed the file into place | `PathDenied`, `PolicyRefused` (`write-file` ceiling), `FsError` (`EFBIG` over the node's cap, `EISDIR`, …), `TunnelFailed` (damaged or cut transfer; nothing is left at `path`) |
| `fs.write` | `{inv, path, content, encoding?, expectedSha256?, createParents?}` (atomic; `expectedSha256: ""` = must not exist) | `{sha256, size}` | + `EditFailed` |
| `fs.edit` | `{inv, path, oldString, newString, replaceAll?, expectedSha256?}` (match must be unique unless `replaceAll`) | `{sha256, replacements}` | + `EditFailed` |
| `fs.stat` | `{inv, path}` | `FileStat` or `null` when missing | fs errors |
| `fs.list` | `{inv, path, depth?, includeHidden?, limit?}` | `{entries:[{path, type, size, mtimeMs}], truncated}` | fs errors |
| `fs.glob` | `{inv, pattern, cwd, limit?}` | `{paths, truncated}` | fs errors |
| `fs.grep` | `{inv, pattern, path, glob?, ignoreCase?, literal?, contextLines?, outputMode?: content\|files_with_matches\|count, limit?}` | `{matches:[{path,line,text}], files, counts:[{path,count}], truncated}` | fs errors |
| `fs.mkdir` / `fs.move` / `fs.remove` | `{inv, path, recursive?}` / `{inv, from, to, overwrite?}` / `{inv, path, recursive?}` | `null` | fs errors |
| `shell.exec` **(stream)** | `{inv, command, cwd, timeoutMs, env?, outputLimitBytes?}` | chunks of `Started{pid,pgid}` \| `Output{stream: stdout\|stderr, data, seq}` \| `Exit{code, signal, timedOut, durationMs, outputTruncated?, spillPath?}` | `PathDenied`, `PolicyRefused`, `NotAuthenticated` |
| `pty.open` | `{inv, cols, rows, cwd, shell?, env?, streamId, streamToken}` | `{pid}` | `PathDenied`, `PolicyRefused`, `TunnelFailed` |
| `tunnel.open` | `{inv, kind: claude.cli\|codex.exec-server\|codex.app-server\|tcp, args, env, cwd, port?, streamId, streamToken}` | `{pid \| null}` | `TunnelFailed`, `PathDenied`, `PolicyRefused` |
| `service.start` | `{inv, kind: "opencode.serve", env, cwd}` | `{serviceId, port, pid}` (node-loopback port) | `TunnelFailed`, … |
| `service.stop` | `{inv, serviceId}` | `null` | |
| `forward.listen` | `{inv, kind: mcp-http\|anthropic-api\|model-api, transport: tcp\|unix}` | `{port \| null, path \| null}` | `TunnelFailed` |
| `browser.ensure` | `{botId}` | `{windowTargetId, cdpPort?, width?, height?}` | `BrowserUnavailable`, `PolicyRefused` |
| `browser.action` | `{inv, action: BrowserAction}` | `{text, url?, title?, image?: {mimeType, data(base64), width, height}, tabs?}` | `BrowserUnavailable`, `BrowserActionFailed`, `LeaseHeld`, `PolicyRefused` |
| `browser.screencast` | `{botId, streamId, streamToken, options?: {format?, quality?, maxWidth?, maxHeight?, everyNthFrame?}}` | `{windowTargetId}` | `BrowserUnavailable`, `TunnelFailed` |
| `browser.input` | `{botId, event: BrowserInputEvent}` | `null` | `BrowserUnavailable`, `LeaseHeld` |
| `lease.set` | `{botId, holder: user\|bot}` | `{botId, holder, since}` | |
| `desktop.ensure` | `{botId}` | `{botId, display: ":101", width, height}` (starts the bot's desktop once; concurrent calls share the start; ~1 s) | `DesktopUnavailable` (`missing` when programs are absent; also when the node's `computer` ceiling is `never`) |
| `desktop.stop` | `{botId}` | `null` (closes the bot's browser gracefully, then kills everything on the screen; the next use starts a fresh one) | |
| `computer.act` | `{inv, action: ComputerAction}` (starts the desktop when needed) | `{text, image?: {mimeType, data(base64), width, height}}` | `LeaseHeld` (holder `user`), `PolicyRefused` (`computer` ceiling), `DesktopUnavailable` |
| `computer.stream` | `{botId, mode: view\|control, streamId, streamToken}` (starts the desktop when needed) | `null`, answered once the `vnc-view` / `vnc-control` stream is dialed | `LeaseHeld` (`control` while the holder is not `user`), `DesktopUnavailable`, `TunnelFailed` |
| `screen.ensure` | `{botId}` (`screen@1`: a Mac's own screen; asks macOS for the permissions the first time) | `{width, height}` (points) | `DesktopUnavailable` (`missing`: `Screen Recording`, `Accessibility`) |
| `screen.stream` | `{botId, streamId, streamToken}` | `null`, answered once the `screen` stream is dialed: screenshot frames framed like `cdp-screencast`, viewport = the 1280-wide API space | `DesktopUnavailable`, `TunnelFailed` |
| `screen.input` | `{botId, event: BrowserInputEvent}` (coordinates in the frame viewport) | `null` | `LeaseHeld` (holder not `user`), `DesktopUnavailable` |

Every RPC may also fail with `NotAuthenticated` (before `node.hello`).

**`BrowserAction`** (tagged by `_tag`; targets are a `ref` from the last `snapshot` or viewport CSS pixels `x`/`y`):
`navigate{url, tabId?}`, `snapshot{tabId?}`, `click{ref?|x?,y?, button?, clickCount?}`, `type{text, ref?, submit?, clear?}`, `key{key}` (e.g. `Enter`, `Control+a`), `scroll{direction: up|down|left|right, amount?, ref?|x?,y?}`, `screenshot{fullPage?, format?: jpeg|png|webp, quality?}`, `tabs{op: list|new|select|close, tabId?, url?}`.

**`BrowserInputEvent`** (user takeover; coordinates in the screencast's CSS viewport):
`mouse{type: move|down|up|wheel, x, y, button?, clickCount?, deltaX?, deltaY?, modifiers?}`, `key{type: down|up, key, code?, text?, modifiers?}`, `text{text}`; `modifiers = {alt?, ctrl?, meta?, shift?}`.

**Lease.** The brain's `ComputerService` owns the control lease and mirrors it with `lease.set`; the node keeps ONE lease per bot for its browser and its desktop. While `holder = "user"`, `browser.action` and `computer.act` fail with `LeaseHeld` (a long `type` stops between chunks), and `browser.input` and `computer.stream {mode: "control"}` are accepted; while `holder = "bot"` (the default), those two fail with `LeaseHeld`. When the lease returns to `bot`, the node closes every open `vnc-control` stream of that bot (1000); `vnc-view` streams stay.

**Desktops** (capability `desktop@1`, D1.7). Each bot that uses the node's computer gets its own virtual X display (Xvfb 1920×1200 on the first free display from `:100`, cookie auth, no TCP), a window manager (xfwm4, or openbox), a dock (plank) with the bot's browser, a terminal, a file manager and an editor, and two loopback x11vnc servers (control and `-viewonly`). On such a node the bot's Chromium (`browser.*`) runs on that display with the bot's own profile, so `browser` and `computer` act on the same windows.

**A Mac's own screen** (capability `screen@1`, macOS; never with `desktop@1`). The bots and the owner share the main display. `computer.act` works it through a helper child process (`openbot-node screen-helper`: CoreGraphics events via bun:ffi, JSON lines on stdin/stdout) and `screencapture` + `sips` screenshots. It answers `LeaseHeld` (with a reason for the bot) while the owner holds the lease for any bot, while someone used the Mac in the last 20 s (HID idle time, the helper's own events excluded), and while another bot acted in the last minute. `node.hello.screen = {missing, width, height}` lists the permissions still needed (Screen Recording, Accessibility for openbot-node).

**`ComputerAction`**: Anthropic's computer-use actions `{action, coordinate?, start_coordinate?, region?, text?, scroll_direction?, scroll_amount?, duration?}`, with `action` one of `screenshot`, `zoom`, `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, `hold_key`, `wait`, `cursor_position`.
- Coordinates are in the screenshot space: 1280 px wide, `apiH = round(1280 · H / W)` (1280×800 for 1920×1200). `zoom.region` is `[x0, y0, x1, y1]` in that space; the crop is taken at screen resolution and fitted into 1280×800.
- `text` is the typed text (`type`), an xdotool key or combination (`key`: `"Return"`, `"ctrl+l"`, several separated by spaces; `hold_key`), or modifier keys held during a click or scroll (`"shift"`, `"ctrl+shift"`). DOM / macOS names (`Enter`, `ArrowDown`, `cmd+c` → `ctrl+c`) are mapped.
- Every action except `cursor_position` returns a fresh screenshot (JPEG, 1280×800) after a short settle; `cursor_position` returns `X=…, Y=…` (screenshot space).
- Invalid arguments are not errors: the result's `text` starts with `ERROR:` (e.g. `ERROR: coordinate [x, y] is required`) and has no image.

### 5.2 `BrainRpcs` (served by the brain, called by the node)

| RPC | Payload | Success | Errors |
|---|---|---|---|
| `node.requestApproval` | `{invocationId, botId, action, target, reason}` | `{decision: allow-once\|allow-always\|deny, by}` | |
| `node.openStream` | `{kind: mcp-http\|anthropic-api\|model-api, botId}` | `{streamId, streamToken}` | `StreamRefused` |
| `node.event` | `{type, data}` | `null` | |
| `node.heartbeat` | `{at, activeInvocations, load?, freeMemBytes?}` | `null` | |

`node.openStream` maps each kind to a **fixed** brain-internal target (no SSRF) and checks that the bot is bound to the stamped node. Well-known `node.event` types: `audit`, `browser.lease-changed`, `browser.closed`, `node.roots-changed`; ignore unknown types.

### 5.3 Errors

All errors are tagged objects (`_tag`) inside `Fail` reasons:

| `_tag` | Fields |
|---|---|
| `PathDenied` | `path, reason` |
| `PolicyRefused` | `action, reason, retry` (`retry:false` = tell the model not to retry) |
| `EditFailed` | `path, reason` |
| `FsError` | `op, path, code` (`ENOENT`, `EISDIR`, …), `reason` |
| `TunnelFailed` | `kind, reason` |
| `StreamRefused` | `kind, reason` |
| `NotAuthenticated` | `reason` |
| `BrowserUnavailable` | `reason` |
| `BrowserActionFailed` | `action, reason` |
| `LeaseHeld` | `botId, holder, reason` |
| `DesktopUnavailable` | `message, missing?` (programs the node lacks) |
| `NodeUnavailable` | `nodeId, reason` (brain-side only) |

## 6. Capabilities and versions

- Capability names are versioned: `fs@1`, `shell@1`, `pty@1`, `tunnel@1`, `browser@1`, `desktop@1`, `screen@1`, `codex.exec-server@1`, `claude.cli@1`, `opencode.serve@1`. A bare name means `@1`.
- The brain uses **effective = declared ∩ approved**. A newly declared capability stays disabled until the owner approves it in Settings › Computers; declaring fewer never needs approval.
- The protocol version is one integer for the envelope and contract. The brain supports N and N−1.

## 7. Data streams (`/node/stream/:id`)

- A stream is requested by the brain (`pty.open`, `tunnel.open`, `browser.screencast`, `computer.stream`, `fs.download`, `fs.upload`) or by the node (`node.openStream`). Either way the brain mints `{streamId (96-bit), streamToken (128-bit)}`.
- The node dials `wss://<brain>/node/stream/<streamId>` with `Authorization: Bearer <streamToken>`. The token is single use and expires 30 s after minting.
- The brain splices frames **verbatim**: binary stays binary, text stays text. Each kind defines its own framing:

| Kind | Framing |
|---|---|
| `pty` | binary = terminal bytes (both ways). Text: brain→node `{"resize":{"cols":120,"rows":40}}`; node→brain `{"exit":0,"signal":null}` then close. |
| `claude.cli` | binary = stdin (brain→node) / stdout (node→brain). Text: brain→node `{"eof":true}` or `{"kill":"SIGTERM"}`; node→brain `{"exit":0,"signal":null}`. |
| `codex.exec-server`, `codex.app-server` | one JSON-RPC message per **text** frame (the node converts NDJSON stdio). |
| `tcp`, `mcp-http`, `anthropic-api`, `model-api` | raw binary. |
| `vnc-view`, `vnc-control` | raw RFB (binary, both ways) to the bot's view-only / control x11vnc; one stream per viewer (RFB is stateful). Text frames from the brain are ignored. Either side closing ends the other; a lease handed back closes `vnc-control` streams. |
| `cdp-screencast` | each frame is ONE binary message: `[u32 big-endian N][N bytes UTF-8 JSON meta][image bytes]`, `meta = {seq, mime, width, height, viewportWidth, viewportHeight, timestamp}`. Text frames are notices: `{"_tag":"Ended","reason"}`, `{"_tag":"Lease","holder"}`, `{"_tag":"Url","url","title"}`. |
| `transfer` (`fs.download`, `fs.upload`) | The **sender** (the node for `fs.download`, the brain for `fs.upload`): binary chunks ≤ 1 MiB, then ONE text frame `{"done":true,"sha256":"<hex of all bytes>","size":N}` (or `{"error":"…"}` when reading fails midway). The **receiver**: text `{"ack":N}` (total bytes received), at least every 1 MiB. The sender keeps at most 8 MiB sent but unacknowledged, so neither side buffers a whole file. The receiver verifies size and sha256; closing early aborts. `fs.download`: the node waits for the brain to close; `fs.upload`: the node answers the RPC. |

## 8. Writing a node in another language (checklist)

1. Generate an Ed25519 key; pair via `POST /node/pair`; pin `brainPublicKey`, keep `nodeId` and `brainOrigin`.
2. Dial `/node` with the signed `Authorization` header (fresh nonce per dial); keep the nonce.
3. Run a JSON-RPC 2.0 endpoint over the socket following §4: route frames by direction, Ack every chunk you receive, answer Pings, return `null` for void results.
4. Refuse everything with `NotAuthenticated` until `node.hello` arrives with a valid `brainSig`; answer it with `NodeHello`.
5. Implement the RPCs for the capabilities you declare. Enforce your own roots, deny-list and ceiling; call `node.requestApproval` for `ask`.
6. On `@effect/rpc/Interrupt` or a socket drop, kill the work's process group.
7. Open data streams by dialing `/node/stream/:id` with the token from the RPC payload.
8. Redial with backoff; stop on close code `4401`.

## 9. Using the TypeScript package

```ts
import { BrainRpcs, makePeer, makeUpgradeAuth, NodeRpcs, nodeStamp, verifyUpgradeAuth, makeReplayCache } from "@openbot/node-protocol"

// node side (inside a scope, with NodeRpcs handlers provided via NodeRpcs.toLayer(...)):
const { header, nonce } = yield* makeUpgradeAuth({ nodeId, privateKey, brainOrigin })
// … dial `wss://brain/node` with `authorization: header` to get `socket` (e.g. Socket.makeWebSocket) …
const peer = yield* makePeer({ socket, serve: NodeRpcs, call: BrainRpcs })
yield* peer.client["node.event"]({ type: "node.connected", data: null })
yield* peer.closed   // until the connection ends

// brain side (upgrade handler; BrainRpcs handlers provided):
const replay = makeReplayCache()
const auth = yield* verifyUpgradeAuth({ header: req.headers.authorization, brainOrigin, lookupKey, replay })
const peer = yield* makePeer({ socket: upgraded, serve: BrainRpcs, call: NodeRpcs, stamp: nodeStamp(auth.nodeId), pingTimeout: 15_000, livenessTimeout: 20_000 })
const hello = yield* peer.client["node.hello"]({ protocol: { min: 1, max: 1 }, brainVersion, brainSig: yield* signHello({ brainPrivateKey, nodeId: auth.nodeId, nonce: auth.nonce, brainOrigin }) })
```

`mux(socket)` is available on its own when a side needs the two virtual sockets directly. `@openbot/node-protocol/testing` provides `makeMemorySocketPair()` (an in-memory, frame-preserving socket pair) and `rawJsonPeer()` for wire-level tests.
