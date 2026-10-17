// DEV MOCK ONLY: a few canned skills.sh skills (search hits + their folders) for the import flow
// (skills.search / skills.preview / skills.install). Searching "offline" fails like skills.sh being down.
import type { SkillSearchResult } from "@openbot/contracts"

export interface CannedSkill {
  readonly result: SkillSearchResult
  readonly files: ReadonlyArray<{ readonly path: string; readonly contents: string }>
}

const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`
const pad = (text: string, bytes: number) => text + "\n" + "#".repeat(Math.max(0, bytes - text.length - 1))

export const SKILLS_SH: ReadonlyArray<CannedSkill> = [
  {
    result: { id: "anthropics/skills/pdf", name: "pdf", repo: "anthropics/skills", installs: 48_213 },
    files: [
      {
        path: "SKILL.md",
        contents: skillMd(
          "pdf",
          "Use when working with PDF files: extracting text and tables, filling forms, merging or splitting documents, or creating new PDFs.",
          [
            "# PDF processing",
            "",
            "## Overview",
            "This guide covers the PDF jobs that come up most. For advanced features see `reference.md`; for filling forms, read `forms.md` and follow its steps.",
            "",
            "## Quick start",
            "```python",
            "from pypdf import PdfReader",
            "",
            'reader = PdfReader("document.pdf")',
            "for page in reader.pages:",
            "    print(page.extract_text())",
            "```",
            "",
            "## Common tasks",
            "- **Extract text**: `pdftotext -layout input.pdf out.txt` keeps the layout",
            "- **Tables**: use `pdfplumber`; check every page, tables often span two",
            "- **Merge**: `qpdf --empty --pages a.pdf b.pdf -- merged.pdf`",
            "- **Split**: one file per page with `qpdf --split-pages input.pdf page-%d.pdf`",
            "",
            "## Forms",
            "1. Run `scripts/check_fillable_fields.py` to see if the form has fields",
            "2. Fillable: `scripts/fill_fillable_fields.py`",
            "3. Not fillable: convert pages to images (`scripts/convert_pdf_to_images.py`) and place the text by hand",
            "",
            "> Never overwrite the original. Write a new file next to it.",
          ].join("\n"),
        ),
      },
      { path: "reference.md", contents: pad("# PDF reference\n\nAdvanced pypdf, pdfplumber and qpdf usage.", 16_340) },
      { path: "forms.md", contents: pad("# Filling PDF forms\n\nStep by step.", 9_120) },
      { path: "scripts/check_fillable_fields.py", contents: pad("import sys\nfrom pypdf import PdfReader", 1_204) },
      { path: "scripts/fill_fillable_fields.py", contents: pad("import json, sys\nfrom pypdf import PdfReader, PdfWriter", 4_811) },
      { path: "scripts/convert_pdf_to_images.py", contents: pad("import sys\nfrom pdf2image import convert_from_path", 902) },
      { path: "LICENSE.txt", contents: pad("Apache License 2.0", 11_357) },
    ],
  },
  {
    result: { id: "anthropics/skills/xlsx", name: "xlsx", repo: "anthropics/skills", installs: 31_870 },
    files: [
      {
        path: "SKILL.md",
        contents: skillMd(
          "xlsx",
          "Use when creating, editing or analyzing spreadsheets (.xlsx, .csv): formulas, formatting, charts, cleaning data.",
          "# Spreadsheets\n\n- Keep formulas live: never paste computed values over them\n- Recalculate with `scripts/recalc.py` before you hand a file back\n- Number formats: currency `$#,##0.00`, percent `0.0%`\n",
        ),
      },
      { path: "scripts/recalc.py", contents: pad("import sys", 2_960) },
    ],
  },
  {
    result: { id: "mattpocock/skills/grill-me", name: "grill-me", repo: "mattpocock/skills", installs: 3_412 },
    files: [
      {
        path: "SKILL.md",
        contents: skillMd(
          "grill-me",
          "Use when the owner asks to be grilled on a plan or design: interview them relentlessly until every branch of the decision tree is resolved.",
          "# Grill me\n\nInterview me about every aspect of this plan until we reach a shared understanding.\n\n1. Walk down each branch of the design tree, one question at a time\n2. Resolve dependencies between decisions before moving on\n3. If the codebase can answer a question, look it up instead of asking\n4. Recommend an answer for every question you ask\n",
        ),
      },
    ],
  },
  {
    result: { id: "anthropics/skills/skill-creator", name: "skill-creator", repo: "anthropics/skills", installs: 12_655 },
    files: [
      {
        path: "SKILL.md",
        contents: skillMd(
          "skill-creator",
          "Use when asked to write a new skill or improve an existing one.",
          "# Writing skills\n\nA skill is a folder with a SKILL.md: a description of when to use it, then the steps.\n\n- Keep SKILL.md short; move details into other files and link them\n- Write the description for the model: say *when* to use it\n",
        ),
      },
      { path: "references/best-practices.md", contents: pad("# Best practices", 6_402) },
    ],
  },
  {
    result: { id: "vercel-labs/agent-skills/web-design-guidelines", name: "web-design-guidelines", repo: "vercel-labs/agent-skills", installs: 21_048 },
    files: [
      {
        path: "SKILL.md",
        contents: skillMd(
          "web-design-guidelines",
          "Use when reviewing a web UI for accessibility, layout and interaction issues.",
          "# Web interface review\n\nCheck focus states, hit targets (44 px on touch), contrast, reduced motion and empty states. Report each issue with the file and line.\n",
        ),
      },
    ],
  },
  {
    result: { id: "obra/superpowers/brainstorming", name: "brainstorming", repo: "obra/superpowers", installs: 8_967 },
    files: [
      {
        path: "SKILL.md",
        contents: skillMd(
          "brainstorming",
          "Use before writing code for a new feature: refine the idea with the owner through questions, then write a short design.",
          "# Brainstorming\n\nAsk one question at a time. Offer 2–3 approaches with trade-offs, then write the agreed design to `docs/design.md`.\n",
        ),
      },
    ],
  },
]

/** `name` / `description` from a SKILL.md's frontmatter, and its body. */
export const parseSkillMd = (contents: string): { readonly name?: string; readonly description?: string; readonly body: string } => {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(contents)
  if (!m) return { body: contents }
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(m[1]!)?.[1]?.trim()
  const name = field("name")
  const description = field("description")
  return { ...(name ? { name } : {}), ...(description ? { description } : {}), body: contents.slice(m[0].length) }
}
