import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// Windows 安装、卸载向导左边那张图（MUI2 欢迎页、完成页）。electron-builder 按
// nsis.installerSidebar 找 build/installerSidebar.bmp，卸载向导没单独配就用同一张。
// 图形和字标都是 assets/brand/v3 里已核验的深底母版，原样画上去，只定大小和位置；
// 底色是应用图标那块深蓝（generate-app-icons.mjs 的 #0B1F3B），装好后桌面图标和
// 向导是同一个颜色。重新生成：node scripts/generate-installer-sidebar.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brandDirectory = path.join(root, 'assets', 'brand', 'v3')
const output = path.join(root, 'build', 'installerSidebar.bmp')

// MUI2 欢迎页左图的固定尺寸。安装程序没声明高 DPI，系统按整窗缩放，所以只出这一种。
const width = 164
const height = 314
const background = '#0B1F3B'

// 两张母版的画布尺寸与图形实际占的范围（从 SVG 里的 translate 和路径坐标读出来）：
// symbol 288×256，图形在 x 21–265、y 30–222；wordmark 413×144，字在 x 24–389、y 24–119。
// 比例照闪屏（Splash.tsx：图形 132、字标 28），两者按图形本身的上下边留 18px。
const symbolWidth = 132
const symbolHeight = symbolWidth * 256 / 288
const symbolInkTop = 30 * symbolWidth / 288
const symbolInkHeight = 192 * symbolWidth / 288
const wordmarkHeight = 26
const wordmarkWidth = wordmarkHeight * 413 / 144
const wordmarkInkTop = 24 * wordmarkHeight / 144
const wordmarkInkHeight = 95 * wordmarkHeight / 144
const gap = 18
// 整组放在略高于正中的位置（视觉中心），左右居中。
const groupHeight = symbolInkHeight + gap + wordmarkInkHeight
const groupTop = Math.round(height * 0.44 - groupHeight / 2)
const symbolY = Math.round(groupTop - symbolInkTop)
const wordmarkY = Math.round(groupTop + symbolInkHeight + gap - wordmarkInkTop)

async function svgDataUrl(name) {
  const contents = await fs.readFile(path.join(brandDirectory, name))
  return `data:image/svg+xml;base64,${contents.toString('base64')}`
}

const layers = [
  { src: await svgDataUrl('symbol-dark.svg'), x: (width - symbolWidth) / 2, y: symbolY, width: symbolWidth, height: symbolHeight },
  { src: await svgDataUrl('wordmark-dark.svg'), x: (width - wordmarkWidth) / 2, y: wordmarkY, width: wordmarkWidth, height: wordmarkHeight },
]

const browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
let rgba
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.route('**/*', (route) => route.abort())
  await page.setContent('<!doctype html><title>sidebar</title>')
  // Draw each master as its own image so their identical gradient ids never
  // collide, and the SVG bytes reach the rasteriser untouched.
  rgba = await page.evaluate(async ({ width, height, background, layers }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.fillStyle = background
    context.fillRect(0, 0, width, height)
    for (const layer of layers) {
      const image = new Image()
      image.src = layer.src
      await image.decode()
      context.drawImage(image, layer.x, layer.y, layer.width, layer.height)
    }
    return Array.from(context.getImageData(0, 0, width, height).data)
  }, { width, height, background, layers })
} finally { await browser.close() }

// 24 位、不压缩、自下而上的 BMP：NSIS 用 LoadImage 读，这是它最稳的格式；不带
// alpha 通道，也不写时间戳，同样的母版每次生成的字节都一样。
const rowSize = Math.ceil(width * 3 / 4) * 4
const pixelBytes = rowSize * height
const bitmap = Buffer.alloc(54 + pixelBytes)
bitmap.write('BM', 0, 'ascii')
bitmap.writeUInt32LE(bitmap.length, 2)
bitmap.writeUInt32LE(54, 10)
bitmap.writeUInt32LE(40, 14)
bitmap.writeInt32LE(width, 18)
bitmap.writeInt32LE(height, 22)
bitmap.writeUInt16LE(1, 26)
bitmap.writeUInt16LE(24, 28)
bitmap.writeUInt32LE(0, 30)
bitmap.writeUInt32LE(pixelBytes, 34)
bitmap.writeInt32LE(2835, 38)
bitmap.writeInt32LE(2835, 42)
for (let y = 0; y < height; y += 1) {
  const rowOffset = 54 + (height - 1 - y) * rowSize
  for (let x = 0; x < width; x += 1) {
    const source = (y * width + x) * 4
    const target = rowOffset + x * 3
    bitmap[target] = rgba[source + 2]
    bitmap[target + 1] = rgba[source + 1]
    bitmap[target + 2] = rgba[source]
  }
}
await fs.writeFile(output, bitmap)
process.stdout.write(`Generated build/installerSidebar.bmp (${width}×${height}, 24-bit).\n`)
