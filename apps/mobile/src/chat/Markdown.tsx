// Bot messages as Markdown, drawn natively: `marked`'s lexer (as on the web) → nested Text for
// paragraphs, emphasis, code, links, lists, quotes, headings, tables and code blocks.
import * as Linking from "expo-linking"
import { type Token, type Tokens, marked } from "marked"
import { type ReactNode, useMemo } from "react"
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native"
import type { Theme } from "../theme.ts"

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" })

interface Ctx {
  readonly theme: Theme
  readonly color: string
  readonly size: number
}

const inline = (tokens: ReadonlyArray<Token> | undefined, ctx: Ctx, keyBase: string): ReactNode[] =>
  (tokens ?? []).map((t, i) => {
    const key = `${keyBase}.${i}`
    switch (t.type) {
      case "strong":
        return <Text key={key} style={{ fontWeight: "700" }}>{inline((t as Tokens.Strong).tokens, ctx, key)}</Text>
      case "em":
        return <Text key={key} style={{ fontStyle: "italic" }}>{inline((t as Tokens.Em).tokens, ctx, key)}</Text>
      case "del":
        return <Text key={key} style={{ textDecorationLine: "line-through" }}>{inline((t as Tokens.Del).tokens, ctx, key)}</Text>
      case "codespan":
        return (
          <Text key={key} style={{ fontFamily: MONO, fontSize: ctx.size - 2, backgroundColor: ctx.theme.codeBg }}>
            {decode((t as Tokens.Codespan).text)}
          </Text>
        )
      case "link": {
        const link = t as Tokens.Link
        return (
          <Text key={key} style={{ color: ctx.theme.accentFg }} onPress={() => void Linking.openURL(link.href)} suppressHighlighting>
            {inline(link.tokens, ctx, key)}
          </Text>
        )
      }
      case "br":
        return <Text key={key}>{"\n"}</Text>
      case "text": {
        const tt = t as Tokens.Text
        return tt.tokens ? <Text key={key}>{inline(tt.tokens, ctx, key)}</Text> : <Text key={key}>{decode(tt.text)}</Text>
      }
      case "escape":
        return <Text key={key}>{(t as Tokens.Escape).text}</Text>
      case "image": {
        const img = t as Tokens.Image
        return (
          <Text key={key} style={{ color: ctx.theme.accentFg }} onPress={() => void Linking.openURL(img.href)}>
            {img.text || img.href}
          </Text>
        )
      }
      default:
        return <Text key={key}>{"raw" in t ? decode(String(t.raw)) : ""}</Text>
    }
  })

/** HTML entities marked leaves in text (`&amp;`, `&#39;`, …). */
const decode = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _)

const block = (t: Token, ctx: Ctx, key: string, depth = 0): ReactNode => {
  const text = { color: ctx.color, fontSize: ctx.size, lineHeight: Math.round(ctx.size * 1.36) }
  switch (t.type) {
    case "paragraph":
      return <Text key={key} style={text} selectable>{inline((t as Tokens.Paragraph).tokens, ctx, key)}</Text>
    case "heading": {
      const h = t as Tokens.Heading
      const size = h.depth <= 1 ? ctx.size + 5 : h.depth === 2 ? ctx.size + 3 : ctx.size + 1
      return <Text key={key} style={[text, { fontSize: size, lineHeight: Math.round(size * 1.3), fontWeight: "700", marginTop: 4 }]}>{inline(h.tokens, ctx, key)}</Text>
    }
    case "code": {
      const code = t as Tokens.Code
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} style={[styles.code, { backgroundColor: ctx.theme.codeBg, borderColor: ctx.theme.lineTertiary }]}>
          <Text selectable style={{ fontFamily: MONO, fontSize: ctx.size - 3, lineHeight: Math.round((ctx.size - 3) * 1.45), color: ctx.color }}>{code.text}</Text>
        </ScrollView>
      )
    }
    case "blockquote":
      return (
        <View key={key} style={[styles.quote, { borderColor: ctx.theme.line }]}>
          {(t as Tokens.Blockquote).tokens.map((c, i) => block(c, { ...ctx, color: ctx.theme.fgSecondary }, `${key}.${i}`, depth))}
        </View>
      )
    case "list": {
      const list = t as Tokens.List
      const start = typeof list.start === "number" ? list.start : 1
      return (
        <View key={key} style={{ gap: 4, paddingLeft: depth > 0 ? 4 : 0 }}>
          {list.items.map((item, i) => (
            <View key={`${key}.${i}`} style={{ flexDirection: "row", gap: 6 }}>
              <Text style={[text, { minWidth: list.ordered ? 20 : 12, color: ctx.theme.fgSecondary }]}>{list.ordered ? `${start + i}.` : "•"}</Text>
              <View style={{ flex: 1, gap: 4 }}>
                {item.tokens.map((c, j) =>
                  c.type === "text" ? (
                    <Text key={j} style={text} selectable>{inline((c as Tokens.Text).tokens ?? [c], ctx, `${key}.${i}.${j}`)}</Text>
                  ) : (
                    block(c, ctx, `${key}.${i}.${j}`, depth + 1)
                  ),
                )}
              </View>
            </View>
          ))}
        </View>
      )
    }
    case "table": {
      const table = t as Tokens.Table
      const cell = (c: Tokens.TableCell, i: number, head: boolean) => (
        <View key={i} style={[styles.cell, { borderColor: ctx.theme.lineSecondary }]}>
          <Text style={[text, { fontSize: ctx.size - 2, fontWeight: head ? "600" : "400" }]}>{inline(c.tokens, ctx, `${key}.c${i}`)}</Text>
        </View>
      )
      return (
        <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false}>
          <View style={[styles.table, { borderColor: ctx.theme.lineSecondary }]}>
            <View style={{ flexDirection: "row" }}>{table.header.map((c, i) => cell(c, i, true))}</View>
            {table.rows.map((row, r) => (
              <View key={r} style={{ flexDirection: "row" }}>{row.map((c, i) => cell(c, i, false))}</View>
            ))}
          </View>
        </ScrollView>
      )
    }
    case "hr":
      return <View key={key} style={{ height: StyleSheet.hairlineWidth, backgroundColor: ctx.theme.line, marginVertical: 6 }} />
    case "space":
      return null
    default:
      return "text" in t && typeof t.text === "string" && t.text.trim() !== "" ? <Text key={key} style={text}>{decode(t.text)}</Text> : null
  }
}

export function Markdown({ text, theme, color, size = 17 }: { readonly text: string; readonly theme: Theme; readonly color?: string; readonly size?: number }): ReactNode {
  const tokens = useMemo(() => {
    try {
      return marked.lexer(text, { gfm: true, breaks: true })
    } catch {
      return [{ type: "paragraph", raw: text, text, tokens: [{ type: "text", raw: text, text }] } as Token]
    }
  }, [text])
  const ctx: Ctx = { theme, color: color ?? theme.fg, size }
  return <View style={{ gap: 8 }}>{tokens.map((t, i) => block(t, ctx, String(i)))}</View>
}

const styles = StyleSheet.create({
  code: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, gap: 6 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: "hidden" },
  cell: { minWidth: 90, maxWidth: 240, paddingHorizontal: 8, paddingVertical: 6, borderWidth: StyleSheet.hairlineWidth },
})
