// Navigation between the app's screens.
import { router } from "expo-router"

export const openChat = (conversationId: string) => router.push({ pathname: "/chat/[id]", params: { id: conversationId } })

/** A page of the web app inside the app (`path` is its hash route, e.g. `#/settings/computers`). */
export const openWeb = (path: string, title: string) => router.push({ pathname: "/web", params: { path, title } })
