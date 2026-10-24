/**
 * Pure helpers for files bots send (`send_file`): media type from the file's first bytes (magic
 * numbers) and its extension, image dimensions from the header, and human-readable sizes.
 *
 * Magic numbers win over the extension (a `.png` that is really a JPEG is served as JPEG), except
 * for ZIP containers (docx, xlsx, epub, apk, … are ZIPs) and MP4-family boxes, where the extension
 * is more specific. Without magic or a known extension: `text/plain` for UTF-8 text, else
 * `application/octet-stream`.
 */

const EXTENSIONS: Readonly<Record<string, string>> = {
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  // video
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  ogv: "video/ogg",
  "3gp": "video/3gpp",
  // audio
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  weba: "audio/webm",
  // documents
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  py: "text/x-python",
  rs: "text/plain",
  go: "text/plain",
  sh: "application/x-sh",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  rtf: "application/rtf",
  // archives
  zip: "application/zip",
  jar: "application/java-archive",
  apk: "application/vnd.android.package-archive",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  zst: "application/zstd",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  // other binaries
  wasm: "application/wasm",
  dmg: "application/x-apple-diskimage",
  iso: "application/x-iso9660-image",
}

/** Lower-case extension of a file name, without the dot ("" when none). */
export const extensionOf = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? name
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase()
}

const ascii = (bytes: Uint8Array, at: number, length: number): string => {
  let s = ""
  for (let i = at; i < at + length && i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return s
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0): boolean =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b)

/** ISO base media (`ftyp` box) brands → type. */
const ftypType = (brand: string, ext: string): string | undefined => {
  const b = brand.trim().toLowerCase()
  if (b === "avif" || b === "avis") return "image/avif"
  if (b === "heic" || b === "heix" || b === "hevc" || b === "heim" || b === "heis") return "image/heic"
  if (b === "mif1" || b === "msf1") return ext === "avif" ? "image/avif" : "image/heif"
  if (b === "qt") return "video/quicktime"
  if (b === "m4a" || b === "m4b" || b === "m4p") return "audio/mp4"
  if (b.startsWith("3gp") || b.startsWith("3g2")) return "video/3gpp"
  if (ext === "m4a") return "audio/mp4"
  if (ext === "mov") return "video/quicktime"
  return "video/mp4"
}

/** The type the first bytes prove, if any. */
export const sniffMime = (head: Uint8Array, ext = ""): string | undefined => {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (ascii(head, 0, 6) === "GIF87a" || ascii(head, 0, 6) === "GIF89a") return "image/gif"
  if (ascii(head, 0, 4) === "RIFF") {
    const kind = ascii(head, 8, 4)
    if (kind === "WEBP") return "image/webp"
    if (kind === "WAVE") return "audio/wav"
    if (kind === "AVI ") return "video/x-msvideo"
  }
  if (ascii(head, 4, 4) === "ftyp") return ftypType(ascii(head, 8, 4), ext)
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]))
    return ext === "mkv" ? "video/x-matroska" : ext === "weba" ? "audio/webm" : "video/webm"
  if (ascii(head, 0, 5) === "%PDF-") return "application/pdf"
  if (ascii(head, 0, 4) === "OggS") return ext === "ogv" ? "video/ogg" : "audio/ogg"
  if (ascii(head, 0, 4) === "fLaC") return "audio/flac"
  if (ascii(head, 0, 3) === "ID3" || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe6) === 0xe2))
    return "audio/mpeg"
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    const byExt = EXTENSIONS[ext]
    return byExt !== undefined && (byExt.includes("zip") || byExt.startsWith("application/vnd.") || ext === "jar")
      ? byExt
      : "application/zip"
  }
  if (startsWith(head, [0x1f, 0x8b])) return "application/gzip"
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed"
  if (startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "application/x-xz"
  if (ascii(head, 0, 3) === "BZh") return "application/x-bzip2"
  if (startsWith(head, [0x28, 0xb5, 0x2f, 0xfd])) return "application/zstd"
  if (ascii(head, 0, 7) === "Rar!\u001a\u0007\u0000" || ascii(head, 0, 6) === "Rar!\u001a\u0007")
    return "application/vnd.rar"
  if (ascii(head, 257, 5) === "ustar") return "application/x-tar"
  if (startsWith(head, [0x00, 0x61, 0x73, 0x6d])) return "application/wasm"
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) return "image/tiff"
  if (ext === "bmp" && ascii(head, 0, 2) === "BM") return "image/bmp"
  if (ext === "ico" && startsWith(head, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon"
  return undefined
}

/** UTF-8 text without NUL bytes (an incomplete code point at the very end is fine). */
export const looksLikeText = (head: Uint8Array): boolean => {
  if (head.length === 0) return true
  if (head.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 4)))
    return true
  } catch {
    return false
  }
}

/** The media type of a file from its name and first bytes. */
export const detectMime = (name: string, head: Uint8Array): string => {
  const ext = extensionOf(name)
  const sniffed = sniffMime(head, ext)
  if (sniffed !== undefined) return sniffed
  const byExt = EXTENSIONS[ext]
  if (byExt !== undefined) {
    // a "text" extension on binary content is not text
    if (
      (byExt.startsWith("text/") || byExt === "application/json" || byExt === "image/svg+xml") &&
      !looksLikeText(head)
    ) {
      return "application/octet-stream"
    }
    return byExt
  }
  return looksLikeText(head) ? "text/plain" : "application/octet-stream"
}

const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8)
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!

const sane = (width: number, height: number) =>
  width > 0 && height > 0 && width <= 100_000 && height <= 100_000 ? { width, height } : undefined

/** Pixel size of a PNG, GIF, WebP or JPEG from its first bytes (undefined when not in `head`). */
export const imageDimensions = (
  mime: string,
  head: Uint8Array,
): { readonly width: number; readonly height: number } | undefined => {
  switch (mime) {
    case "image/png":
      return head.length >= 24 && ascii(head, 12, 4) === "IHDR" ? sane(u32be(head, 16), u32be(head, 20)) : undefined
    case "image/gif":
      return head.length >= 10 ? sane(u16le(head, 6), u16le(head, 8)) : undefined
    case "image/webp": {
      const chunk = ascii(head, 12, 4)
      if (chunk === "VP8X" && head.length >= 30) return sane(u24le(head, 24) + 1, u24le(head, 27) + 1)
      if (chunk === "VP8 " && head.length >= 30) return sane(u16le(head, 26) & 0x3fff, u16le(head, 28) & 0x3fff)
      if (chunk === "VP8L" && head.length >= 25) {
        const b = head.subarray(21, 25)
        return sane(
          1 + (((b[1]! & 0x3f) << 8) | b[0]!),
          1 + (((b[3]! & 0x0f) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)),
        )
      }
      return undefined
    }
    case "image/jpeg": {
      let at = 2
      while (at + 9 < head.length) {
        if (head[at] !== 0xff) return undefined
        const marker = head[at + 1]!
        if (marker === 0xff) {
          at += 1
          continue
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          at += 2
          continue
        }
        const length = u16be(head, at + 2)
        // SOF0–SOF15 except DHT (C4), JPG (C8), DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return sane(u16be(head, at + 7), u16be(head, at + 5))
        }
        at += 2 + length
      }
      return undefined
    }
    default:
      return undefined
  }
}

/** "24.1 MB", "512 KB", "37 bytes" (decimal units, as file managers show them). */
export const formatBytes = (n: number): string => {
  if (n < 1000) return `${n} byte${n === 1 ? "" : "s"}`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n / 1000
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i++
  }
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[i]}`
}
