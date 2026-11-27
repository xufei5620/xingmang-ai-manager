// Small preview of a finished image for the drawing tool's result. The original
// goes to a file; what travels back through the conversation is this preview, so
// it has to stay small: clients replay every tool result on each later turn, and
// some of them show a large image as raw JSON instead of a picture.
//
// Plain Node only (zlib is built in): the skill ships no dependencies and the
// tool runs on whatever Node the computer has. Only PNG is decoded, which is
// what the default OpenAI image models return. Other formats are passed through
// when they are already small enough and get no preview otherwise.

import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { deflate, inflate } from 'node:zlib'

const inflateAsync = promisify(inflate)
const deflateAsync = promisify(deflate)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// 上游最大出 4096x4096（1,677 万像素）。再大的不解：解出来的原始数据按 4 字节一个像素算要上百 MB。
const MAX_SOURCE_PIXELS = 25_000_000
const MAX_SOURCE_SIDE = 16_384
export const PREVIEW_MAX_SIDE = 1024
export const PREVIEW_MAX_BYTES = 300 * 1024
// 不透明的图压成 JPEG：先在最长边 1024 上把质量一档档往下降，还放不下再缩小边长。
const JPEG_STEPS = [
  [1024, 85], [1024, 75], [1024, 65], [1024, 50], [1024, 35],
  [768, 60], [768, 40], [512, 60], [512, 40], [384, 40],
]
// 透明底的图只能用 PNG（JPEG 没有透明），PNG 不能调质量，只能缩小边长。
const PNG_SIDES = [1024, 768, 640, 512, 384, 256, 192, 128]

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const BIT_DEPTHS_BY_COLOR_TYPE = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }

function parsePngChunks(bytes) {
  let header = null
  let palette = null
  let transparency = null
  const data = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > bytes.length) return null
    const chunk = bytes.subarray(start, end)
    if (type === 'IHDR') {
      if (length < 13) return null
      header = {
        width: chunk.readUInt32BE(0),
        height: chunk.readUInt32BE(4),
        bitDepth: chunk[8],
        colorType: chunk[9],
        interlace: chunk[12],
      }
    } else if (type === 'PLTE') {
      palette = chunk
    } else if (type === 'tRNS') {
      transparency = chunk
    } else if (type === 'IDAT') {
      data.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    offset = end + 4
  }
  if (!header || data.length === 0) return null
  return { header, palette, transparency, data: Buffer.concat(data) }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

// Reverses one scanline's PNG filter in place, using the already restored previous line.
function unfilterRow(filter, row, previous, bytesPerPixel) {
  const length = row.length
  if (filter === 0) return true
  if (filter === 1) {
    for (let index = bytesPerPixel; index < length; index += 1) row[index] = (row[index] + row[index - bytesPerPixel]) & 0xff
    return true
  }
  if (filter === 2) {
    for (let index = 0; index < length; index += 1) row[index] = (row[index] + previous[index]) & 0xff
    return true
  }
  if (filter === 3) {
    for (let index = 0; index < length; index += 1) {
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0
      row[index] = (row[index] + ((left + previous[index]) >> 1)) & 0xff
    }
    return true
  }
  if (filter === 4) {
    for (let index = 0; index < length; index += 1) {
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0
      const upLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0
      row[index] = (row[index] + paeth(left, previous[index], upLeft)) & 0xff
    }
    return true
  }
  return false
}

