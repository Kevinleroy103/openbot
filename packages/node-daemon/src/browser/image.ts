// Image dimensions from PNG / JPEG / WebP headers (screenshots and screencast frames).

export interface ImageSize {
  readonly width: number
  readonly height: number
  readonly mime: string
}

export const imageSize = (b: Uint8Array): ImageSize | undefined => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  // PNG: 89 50 4E 47 ... IHDR width/height at 16/20
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20), mime: "image/png" }
  }
  // JPEG: scan for a SOFn marker
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2
        continue
      }
      const len = dv.getUint16(i + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7), mime: "image/jpeg" }
      }
      i += 2 + len
    }
    return undefined
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (
    b.length >= 30 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (chunk === "VP8 ")
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff, mime: "image/webp" }
    if (chunk === "VP8L") {
      const bits = dv.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, mime: "image/webp" }
    }
    if (chunk === "VP8X") {
      const w = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16))
      const h = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))
      return { width: w, height: h, mime: "image/webp" }
    }
  }
  return undefined
}
