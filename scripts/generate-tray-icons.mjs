import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Windows 托盘按「系统小图标」的边长向图标要一张图（100% 16px、125% 20px、150% 24px、
// 200% 32px……），只给 PNG 时它拿 32px 那张去缩，125%、150% 下发虚（深查 TR-8）。这里把
// 品牌包里的 micro32 母版按每一档的边长各画一张，打成一份多尺寸 ICO，系统挑正好那张。
// 两份：标准版（深蓝外圈，浅色任务栏）和深底版（浅蓝外圈，深色任务栏，D94），都是品牌包
// 原样的图形和配色，不另画。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, 'assets', 'brand', 'v3')
const sizes = [16, 20, 24, 32, 40, 48, 64]
const variants = [
  { source: 'micro32-standard.svg', output: 'tray.ico' },
  { source: 'micro32-dark.svg', output: 'tray-dark.ico' },
]

// 经典的 32 位 BMP 图标项（BGRA 自下而上 + 一位透明掩码）：LoadImage 对它最稳，
// 不依赖系统对 ICO 里内嵌 PNG 的支持。
function iconEntry(size, rgba) {
  const header = Buffer.alloc(40)
  const maskStride = Math.ceil(size / 32) * 4
  const pixels = Buffer.alloc(size * size * 4)
  const mask = Buffer.alloc(maskStride * size)
  for (let y = 0; y < size; y += 1) {
    const row = size - 1 - y
    for (let x = 0; x < size; x += 1) {
      const from = (y * size + x) * 4
      const to = (row * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
      if (rgba[from + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(pixels.length + mask.length, 20)
  return Buffer.concat([header, pixels, mask])
}

function buildIco(images) {
  const directoryBytes = Buffer.alloc(6 + images.length * 16)
  directoryBytes.writeUInt16LE(1, 2)
  directoryBytes.writeUInt16LE(images.length, 4)
  let offset = directoryBytes.length
  const entries = images.map(({ size, rgba }, index) => {
    const entry = iconEntry(size, rgba)
    const at = 6 + index * 16
    directoryBytes.writeUInt8(size, at)
    directoryBytes.writeUInt8(size, at + 1)
    directoryBytes.writeUInt16LE(1, at + 4)
    directoryBytes.writeUInt16LE(32, at + 6)
    directoryBytes.writeUInt32LE(entry.length, at + 8)
    directoryBytes.writeUInt32LE(offset, at + 12)
    offset += entry.length
    return entry
  })
  return Buffer.concat([directoryBytes, ...entries])
}

const browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.route('**/*', (route) => route.abort())
  for (const variant of variants) {
    const svg = (await fs.readFile(path.join(directory, variant.source), 'utf8')).replace(/<\?xml[^>]*>\s*/, '')
    const images = []
    for (const size of sizes) {
      // 先把母版的固有尺寸改成目标边长再画：按 32px 固有尺寸画完再放大，40px 以上会糊。
      const sized = svg.replace('width="32" height="32"', `width="${size}" height="${size}"`)
      const rgba = await page.evaluate(async ({ markup, edge }) => {
        const image = new Image()
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = edge
        canvas.height = edge
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0, edge, edge)
        return Array.from(context.getImageData(0, 0, edge, edge).data)
      }, { markup: sized, edge: size })
      images.push({ size, rgba: Uint8Array.from(rgba) })
    }
    await fs.writeFile(path.join(directory, variant.output), buildIco(images))
  }
} finally { await browser.close() }
process.stdout.write(`Generated tray.ico and tray-dark.ico (${sizes.join('/')}px).\n`)
