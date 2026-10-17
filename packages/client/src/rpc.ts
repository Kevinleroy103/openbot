// `OpenBotClient`: one AtomRpc service = one WebSocket to `/rpc` shared by every atom
// (D4.3, effect4-platform.md §8). Effect RPC with `RpcSerialization.layerJson`; same origin, so the
// HttpOnly session cookie authenticates the upgrade (D4.4). Non-cookie clients put their `wsTicket`
// in `clientConfigAtom.url`.
import { Layer } from "effect"
import { OpenBotRpcs } from "@openbot/contracts"
import { AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"
import { Socket } from "effect/socket"
import { clientConfigAtom } from "./config.ts"
import { connectionHooksLayer, nextProtocolOwner, reconnectSchedule, reconnectSignalAtom } from "./connection.ts"

export class OpenBotClient extends AtomRpc.Service<OpenBotClient>()("@openbot/client/OpenBotClient", {
  group: OpenBotRpcs,
  protocol: (get) => {
    const config = get(clientConfigAtom)
    // Read so that `reconnectAtom` (bumping the signal) rebuilds the protocol with a fresh socket.
    get(reconnectSignalAtom)
    const registry = get.registry
    const owner = nextProtocolOwner()
    return RpcClient.layerProtocolSocket({
      pingInterval: config.pingInterval,
      // Fail calls fast while offline (t3code style); the protocol keeps reconnecting on its own
      // schedule and replica streams re-subscribe after the next connect.
      retryTransientErrors: false,
      retryPolicy: reconnectSchedule(registry, config.reconnect, owner),
    }).pipe(
      Layer.provide(Socket.layerWebSocket(config.url, { openTimeout: config.openTimeout })),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(connectionHooksLayer(registry, owner)),
    )
  },
}) {}

/** The flattened client type: `client("bots.create", payload)`. */
export type OpenBotRpcClient = typeof OpenBotClient.Service
