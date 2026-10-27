// An update restarts the brain into the new release, but an open page (a browser tab, the desktop
// app's window) keeps running the web app it loaded. After every reconnect the page asks for the app
// page the brain serves now and reloads when that one loads scripts or styles this one does not.
// The URL keeps the chat; Composer.tsx keeps the drafts.
import { useAtomValue } from "@effect/atom-react"
import { connectionAtom, type ConnectionState } from "@openbot/client"
import { useEffect } from "react"

const generationOf = (connection: ConnectionState) => connection.generation

const assetsOf = (page: Document) =>
  Array.from(
    page.querySelectorAll('script[src], link[rel="stylesheet"]'),
    (element) => element.getAttribute("src") ?? element.getAttribute("href"),
  )

const reloadIfUpdated = async () => {
  const res = await fetch("/")
  if (!res.ok) return
  const served = new DOMParser().parseFromString(await res.text(), "text/html")
  const running = new Set(assetsOf(document))
  if (assetsOf(served).some((asset) => !running.has(asset))) location.reload()
}

export function useReloadOnUpdate(): void {
  const generation = useAtomValue(connectionAtom, generationOf)
  useEffect(() => {
    // the first connect is to the brain that served this page
    if (generation > 1) void reloadIfUpdated().catch(() => undefined)
  }, [generation])
}
