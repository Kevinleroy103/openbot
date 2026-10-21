/**
 * The voice model's replies (experiment). Every reply is JSON `{action, say, instruction}`
 * (llama-server enforces the shape): `action` first so the decision is explicit, `say` next so it can
 * be spoken while the rest is still being written, then `instruction` (the work, when delegating).
 */

export interface VoiceReply {
  readonly action: "talk" | "delegate"
  readonly say: string
  readonly instruction: string
}

export const REPLY_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["talk", "delegate"] },
    say: { type: "string" },
    instruction: { type: "string" },
  },
  required: ["action", "say", "instruction"],
} as const

const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }

/**
 * The `say` string of a JSON object still being written: what is decoded so far, and whether the
 * string is closed. `undefined` until its opening quote arrives.
 */
export const sayFieldSoFar = (json: string): { readonly text: string; readonly closed: boolean } | undefined => {
  const key = /"say"\s*:\s*"/.exec(json)
  if (key === null) return undefined
  let text = ""
  for (let i = key.index + key[0].length; i < json.length; i++) {
    const char = json[i]!
    if (char === '"') return { text, closed: true }
    if (char !== "\\") {
      text += char
      continue
    }
    const next = json[i + 1]
    if (next === undefined) break // the escape is not complete yet
    if (next === "u") {
      const hex = json.slice(i + 2, i + 6)
      if (hex.length < 4) break
      text += String.fromCharCode(Number.parseInt(hex, 16))
      i += 5
      continue
    }
    text += ESCAPES[next] ?? next
    i += 1
  }
  return { text, closed: false }
}

export const parseReply = (json: string): VoiceReply | undefined => {
  try {
    const value = JSON.parse(json) as Partial<VoiceReply>
    if (value.action !== "talk" && value.action !== "delegate") return undefined
    return { action: value.action, say: String(value.say ?? "").trim(), instruction: String(value.instruction ?? "").trim() }
  } catch {
    return undefined
  }
}

const SENTENCE_END = /[.!?…]+["'”’)\]]*\s+/g
/** A long first sentence starts at a comma so the first words are heard sooner. */
const FIRST_CLAUSE_MIN_CHARS = 60

/** Cuts spoken text into sentences as it arrives (each goes to Kokoro on its own). */
export class SentenceChunker {
  private pending = ""
  private emitted = 0

  push(text: string): Array<string> {
    this.pending += text
    const out: Array<string> = []
    let start = 0
    for (const match of this.pending.matchAll(SENTENCE_END)) {
      const end = match.index + match[0].length
      const sentence = this.pending.slice(start, end).trim()
      if (sentence !== "") out.push(sentence)
      start = end
    }
    this.pending = this.pending.slice(start)
    if (this.emitted === 0 && out.length === 0 && this.pending.length > FIRST_CLAUSE_MIN_CHARS) {
      const comma = this.pending.indexOf(", ", FIRST_CLAUSE_MIN_CHARS / 2)
      if (comma !== -1) {
        out.push(this.pending.slice(0, comma + 1).trim())
        this.pending = this.pending.slice(comma + 2)
      }
    }
    this.emitted += out.length
    return out
  }

  /** What is left once the text is complete. */
  flush(): string | undefined {
    const rest = this.pending.trim()
    this.pending = ""
    if (rest === "") return undefined
    this.emitted++
    return rest
  }
}

export type ChatMessage = { readonly role: "system" | "user" | "assistant"; readonly content: string }

export type ReplyEvent =
  | { readonly type: "say"; readonly text: string }
  | { readonly type: "done"; readonly reply: VoiceReply }

/**
 * One reply from llama-server (`url`), streamed: `say` events carry the spoken text as it is written
 * (new text only), then `done` with the whole reply. Aborting `signal` stops it.
 */
export async function* streamReply(input: {
  readonly url: string
  readonly messages: ReadonlyArray<ChatMessage>
  readonly extras: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly fetch?: typeof fetch | undefined
}): AsyncGenerator<ReplyEvent> {
  const response = await (input.fetch ?? fetch)(`${input.url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: input.signal,
    body: JSON.stringify({
      messages: input.messages,
      response_format: { type: "json_schema", json_schema: { name: "reply", schema: REPLY_SCHEMA } },
      stream: true,
      temperature: 0.2,
      max_tokens: 400,
      ...input.extras,
    }),
  })
  if (!response.ok || response.body === null) throw new Error(`The voice model answered HTTP ${response.status}.`)
  const decoder = new TextDecoder()
  let buffer = ""
  let json = ""
  let spoken = 0
  /** New spoken text in one server-sent line, if any. */
  const take = (line: string): string | undefined => {
    if (!line.startsWith("data:")) return undefined
    const data = line.slice(5).trim()
    if (data === "[DONE]") return undefined
    const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string | null } }> }).choices?.[0]?.delta?.content
    if (delta === undefined || delta === null || delta === "") return undefined
    json += delta
    const say = sayFieldSoFar(json)
    if (say === undefined || say.text.length <= spoken) return undefined
    const added = say.text.slice(spoken)
    spoken = say.text.length
    return added
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const added = take(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      if (added !== undefined) yield { type: "say", text: added }
    }
  }
  // the last line may come without a newline
  const added = take(buffer.trim())
  if (added !== undefined) yield { type: "say", text: added }
  const reply = parseReply(json)
  if (reply === undefined) throw new Error(`The voice model's reply was not readable: ${json.slice(0, 200)}`)
  yield { type: "done", reply }
}
