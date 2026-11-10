import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 托盘那两份 ICO 是 scripts/generate-tray-icons.mjs 从品牌包 micro32 母版画出来的二进制文件，
// 这里钉住它们该有的样子：Windows 每一档缩放要的边长都在（深查 TR-8），浅色外圈那份在深色
// 任务栏上真的看得见（D94）。
const directory = path.join(__dirname, '..', 'assets', 'brand', 'v3')
const sizes = [16, 20, 24, 32, 40, 48, 64]
const gold = [212, 163, 85]

interface IconImage {
  size: number
  /** 自上而下的 RGBA。 */
  rgba: Uint8Array
}

function readIco(fileName: string): IconImage[] {
  const bytes = fs.readFileSync(path.join(directory, fileName))
  expect(bytes.readUInt16LE(0)).toBe(0)
  expect(bytes.readUInt16LE(2)).toBe(1)
  const images: IconImage[] = []
  for (let index = 0; index < bytes.readUInt16LE(4); index += 1) {
    const at = 6 + index * 16
    const size = bytes.readUInt8(at)
    const length = bytes.readUInt32LE(at + 8)
    const offset = bytes.readUInt32LE(at + 12)
    expect(bytes.readUInt8(at + 1)).toBe(size)
    expect(bytes.readUInt16LE(at + 6)).toBe(32)
    // Classic 32-bit DIB entries: LoadImage reads them on every supported Windows build.
    expect(bytes.readUInt32LE(offset)).toBe(40)
    expect(bytes.readInt32LE(offset + 4)).toBe(size)
    expect(bytes.readInt32LE(offset + 8)).toBe(size * 2)
    expect(bytes.readUInt16LE(offset + 14)).toBe(32)
    expect(length).toBe(40 + size * size * 4 + Math.ceil(size / 32) * 4 * size)
    expect(offset + length).toBeLessThanOrEqual(bytes.length)
    const rgba = new Uint8Array(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const from = offset + 40 + ((size - 1 - y) * size + x) * 4
        const to = (y * size + x) * 4
        rgba.set([bytes[from + 2], bytes[from + 1], bytes[from], bytes[from + 3]], to)
      }
    }
    images.push({ size, rgba })
  }
  return images
}

function luminance([red, green, blue]: number[]): number {
  const channel = (value: number) => {
    const ratio = value / 255
    return ratio <= 0.04045 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
}

function contrast(first: number[], second: number[]): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

/** 外圈的平均颜色：完全不透明、又不是金色星芒的那些像素。 */
function ringColor(image: IconImage): number[] {
  const ring: number[][] = []
  for (let index = 0; index < image.rgba.length; index += 4) {
    const pixel = [image.rgba[index], image.rgba[index + 1], image.rgba[index + 2]]
    const distance = pixel.reduce((sum, value, channel) => sum + Math.abs(value - gold[channel]), 0)
    if (image.rgba[index + 3] === 255 && distance > 60) ring.push(pixel)
  }
  expect(ring.length).toBeGreaterThan(0)
  return [0, 1, 2].map((channel) => ring.reduce((sum, pixel) => sum + pixel[channel], 0) / ring.length)
}

describe('tray icon assets', () => {
  const standard = readIco('tray.ico')
  const darkTaskbar = readIco('tray-dark.ico')

  it('carries one image per Windows small-icon size from 100% to 400% scaling', () => {
    expect(standard.map((image) => image.size)).toEqual(sizes)
    expect(darkTaskbar.map((image) => image.size)).toEqual(sizes)
  })

  it('keeps the ring visible on the taskbar each variant is shown on', () => {
    const lightTaskbar = [243, 243, 243]
    const darkTaskbars = [[32, 32, 32], [16, 16, 16]]
    for (const size of [24, 32]) {
      const standardRing = ringColor(standard.find((image) => image.size === size)!)
      const lightRing = ringColor(darkTaskbar.find((image) => image.size === size)!)
      expect(contrast(standardRing, lightTaskbar)).toBeGreaterThan(4.5)
      for (const taskbar of darkTaskbars) {
        expect(contrast(lightRing, taskbar)).toBeGreaterThan(4.5)
        // The navy ring melts into a dark taskbar, which is why the light variant exists.
        expect(contrast(standardRing, taskbar)).toBeLessThan(1.5)
      }
    }
  })
})