// One sample at its full depth: 16-bit samples keep both bytes so a colour key compares exactly.
function readSample(row, index, bitDepth) {
  if (bitDepth === 8) return row[index]
  if (bitDepth === 16) return (row[index * 2] << 8) | row[index * 2 + 1]
  const perByte = 8 / bitDepth
  const byte = row[Math.floor(index / perByte)]
  const shift = 8 - bitDepth * ((index % perByte) + 1)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

function scaledSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * 按区域平均缩小时用的累加器。颜色先乘上不透明度再累加，这样半透明边缘旁边的全透明像素不会把颜色带脏。
 */
function createAccumulator(sourceWidth, sourceHeight, maxSide) {
  const { width, height } = scaledSize(sourceWidth, sourceHeight, maxSide)
  const columns = new Int32Array(sourceWidth)
  for (let x = 0; x < sourceWidth; x += 1) columns[x] = Math.min(width - 1, Math.floor((x * width) / sourceWidth))
  const sums = new Float64Array(width * height * 4)
  const counts = new Uint32Array(width * height)
  let transparent = false
  return {
    rowOffset(y) {
      return Math.min(height - 1, Math.floor((y * height) / sourceHeight)) * width
    },
    add(rowOffset, x, red, green, blue, alpha) {
      const bucket = rowOffset + columns[x]
      const base = bucket * 4
      sums[base] += red * alpha
      sums[base + 1] += green * alpha
      sums[base + 2] += blue * alpha
      sums[base + 3] += alpha
      counts[bucket] += 1
      if (alpha < 255) transparent = true
    },
    finish() {
      const rgba = Buffer.alloc(width * height * 4)
      for (let bucket = 0; bucket < counts.length; bucket += 1) {
        const base = bucket * 4
        const alphaSum = sums[base + 3]
        if (alphaSum > 0) {
          rgba[base] = Math.round(sums[base] / alphaSum)
          rgba[base + 1] = Math.round(sums[base + 1] / alphaSum)
          rgba[base + 2] = Math.round(sums[base + 2] / alphaSum)
          rgba[base + 3] = Math.round(alphaSum / (counts[bucket] || 1))
        }
      }
      return { width, height, rgba, transparent }
    },
  }
}

/**
 * 解 PNG 并按区域平均缩到最长边不超过 maxSide。返回 { width, height, sourceWidth, sourceHeight, rgba, transparent }，
 * rgba 每像素 4 字节，transparent 表示原图里有没有不是完全不透明的像素。
 * 不是 PNG、隔行扫描、尺寸过大或数据坏了返回 null。
 */
export async function decodePngScaled(bytes, maxSide = PREVIEW_MAX_SIDE) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  const parsed = parsePngChunks(bytes)
  if (!parsed) return null
  const { width, height, bitDepth, colorType, interlace } = parsed.header
  const channels = CHANNELS_BY_COLOR_TYPE[colorType]
  if (!channels || !BIT_DEPTHS_BY_COLOR_TYPE[colorType].includes(bitDepth) || interlace !== 0) return null
  if (width < 1 || height < 1 || width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE || width * height > MAX_SOURCE_PIXELS) return null
  if (colorType === 3 && (!parsed.palette || parsed.palette.length < 3)) return null

  const stride = Math.ceil((width * channels * bitDepth) / 8)
  const expected = height * (stride + 1)
  let raw
  try {
    raw = await inflateAsync(parsed.data, { maxOutputLength: expected + 1024 })
  } catch {
    return null
  }
  if (raw.length < expected) return null

  const accumulator = createAccumulator(width, height, maxSide)
  const bytesPerPixel = Math.max(1, (channels * bitDepth) / 8)
  const sampleMax = (1 << bitDepth) - 1
  // 8 位照原样，其余位深换算到 0～255。
  const toByte = bitDepth === 8 ? null : 255 / sampleMax
  const palette = parsed.palette
  const transparency = parsed.transparency
  // 灰度和真彩色用 tRNS 指定「这一个颜色算透明」，每个分量 2 字节。
  const keyGray = colorType === 0 && transparency?.length >= 2 ? transparency.readUInt16BE(0) : -1
  const keyColor = colorType === 2 && transparency?.length >= 6
    ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)]
    : null
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride)
    if (!unfilterRow(raw[rowStart], row, previous, bytesPerPixel)) return null
    previous = row
    const rowOffset = accumulator.rowOffset(y)
    for (let x = 0; x < width; x += 1) {
      let red
      let green
      let blue
      let alpha = 255
      if (colorType === 3) {
        const entry = readSample(row, x, bitDepth)
        if (entry * 3 + 2 >= palette.length) return null
        red = palette[entry * 3]
        green = palette[entry * 3 + 1]
        blue = palette[entry * 3 + 2]
        if (transparency && entry < transparency.length) alpha = transparency[entry]
      } else if (colorType === 0 || colorType === 4) {
        const sample = readSample(row, x * channels, bitDepth)
        red = green = blue = toByte === null ? sample : Math.round(sample * toByte)
        if (colorType === 4) {
          const sampleAlpha = readSample(row, x * channels + 1, bitDepth)
          alpha = toByte === null ? sampleAlpha : Math.round(sampleAlpha * toByte)
        } else if (sample === keyGray) {
          alpha = 0
        }
      } else {
        const first = readSample(row, x * channels, bitDepth)
        const second = readSample(row, x * channels + 1, bitDepth)
        const third = readSample(row, x * channels + 2, bitDepth)
        red = toByte === null ? first : Math.round(first * toByte)
        green = toByte === null ? second : Math.round(second * toByte)
        blue = toByte === null ? third : Math.round(third * toByte)
        if (colorType === 6) {
          const sampleAlpha = readSample(row, x * channels + 3, bitDepth)
          alpha = toByte === null ? sampleAlpha : Math.round(sampleAlpha * toByte)
        } else if (keyColor && first === keyColor[0] && second === keyColor[1] && third === keyColor[2]) {
          alpha = 0
        }
      }
      accumulator.add(rowOffset, x, red, green, blue, alpha)
    }
  }
  return { ...accumulator.finish(), sourceWidth: width, sourceHeight: height }
}

