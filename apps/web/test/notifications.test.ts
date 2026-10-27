// Unit tests for the system notifications' options (app/notifications.ts): only a Bot that needs
// you stays on screen until dismissed.
import { describe, expect, test } from "bun:test"
import { NotificationKind, type ConversationId, type Notification, type NotificationId } from "@openbot/contracts"
import { notificationOptions } from "../src/app/notifications.ts"

const notification = (kind: NotificationKind): Notification => ({
  id: "ntf_01ABC" as NotificationId,
  kind,
  conversationId: "cnv_01ABC" as ConversationId,
  title: "Scout",
  body: "Done.",
  at: 0,
})

describe("notificationOptions", () => {
  test("a Bot that needs you requires interaction", () => {
    expect(notificationOptions(notification("waiting"), "data:image/png;base64,")).toEqual({
      body: "Done.",
      tag: "cnv_01ABC",
      requireInteraction: true,
      icon: "data:image/png;base64,",
    })
  })

  test("every other kind does not", () => {
    for (const kind of NotificationKind.literals.filter((k) => k !== "waiting")) {
      expect(notificationOptions(notification(kind), undefined).requireInteraction).toBe(false)
    }
  })
})
