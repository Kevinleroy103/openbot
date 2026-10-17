// Accessibility tree (CDP `Accessibility.getFullAXTree`) → compact, model-readable text with ref ids,
// in the spirit of Playwright's aria snapshots:
//   - heading "Welcome" [level=1] [ref=e2]
//   - link "Docs" [ref=e3]
//   - textbox "Search": hello [ref=e4]
// `refs` maps each ref to the node's backendDOMNodeId (click/type by ref).

export interface AXValue {
  readonly type?: string
  readonly value?: unknown
}
export interface AXNode {
  readonly nodeId: string
  readonly ignored?: boolean
  readonly role?: AXValue
  readonly name?: AXValue
  readonly value?: AXValue
  readonly properties?: ReadonlyArray<{ readonly name: string; readonly value: AXValue }>
  readonly childIds?: ReadonlyArray<string>
  readonly parentId?: string
  readonly backendDOMNodeId?: number
}

export interface Snapshot {
  readonly text: string
  readonly refs: Map<string, number>
  readonly truncated: boolean
}

/** Roles that only group content; shown only when they carry a name. */
const TRANSPARENT = new Set(["generic", "none", "presentation", "GenericContainer", "Section", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Div", "Pre"])
const SKIP = new Set(["InlineTextBox", "LineBreak"])
const ROOTS = new Set(["RootWebArea", "WebArea"])
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "TextField"])
const BOOL_PROPS = ["checked", "disabled", "expanded", "selected", "pressed", "required", "focused"]

const str = (v: AXValue | undefined): string => {
  const x = v?.value
  return x === undefined || x === null ? "" : String(x)
}

const clean = (s: string, max = 200): string => {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

const quote = (s: string) => JSON.stringify(s)

export const renderSnapshot = (nodes: ReadonlyArray<AXNode>, options?: { readonly maxChars?: number; readonly refPrefix?: string }): Snapshot => {
  const maxChars = options?.maxChars ?? 12_000
  const prefix = options?.refPrefix ?? "e"
  const byId = new Map<string, AXNode>()
  for (const n of nodes) byId.set(n.nodeId, n)
  const root = nodes.find((n) => n.parentId === undefined || !byId.has(n.parentId)) ?? nodes[0]
  const refs = new Map<string, number>()
  const lines: Array<string> = []
  let size = 0
  let truncated = false
  let seq = 0

  const push = (line: string) => {
    if (truncated) return
    if (size + line.length + 1 > maxChars) {
      truncated = true
      return
    }
    lines.push(line)
    size += line.length + 1
  }

  const visit = (id: string, depth: number, parentName: string, guard: number) => {
    if (truncated || guard > 200) return
    const n = byId.get(id)
    if (!n) return
    const role = str(n.role)
    const children = n.childIds ?? []
    if (SKIP.has(role)) return
    const name = clean(str(n.name))
    if (n.ignored || ROOTS.has(role) || (TRANSPARENT.has(role) && name === "")) {
      for (const c of children) visit(c, depth, parentName, guard + 1)
      return
    }
    const indent = "  ".repeat(depth)
    if (role === "StaticText" || role === "text") {
      if (name && name !== parentName) push(`${indent}- text ${quote(name)}`)
      return
    }
    const attrs: Array<string> = []
    for (const p of n.properties ?? []) {
      if (p.name === "level") attrs.push(`[level=${str(p.value)}]`)
      else if (BOOL_PROPS.includes(p.name)) {
        const v = p.value.value
        if (v === true || v === "true") attrs.push(`[${p.name}]`)
        else if (v === "mixed") attrs.push(`[${p.name}=mixed]`)
      }
    }
    let line = `${indent}- ${role}${name ? ` ${quote(name)}` : ""}`
    const value = clean(str(n.value), 300)
    if (value && VALUE_ROLES.has(role)) line += `: ${quote(value)}`
    if (attrs.length) line += ` ${attrs.join(" ")}`
    if (n.backendDOMNodeId !== undefined) {
      const ref = `${prefix}${++seq}`
      refs.set(ref, n.backendDOMNodeId)
      line += ` [ref=${ref}]`
    }
    push(line)
    for (const c of children) visit(c, depth + 1, name, guard + 1)
  }

  if (root) visit(root.nodeId, 0, "", 0)
  if (truncated) lines.push("… (snapshot truncated; scroll or narrow the page and snapshot again)")
  return { text: lines.join("\n"), refs, truncated }
}