/**
 * 把已经解开的图再缩小一档（最长边不超过 maxSide），已经够小就原样返回。
 */
export function scaleRgba(image, maxSide) {
  if (Math.max(image.width, image.height) <= maxSide) return image
  const accumulator = createAccumulator(image.width, image.height, maxSide)
  const { rgba, width, height } = image
  for (let y = 0; y < height; y += 1) {
    const rowOffset = accumulator.rowOffset(y)
    for (let x = 0; x < width; x += 1) {
      const base = (y * width + x) * 4
      accumulator.add(rowOffset, x, rgba[base], rgba[base + 1], rgba[base + 2], rgba[base + 3])
    }
  }
  return accumulator.finish()
}

// ---------------------------------------------------------------------------
// PNG encoder (8-bit RGBA, one IDAT). Each row picks the filter whose output
// has the smallest sum of absolute values, the usual heuristic for deflate.

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const chunk = Buffer.alloc(body.length + 8)
  chunk.writeUInt32BE(data.length, 0)
  body.copy(chunk, 4)
  chunk.writeUInt32BE(crc32(body), body.length + 4)
  return chunk
}

function filterRow(filter, row, previous, output) {
  let cost = 0
  for (let index = 0; index < row.length; index += 1) {
    const left = index >= 4 ? row[index - 4] : 0
    const up = previous ? previous[index] : 0
    const upLeft = previous && index >= 4 ? previous[index - 4] : 0
    let predicted = 0
    if (filter === 1) predicted = left
    else if (filter === 2) predicted = up
    else if (filter === 3) predicted = (left + up) >> 1
    else if (filter === 4) predicted = paeth(left, up, upLeft)
    const value = (row[index] - predicted) & 0xff
    output[index] = value
    cost += value < 128 ? value : 256 - value
  }
  return cost
}

/**
 * 把 RGBA（每像素 4 字节）编成 PNG，保留透明。
 */
export async function encodePng(rgba, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  const candidate = Buffer.alloc(stride)
  const best = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const row = rgba.subarray(y * stride, (y + 1) * stride)
    const previous = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null
    let bestFilter = 0
    let bestCost = Infinity
    for (let filter = 0; filter <= 4; filter += 1) {
      const cost = filterRow(filter, row, previous, candidate)
      if (cost < bestCost) {
        bestCost = cost
        bestFilter = filter
        candidate.copy(best)
      }
    }
    const rowStart = y * (stride + 1)
    raw[rowStart] = bestFilter
    best.copy(raw, rowStart + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', await deflateAsync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Baseline JPEG encoder (JFIF, 4:4:4, the standard tables from ITU-T T.81
// Annex K). Written out here instead of shipping a library with the skill.

const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63,
]

const LUMINANCE_QUANTIZATION = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]

const CHROMINANCE_QUANTIZATION = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
]

// Code counts for lengths 1..16, then the symbols in code order.
const HUFFMAN_TABLES = {
  luminanceDc: {
    counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
    symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
  luminanceAc: {
    counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    symbols: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
      0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
      0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
      0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
      0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
      0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
      0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
      0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
      0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
      0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0xf9, 0xfa,
    ],
  },
  chrominanceDc: {
    counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
    symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  },
  chrominanceAc: {
    counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    symbols: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
      0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
      0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
      0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
      0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
      0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
      0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
      0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
      0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
      0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
      0xf9, 0xfa,
    ],
  },
}

