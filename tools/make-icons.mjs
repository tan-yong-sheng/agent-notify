#!/usr/bin/env node

// Generates the icons the manifest points at, so they are reproducible rather
// than opaque binaries nobody can regenerate. The repository has no build step
// and no dependencies, so this writes PNG itself: signature, IHDR, one IDAT of
// zlib-deflated scanlines, IEND. Run it only when the artwork changes; the
// output is committed.
//
//   node tools/make-icons.mjs

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const OUT_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'public')

const BG = [22, 27, 34] // --card-bg
const BOLT = [88, 166, 255] // --accent
const RING = [48, 54, 61] // --card-border

// A lightning bolt in a 0..1 square, the same mark the page header uses. Points
// are in fractional coordinates so the shape scales to any size.
const BOLT_POINTS = [
  [0.56, 0.08],
  [0.28, 0.54],
  [0.46, 0.54],
  [0.40, 0.92],
  [0.72, 0.42],
  [0.52, 0.42],
]

export function insidePolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

// Rounded square mask, so the icon reads as an app tile on a launcher rather
// than as a picture with hard corners.
export function insideTile(x, y, radius) {
  const r = radius
  const corners = [
    [r, r],
    [1 - r, r],
    [r, 1 - r],
    [1 - r, 1 - r],
  ]
  if (x >= r && x <= 1 - r) return true
  if (y >= r && y <= 1 - r) return true
  return corners.some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= r)
}

export function renderRgba(size) {
  const rows = []
  const scale = 1 / size
  for (let py = 0; py < size; py++) {
    // Each PNG scanline starts with a filter byte; 0 means "no filter".
    const row = Buffer.alloc(1 + size * 4)
    for (let px = 0; px < size; px++) {
      // Sample at pixel centre so the shape is not biased to the top-left.
      const x = (px + 0.5) * scale
      const y = (py + 0.5) * scale
      let colour = [0, 0, 0, 0]
      if (insideTile(x, y, 0.22)) {
        colour = [...BG, 255]
        // A one-pixel-ish inner ring, so the tile has an edge on a dark
        // launcher background where the fill alone would vanish.
        const edge = Math.min(x, y, 1 - x, 1 - y)
        if (edge > 0.012 && edge < 0.032) colour = [...RING, 255]
        if (insidePolygon(x, y, BOLT_POINTS)) colour = [...BOLT, 255]
      }
      const at = 1 + px * 4
      row[at] = colour[0]
      row[at + 1] = colour[1]
      row[at + 2] = colour[2]
      row[at + 3] = colour[3]
    }
    rows.push(row)
  }
  return Buffer.concat(rows)
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng(size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0) // width
  ihdr.writeUInt32BE(size, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(renderRgba(size), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Writing files is what happens when this is run, not when it is imported: the
// tests import it to exercise the drawing, and importing must not touch disk.
export function writeIcons(outDir = OUT_DIR) {
  fs.mkdirSync(outDir, { recursive: true })
  const written = []
  // The maskable variant keeps the glyph inside the safe zone, because Android
  // crops a maskable icon to whatever shape the launcher uses.
  for (const { name, size, note } of [
    { name: 'icon', size: 192 },
    { name: 'icon', size: 512 },
    { name: 'icon-maskable', size: 512, note: ', maskable' },
  ]) {
    const file = path.join(outDir, `${name}-${size}.png`)
    fs.writeFileSync(file, encodePng(size))
    written.push({ file, size, note })
  }
  return written
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { file, size, note } of writeIcons()) {
    console.log(`wrote ${path.relative(process.cwd(), file)} (${size}x${size}${note ?? ''})`)
  }
}

