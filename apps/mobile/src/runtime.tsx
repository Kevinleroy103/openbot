// The app's session and its OpenBot client: the shared @openbot/client runtime (one `/rpc` socket,
// live roster and conversation replicas) pointed at the owner's OpenBot, the session sent as the
// bearer token (React Native sockets take headers; the web build rides on the browser's cookie).
import { RegistryProvider } from "@effect/atom-react"
import { clientConfigAtom, defaultClientConfig } from "@openbot/client"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { Platform } from "react-native"
import { clearConnection, type Connection, loadConnection, saveConnection, sessionHeaders } from "./session.ts"

interface SessionValue {
  /** undefined while loading from the keychain; null when not connected */
  readonly connection: Connection | null | undefined
  readonly connected: (c: Connection) => Promise<void>
  readonly disconnect: () => Promise<void>
}

const SessionContext = createContext<SessionValue | undefined>(undefined)

export const useSession = (): SessionValue => {
  const value = useContext(SessionContext)
  if (!value) throw new Error("useSession outside SessionProvider")
  return value
}

/** The current connection (screens behind the connect screen only). */
export const useConnection = (): Connection => {
  const { connection } = useSession()
  if (!connection) throw new Error("not connected")
  return connection
}

export function SessionProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [connection, setConnection] = useState<Connection | null | undefined>(undefined)
  useEffect(() => {
    void loadConnection().then((c) => setConnection(c ?? null))
  }, [])
  const connected = useCallback(async (c: Connection) => {
    await saveConnection(c)
    setConnection(c)
  }, [])
  const disconnect = useCallback(async () => {
    await clearConnection()
    setConnection(null)
  }, [])
  const value = useMemo(() => ({ connection, connected, disconnect }), [connection, connected, disconnect])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/** A fresh client runtime per connection (a new OpenBot or session rebuilds everything). */
export function ClientProvider({
  connection,
  children,
}: {
  readonly connection: Connection
  readonly children: ReactNode
}): ReactNode {
  const config = defaultClientConfig({
    url: `${connection.origin.replace(/^http/, "ws")}/rpc`,
    ...(Platform.OS === "web" ? {} : { headers: sessionHeaders(connection) }),
  })
  return (
    <RegistryProvider
      key={`${connection.origin} ${connection.sessionToken}`}
      initialValues={[[clientConfigAtom, config]]}
    >
      {children}
    </RegistryProvider>
  )
}