// AAN DCT row/column scale factors, folded into the quantizer below.
const AAN_SCALE = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379]

// Symbol -> code and length, as two flat arrays indexed by symbol.
function huffmanCodes(table) {
  const codes = new Uint16Array(256)
  const lengths = new Uint8Array(256)
  let code = 0
  let position = 0
  for (let length = 1; length <= 16; length += 1) {
    for (let count = 0; count < table.counts[length - 1]; count += 1) {
      codes[table.symbols[position]] = code
      lengths[table.symbols[position]] = length
      position += 1
      code += 1
    }
    code *= 2
  }
  return { codes, lengths }
}

const HUFFMAN_CODES = {
  luminanceDc: huffmanCodes(HUFFMAN_TABLES.luminanceDc),
  luminanceAc: huffmanCodes(HUFFMAN_TABLES.luminanceAc),
  chrominanceDc: huffmanCodes(HUFFMAN_TABLES.chrominanceDc),
  chrominanceAc: huffmanCodes(HUFFMAN_TABLES.chrominanceAc),
}

function scaledQuantization(base, quality) {
  const factor = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2)
  const table = new Array(64)
  for (let index = 0; index < 64; index += 1) {
    table[ZIGZAG[index]] = Math.min(255, Math.max(1, Math.floor((base[index] * factor + 50) / 100)))
  }
  return table
}

function divisors(table) {
  const result = new Float64Array(64)
  let index = 0
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      result[index] = 1 / (table[ZIGZAG[index]] * AAN_SCALE[row] * AAN_SCALE[column] * 8)
      index += 1
    }
  }
  return result
}

function dctPass(data, offset, step) {
  const d0 = data[offset]
  const d1 = data[offset + step]
  const d2 = data[offset + 2 * step]
  const d3 = data[offset + 3 * step]
  const d4 = data[offset + 4 * step]
  const d5 = data[offset + 5 * step]
  const d6 = data[offset + 6 * step]
  const d7 = data[offset + 7 * step]
  const tmp0 = d0 + d7
  const tmp7 = d0 - d7
  const tmp1 = d1 + d6
  const tmp6 = d1 - d6
  const tmp2 = d2 + d5
  const tmp5 = d2 - d5
  const tmp3 = d3 + d4
  const tmp4 = d3 - d4
  const even10 = tmp0 + tmp3
  const even13 = tmp0 - tmp3
  const even11 = tmp1 + tmp2
  const even12 = tmp1 - tmp2
  data[offset] = even10 + even11
  data[offset + 4 * step] = even10 - even11
  const z1 = (even12 + even13) * 0.707106781
  data[offset + 2 * step] = even13 + z1
  data[offset + 6 * step] = even13 - z1
  const odd10 = tmp4 + tmp5
  const odd11 = tmp5 + tmp6
  const odd12 = tmp6 + tmp7
  const z5 = (odd10 - odd12) * 0.382683433
  const z2 = 0.5411961 * odd10 + z5
  const z4 = 1.306562965 * odd12 + z5
  const z3 = odd11 * 0.707106781
  const z11 = tmp7 + z3
  const z13 = tmp7 - z3
  data[offset + 5 * step] = z13 + z2
  data[offset + 3 * step] = z13 - z2
  data[offset + step] = z11 + z4
  data[offset + 7 * step] = z11 - z4
}

function forwardDct(block) {
  for (let offset = 0; offset < 64; offset += 8) dctPass(block, offset, 1)
  for (let offset = 0; offset < 8; offset += 1) dctPass(block, offset, 8)
}

/**
 * JPEG 编码里和质量无关的那一半：分成 8x8 的块、转成 YCbCr、做 DCT。同一张图试几档质量时只做一次。
 * 输入是 RGBA，透明度不看（只给不透明的图用）。
 */
