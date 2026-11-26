// Small preview of a finished image for the drawing tool's result. Plain Node
// only (zlib is built in), because the skill ships no dependencies and the tool
// may run on whatever Node the computer has. Only PNG is decoded: that is what
// the default OpenAI image models return. Anything else gets no preview.

import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { inflate } from 'node:zlib'

const inflateAsync = promisify(inflate)

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// 上游最大出 4096x4096（1,677 万像素）。再大的不解：解出来的原始数据按 4 字节一个像素算要上百 MB。
const MAX_SOURCE_PIXELS = 25_000_000
const MAX_SOURCE_SIDE = 16_384
export const PREVIEW_MAX_SIDE = 768
export const PREVIEW_MAX_BYTES = 200 * 1024
const PREVIEW_QUALITIES = [80, 65, 50, 35]

const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
const BIT_DEPTHS_BY_COLOR_TYPE = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }

/**
 * 读出图片的宽高（PNG 读 IHDR，JPEG 找 SOF 段），认不出返回 null。只看文件头，不解码。
 */
export function readImageDimensions(bytes) {
  if (!Buffer.isBuffer(bytes)) return null
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.toString('latin1', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null
      const marker = bytes[offset + 1]
      if (marker === 0xff) {
        offset += 1
        continue
      }
      const length = bytes.readUInt16BE(offset + 2)
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return null
}

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

function readSample(row, index, bitDepth) {
  if (bitDepth === 8) return row[index]
  if (bitDepth === 16) return row[index * 2]
  const perByte = 8 / bitDepth
  const byte = row[Math.floor(index / perByte)]
  const shift = 8 - bitDepth * ((index % perByte) + 1)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}

/**
 * 解 PNG 并按区域平均缩到最长边不超过 maxSide，透明的地方铺白底（JPEG 没有透明）。
 * 返回 { width, height, sourceWidth, sourceHeight, rgb }；不是 PNG、隔行扫描、尺寸过大或数据坏了返回 null。
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

  const scale = Math.min(1, maxSide / Math.max(width, height))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const columnBucket = new Int32Array(width)
  for (let x = 0; x < width; x += 1) columnBucket[x] = Math.min(targetWidth - 1, Math.floor((x * targetWidth) / width))
  const sums = new Float64Array(targetWidth * targetHeight * 3)
  const counts = new Uint32Array(targetWidth * targetHeight)
  const bytesPerPixel = Math.max(1, (channels * bitDepth) / 8)
  const sampleMax = bitDepth >= 8 ? 255 : (1 << bitDepth) - 1
  const palette = parsed.palette
  const paletteAlpha = colorType === 3 ? parsed.transparency : null
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1)
    const row = raw.subarray(rowStart + 1, rowStart + 1 + stride)
    if (!unfilterRow(raw[rowStart], row, previous, bytesPerPixel)) return null
    previous = row
    const bucketRow = Math.min(targetHeight - 1, Math.floor((y * targetHeight) / height)) * targetWidth
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
        if (paletteAlpha && entry < paletteAlpha.length) alpha = paletteAlpha[entry]
      } else if (colorType === 0 || colorType === 4) {
        const sample = readSample(row, x * channels, bitDepth)
        red = green = blue = bitDepth >= 8 ? sample : Math.round((sample * 255) / sampleMax)
        if (colorType === 4) alpha = readSample(row, x * channels + 1, bitDepth)
      } else {
        red = readSample(row, x * channels, bitDepth)
        green = readSample(row, x * channels + 1, bitDepth)
        blue = readSample(row, x * channels + 2, bitDepth)
        if (colorType === 6) alpha = readSample(row, x * channels + 3, bitDepth)
      }
      if (alpha < 255) {
        // 铺白底：透明底的切图在预览里看起来是白底，不是一片黑。
        const keep = alpha / 255
        red = red * keep + 255 * (1 - keep)
        green = green * keep + 255 * (1 - keep)
        blue = blue * keep + 255 * (1 - keep)
      }
      const bucket = bucketRow + columnBucket[x]
      sums[bucket * 3] += red
      sums[bucket * 3 + 1] += green
      sums[bucket * 3 + 2] += blue
      counts[bucket] += 1
    }
  }

  const rgb = Buffer.alloc(targetWidth * targetHeight * 3)
  for (let bucket = 0; bucket < counts.length; bucket += 1) {
    const count = counts[bucket] || 1
    rgb[bucket * 3] = Math.round(sums[bucket * 3] / count)
    rgb[bucket * 3 + 1] = Math.round(sums[bucket * 3 + 1] / count)
    rgb[bucket * 3 + 2] = Math.round(sums[bucket * 3 + 2] / count)
  }
  return { width: targetWidth, height: targetHeight, sourceWidth: width, sourceHeight: height, rgb }
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
export const JPEG_HUFFMAN_TABLES = {
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

function huffmanCodes(table) {
  const codes = new Map()
  let code = 0
  let position = 0
  for (let length = 1; length <= 16; length += 1) {
    for (let count = 0; count < table.counts[length - 1]; count += 1) {
      codes.set(table.symbols[position], { code, length })
      position += 1
      code += 1
    }
    code *= 2
  }
  return codes
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

function forwardDct(block) {
  for (let offset = 0; offset < 64; offset += 8) dctPass(block, offset, 1)
  for (let offset = 0; offset < 8; offset += 1) dctPass(block, offset, 8)
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

function createBitWriter() {
  const bytes = []
  let current = 0
  let free = 8
  function writeByte(value) {
    bytes.push(value)
    // Byte stuffing: a 0xFF inside entropy-coded data must be followed by 0x00.
    if (value === 0xff) bytes.push(0)
  }
  return {
    write(code, length) {
      for (let bit = length - 1; bit >= 0; bit -= 1) {
        free -= 1
        if ((code >> bit) & 1) current |= 1 << free
        if (free === 0) {
          writeByte(current)
          current = 0
          free = 8
        }
      }
    },
    finish() {
      // Pad the last byte with one-bits, as T.81 F.1.2.3 asks.
      if (free < 8) writeByte(current | ((1 << free) - 1))
      return bytes
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

function encodeBlock(writer, block, divisorTable, previousDc, dcCodes, acCodes) {
  forwardDct(block)
  const coefficients = new Int32Array(64)
  for (let index = 0; index < 64; index += 1) {
    const value = block[index] * divisorTable[index]
    coefficients[ZIGZAG[index]] = value > 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5)
  }
  const dc = coefficients[0]
  const difference = dc - previousDc
  const dcCategory = magnitudeCategory(difference)
  const dcCode = dcCodes.get(dcCategory)
  writer.write(dcCode.code, dcCode.length)
  if (dcCategory) writer.write(difference < 0 ? difference + (1 << dcCategory) - 1 : difference, dcCategory)

  let last = 63
  while (last > 0 && coefficients[last] === 0) last -= 1
  let zeros = 0
  for (let index = 1; index <= last; index += 1) {
    const value = coefficients[index]
    if (value === 0) {
      zeros += 1
      continue
    }
    while (zeros >= 16) {
      const run = acCodes.get(0xf0)
      writer.write(run.code, run.length)
      zeros -= 16
    }
    const category = magnitudeCategory(value)
    const symbol = acCodes.get((zeros << 4) | category)
    writer.write(symbol.code, symbol.length)
    writer.write(value < 0 ? value + (1 << category) - 1 : value, category)
    zeros = 0
  }
  if (last < 63) {
    const end = acCodes.get(0x00)
    writer.write(end.code, end.length)
  }
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
 * 把 RGB（每像素 3 字节）编成基线 JPEG。quality 1～100。
 */
export function encodeJpeg(rgb, width, height, quality = 80) {
  const level = Math.min(100, Math.max(1, Math.round(quality)))
  const luminanceTable = scaledQuantization(LUMINANCE_QUANTIZATION, level)
  const chrominanceTable = scaledQuantization(CHROMINANCE_QUANTIZATION, level)
  const luminanceDivisors = divisors(luminanceTable)
  const chrominanceDivisors = divisors(chrominanceTable)
  const codes = {
    luminanceDc: huffmanCodes(JPEG_HUFFMAN_TABLES.luminanceDc),
    luminanceAc: huffmanCodes(JPEG_HUFFMAN_TABLES.luminanceAc),
    chrominanceDc: huffmanCodes(JPEG_HUFFMAN_TABLES.chrominanceDc),
    chrominanceAc: huffmanCodes(JPEG_HUFFMAN_TABLES.chrominanceAc),
  }

  const header = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0x00, ...luminanceTable, 0x01, ...chrominanceTable]),
    ...segment(0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xc4, [
      ...huffmanSegmentPayload(0x00, JPEG_HUFFMAN_TABLES.luminanceDc),
      ...huffmanSegmentPayload(0x10, JPEG_HUFFMAN_TABLES.luminanceAc),
      ...huffmanSegmentPayload(0x01, JPEG_HUFFMAN_TABLES.chrominanceDc),
      ...huffmanSegmentPayload(0x11, JPEG_HUFFMAN_TABLES.chrominanceAc),
    ]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
  ]

  const writer = createBitWriter()
  const luminance = new Float64Array(64)
  const blue = new Float64Array(64)
  const red = new Float64Array(64)
  let previousY = 0
  let previousCb = 0
  let previousCr = 0
  for (let blockY = 0; blockY < height; blockY += 8) {
    for (let blockX = 0; blockX < width; blockX += 8) {
      for (let index = 0; index < 64; index += 1) {
        // Edge blocks repeat the last row and column instead of reading past the image.
        const y = Math.min(height - 1, blockY + (index >> 3))
        const x = Math.min(width - 1, blockX + (index & 7))
        const pixel = (y * width + x) * 3
        const r = rgb[pixel]
        const g = rgb[pixel + 1]
        const b = rgb[pixel + 2]
        luminance[index] = 0.299 * r + 0.587 * g + 0.114 * b - 128
        blue[index] = -0.16874 * r - 0.33126 * g + 0.5 * b
        red[index] = 0.5 * r - 0.41869 * g - 0.08131 * b
      }
      previousY = encodeBlock(writer, luminance, luminanceDivisors, previousY, codes.luminanceDc, codes.luminanceAc)
      previousCb = encodeBlock(writer, blue, chrominanceDivisors, previousCb, codes.chrominanceDc, codes.chrominanceAc)
      previousCr = encodeBlock(writer, red, chrominanceDivisors, previousCr, codes.chrominanceDc, codes.chrominanceAc)
    }
  }
  return Buffer.from([...header, ...writer.finish(), 0xff, 0xd9])
}

/**
 * 给画好的图做一张小预览：最长边 768、JPEG、不超过 200KB，质量从 80 往下降到放得下为止。
 * 只认 PNG；别的格式、解不开或怎么压都放不下时返回 null，调用方就只给文件路径。
 */
export async function buildImagePreview(bytes, options = {}) {
  const maxSide = options.maxSide ?? PREVIEW_MAX_SIDE
  const maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES
  const decoded = await decodePngScaled(bytes, maxSide)
  if (!decoded) return null
  for (const quality of PREVIEW_QUALITIES) {
    const jpeg = encodeJpeg(decoded.rgb, decoded.width, decoded.height, quality)
    if (jpeg.length <= maxBytes) return { bytes: jpeg, mimeType: 'image/jpeg', width: decoded.width, height: decoded.height }
  }
  return null
}
