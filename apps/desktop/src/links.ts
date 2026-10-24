/**
 * `openbot://` links (no Electron here: unit-tested). `openbot://send?url=…&title=…&text=…&to=…`
 * opens quick send filled in (quickSend.ts); a link never sends by itself.
 */

export interface QuickSendPrefill {
  /** Increases with every opening: the page drops what an older opening filled in. */
  readonly id: number
  readonly link?: { readonly url: string; readonly title?: string; readonly from?: string }
  readonly text?: string
  readonly clipboard?: { readonly text?: string; readonly image?: string }
  readonly to?: string
}

/** `openbot://send?url=…&title=…&text=…&to=…` → what it fills in (other paths: undefined). */
export const prefillOfLink = (link: string): Omit<QuickSendPrefill, "id"> | undefined => {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return undefined
  }
  if (url.protocol !== "openbot:" || (url.hostname !== "send" && url.pathname.replace(/^\/+/, "") !== "send"))
    return undefined
  const q = url.searchParams
  const shared = q.get("url") ?? undefined
  let text = q.get("text")?.trim() || undefined
  // the Share menu passes a page as text: a lone URL is a link
  const page = shared ?? (text !== undefined && /^https?:\/\/\S+$/.test(text) ? text : undefined)
  if (page !== undefined && text === page) text = undefined
  return {
    ...(page === undefined ? {} : { link: { url: page, ...(q.get("title") ? { title: q.get("title")! } : {}) } }),
    ...(text === undefined ? {} : { text }),
    ...(q.get("to") ? { to: q.get("to")! } : {}),
  }
}