export function transformForJpeg(rgba, width, height) {
  const blocksWide = Math.ceil(width / 8)
  const blocksHigh = Math.ceil(height / 8)
  const coefficients = new Float32Array(blocksWide * blocksHigh * 3 * 64)
  const luminance = new Float64Array(64)
  const blue = new Float64Array(64)
  const red = new Float64Array(64)
  let offset = 0
  for (let blockY = 0; blockY < height; blockY += 8) {
    for (let blockX = 0; blockX < width; blockX += 8) {
      for (let index = 0; index < 64; index += 1) {
        // Edge blocks repeat the last row and column instead of reading past the image.
        const y = Math.min(height - 1, blockY + (index >> 3))
        const x = Math.min(width - 1, blockX + (index & 7))
        const pixel = (y * width + x) * 4
        const r = rgba[pixel]
        const g = rgba[pixel + 1]
        const b = rgba[pixel + 2]
        luminance[index] = 0.299 * r + 0.587 * g + 0.114 * b - 128
        blue[index] = -0.16874 * r - 0.33126 * g + 0.5 * b
        red[index] = 0.5 * r - 0.41869 * g - 0.08131 * b
      }
      for (const block of [luminance, blue, red]) {
        forwardDct(block)
        coefficients.set(block, offset)
        offset += 64
      }
    }
  }
  return { width, height, coefficients }
}

function createBitWriter(capacity) {
  let bytes = Buffer.allocUnsafe(Math.max(1024, capacity))
  let length = 0
  let pending = 0
  let pendingBits = 0
  function push(value) {
    if (length + 2 > bytes.length) {
      const grown = Buffer.allocUnsafe(bytes.length * 2)
      bytes.copy(grown, 0, 0, length)
      bytes = grown
    }
    bytes[length] = value
    length += 1
    // Byte stuffing: a 0xFF inside entropy-coded data must be followed by 0x00.
    if (value === 0xff) {
      bytes[length] = 0
      length += 1
    }
  }
  return {
    // size is at most 16 and fewer than 8 bits are ever pending, so this stays inside 32 bits.
    write(code, size) {
      pending = (pending << size) | code
      pendingBits += size
      while (pendingBits >= 8) {
        pendingBits -= 8
        push((pending >> pendingBits) & 0xff)
      }
      pending &= (1 << pendingBits) - 1
    },
    finish() {
      // Pad the last byte with one-bits, as T.81 F.1.2.3 asks.
      if (pendingBits > 0) push(((pending << (8 - pendingBits)) | ((1 << (8 - pendingBits)) - 1)) & 0xff)
      return bytes.subarray(0, length)
    },
  }
}

function magnitudeCategory(value) {
  let magnitude = Math.abs(value)
  let category = 0
  while (magnitude > 0) {
    category += 1
    magnitude >>= 1
  }
  return category
}

function writeBlock(writer, coefficients, start, divisorTable, quantized, previousDc, dcCodes, acCodes) {
  for (let index = 0; index < 64; index += 1) {
    const value = coefficients[start + index] * divisorTable[index]
    quantized[ZIGZAG[index]] = value > 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5)
  }
  const dc = quantized[0]
  const difference = dc - previousDc
  const dcCategory = magnitudeCategory(difference)
  writer.write(dcCodes.codes[dcCategory], dcCodes.lengths[dcCategory])
  if (dcCategory) writer.write(difference < 0 ? difference + (1 << dcCategory) - 1 : difference, dcCategory)

  let last = 63
  while (last > 0 && quantized[last] === 0) last -= 1
  let zeros = 0
  for (let index = 1; index <= last; index += 1) {
    const value = quantized[index]
    if (value === 0) {
      zeros += 1
      continue
    }
    while (zeros >= 16) {
      writer.write(acCodes.codes[0xf0], acCodes.lengths[0xf0])
      zeros -= 16
    }
    const category = magnitudeCategory(value)
    const symbol = (zeros << 4) | category
    writer.write(acCodes.codes[symbol], acCodes.lengths[symbol])
    writer.write(value < 0 ? value + (1 << category) - 1 : value, category)
    zeros = 0
  }
  if (last < 63) writer.write(acCodes.codes[0x00], acCodes.lengths[0x00])
  return dc
}

function segment(marker, payload) {
  const length = payload.length + 2
  return [0xff, marker, length >> 8, length & 0xff, ...payload]
}

function huffmanSegmentPayload(tableClassAndId, table) {
  return [tableClassAndId, ...table.counts, ...table.symbols]
}

/**
 * 把 transformForJpeg 的结果按给定质量（1～100）编成基线 JPEG。
 */
export function encodeJpeg(transformed, quality = 80) {
  const { width, height, coefficients } = transformed
  const level = Math.min(100, Math.max(1, Math.round(quality)))
  const luminanceTable = scaledQuantization(LUMINANCE_QUANTIZATION, level)
  const chrominanceTable = scaledQuantization(CHROMINANCE_QUANTIZATION, level)
  const luminanceDivisors = divisors(luminanceTable)
  const chrominanceDivisors = divisors(chrominanceTable)

  const header = Buffer.from([
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0x00, ...luminanceTable, 0x01, ...chrominanceTable]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xc4, [
      ...huffmanSegmentPayload(0x00, HUFFMAN_TABLES.luminanceDc),
      ...huffmanSegmentPayload(0x10, HUFFMAN_TABLES.luminanceAc),
      ...huffmanSegmentPayload(0x01, HUFFMAN_TABLES.chrominanceDc),
      ...huffmanSegmentPayload(0x11, HUFFMAN_TABLES.chrominanceAc),
    ]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
  ])

  const writer = createBitWriter(Math.ceil(coefficients.length / 16))
  const quantized = new Int32Array(64)
  let previousY = 0
  let previousCb = 0
  let previousCr = 0
  for (let start = 0; start < coefficients.length; start += 192) {
    previousY = writeBlock(writer, coefficients, start, luminanceDivisors, quantized, previousY, HUFFMAN_CODES.luminanceDc, HUFFMAN_CODES.luminanceAc)
    previousCb = writeBlock(writer, coefficients, start + 64, chrominanceDivisors, quantized, previousCb, HUFFMAN_CODES.chrominanceDc, HUFFMAN_CODES.chrominanceAc)
    previousCr = writeBlock(writer, coefficients, start + 128, chrominanceDivisors, quantized, previousCr, HUFFMAN_CODES.chrominanceDc, HUFFMAN_CODES.chrominanceAc)
  }
  return Buffer.concat([header, writer.finish(), Buffer.from([0xff, 0xd9])])
}

async function previewFromPng(bytes, maxSide, maxBytes) {
  const decoded = await decodePngScaled(bytes, maxSide)
  if (!decoded) return null
  if (decoded.transparent) {
    for (const side of PNG_SIDES) {
      if (side > maxSide) continue
      const scaled = scaleRgba(decoded, side)
      const png = await encodePng(scaled.rgba, scaled.width, scaled.height)
      if (png.length <= maxBytes) return { bytes: png, mimeType: 'image/png', width: scaled.width, height: scaled.height }
    }
    return null
  }
  let transformed = null
  let transformedSide = 0
  for (const [side, quality] of JPEG_STEPS) {
    if (side > maxSide) continue
    if (side !== transformedSide) {
      const scaled = scaleRgba(decoded, side)
      transformed = transformForJpeg(scaled.rgba, scaled.width, scaled.height)
      transformedSide = side
    }
    const jpeg = encodeJpeg(transformed, quality)
    if (jpeg.length <= maxBytes) return { bytes: jpeg, mimeType: 'image/jpeg', width: transformed.width, height: transformed.height }
  }
  return null
}

/**
 * 给画好的图做一张小预览：最长边不超过 1024、不超过 300KB。不透明的图用 JPEG，透明底的图用 PNG。
 * - 原图本身已经在这两个数以内：原样当预览。
 * - PNG：解开、缩小、重新压。
 * - 别的格式（Nano Banana、Grok 回的 JPEG）解不了：不超过 300KB 的原样当预览，超过的没有预览。
 * 返回 { bytes, mimeType, width, height }，做不出来返回 null，调用方就只给文件路径。
 */
export async function buildImagePreview(bytes, mimeType, dimensions, options = {}) {
  const maxSide = options.maxSide ?? PREVIEW_MAX_SIDE
  const maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES
  const small = bytes.length <= maxBytes
  const fits = small && (!dimensions || Math.max(dimensions.width, dimensions.height) <= maxSide)
  const original = { bytes, mimeType, width: dimensions?.width ?? 0, height: dimensions?.height ?? 0 }
  if (fits) return original
  if (mimeType === 'image/png') {
    const preview = await previewFromPng(bytes, maxSide, maxBytes)
    if (preview) return preview
  }
  return small ? original : null
}
