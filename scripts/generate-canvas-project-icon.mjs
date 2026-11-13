import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

// 画布项目文件（.xingcanvas）在 Windows 资源管理器和桌面上的图标（深查 IC-10）。不配的话
// electron-builder 让文件类型借用程序自己的图标（"$appExe,0"），桌面上作品文件跟星芒的快捷方式
// 一模一样，分不清哪个是软件。这里画一张「白纸折角＋右下角一颗星芒」的文档图标，不加字，
// 2026-11-13 yoyo 看过预览回「改」。electron-builder 按 win.fileAssociations 的 icon 把它装到
// 安装目录的 resources 下，注册表 DefaultIcon 指过去。只给安装程序用，所以放 build/，不进 app.asar。
//
// 星芒用品牌包里浅底用的 standard 母版原样画，不裁星轨和小星（ui-spec/07-icons-brand.md）：
// 128px 以上用 symbol-standard，以下用 micro32-standard（托盘也是这份）。资源管理器按缩放和视图
// 挑正好那一档，所以每档单独画，小尺寸的纸边对齐到半像素，1px 描边不发虚。
// 重新生成：node scripts/generate-canvas-project-icon.mjs，需要项目已有的 Playwright Chromium。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brandDirectory = path.join(root, 'assets', 'brand', 'v3')
const output = path.join(root, 'build', 'canvas-project.ico')
const sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]

// 两张母版里图形实际占的范围（getBBox 量的），排版按图形本身对齐，不按画布留白。
const symbolInk = { x: 28.14, y: 30, width: 231.34, height: 192 }
const microInk = { x: 1.93, y: 2, width: 28.07, height: 28 }

// 小尺寸逐档手排：纸边（描边中线）的左右上下、折角大小，以及星芒的左上角和宽度，单位是像素。
const smallLayouts = {
  16: { left: 2.5, right: 13.5, top: 0.5, bottom: 15.5, fold: 4, corner: 1, mark: [3.5, 5.5, 9] },
  20: { left: 3.5, right: 16.5, top: 0.5, bottom: 19.5, fold: 5, corner: 1, mark: [5, 7.5, 10] },
  24: { left: 4.5, right: 19.5, top: 1.5, bottom: 22.5, fold: 6, corner: 1, mark: [7, 9.5, 11] },
  32: { left: 6.5, right: 25.5, top: 1.5, bottom: 30.5, fold: 8, corner: 1.5, mark: [9.5, 14, 14] },
  40: { left: 7.5, right: 32.5, top: 1.5, bottom: 38.5, fold: 10, corner: 1.5, mark: [13, 18, 17] },
}

// 48px 起按 256 的画布排一次再缩放；描边按目标尺寸折算，落在整像素附近。
const largeLayout = { left: 44, right: 212, top: 14, bottom: 242, fold: 58, corner: 14 }
const paperStroke = '#94A3BA'

function innerMarkup(svg) {
  return svg
    .replace(/<\?xml[^>]*>\s*/, '')
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title[\s\S]*?<\/title>/, '')
    .replace(/<desc[\s\S]*?<\/desc>/, '')
}

function paperPath({ left, right, top, bottom, fold, corner }) {
  return `M ${left + corner} ${top} H ${right - fold} L ${right} ${top + fold} V ${bottom - corner} `
    + `Q ${right} ${bottom} ${right - corner} ${bottom} H ${left + corner} Q ${left} ${bottom} ${left} ${bottom - corner} `
    + `V ${top + corner} Q ${left} ${top} ${left + corner} ${top} Z`
}

function foldPath({ right, top, fold, corner }) {
  return `M ${right - fold} ${top} V ${top + fold - corner} Q ${right - fold} ${top + fold} ${right - fold + corner} ${top + fold} H ${right} Z`
}

function markMarkup(x, y, width, master, ink) {
  const height = width * ink.height / ink.width
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${ink.x} ${ink.y} ${ink.width} ${ink.height}" overflow="visible">${master}</svg>`
}

function paperDefinitions(shadow) {
  return '<defs>'
    + '<linearGradient id="paper" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#F1F4F9"/></linearGradient>'
    + '<linearGradient id="fold" x1="0" y1="1" x2="1" y2="0"><stop stop-color="#F4F7FB"/><stop offset="1" stop-color="#C9D3E1"/></linearGradient>'
    + shadow
    + '</defs>'
}

function buildIconSvg(size, masters) {
  const small = smallLayouts[size]
  if (small) {
    const [x, y, width] = small.mark
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${paperDefinitions('')}`
      + `<path d="${paperPath(small)}" fill="url(#paper)" stroke="${paperStroke}" stroke-width="1" stroke-linejoin="round"/>`
      + `<path d="${foldPath(small)}" fill="url(#fold)" stroke="${paperStroke}" stroke-width="1" stroke-linejoin="round"/>`
      + `${markMarkup(x, y, width, masters.micro, microInk)}</svg>`
  }
  const unit = 256 / size
  const strokePixels = size >= 256 ? 3 : size >= 128 ? 2 : size >= 96 ? 1.5 : 1
  const useMicro = size < 128
  const ink = useMicro ? microInk : symbolInk
  const markWidth = useMicro ? 108 : 112
  const markHeight = markWidth * ink.height / ink.width
  const markX = largeLayout.right - 18 - markWidth
  const markY = largeLayout.bottom - 18 - markHeight
  // 64px 起纸下面垫一层很淡的影子，浅色背景上纸边更清楚；再小就只剩一圈脏边，不加。
  const shadow = size >= 64
    ? `<filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${2 * unit}" stdDeviation="${2.5 * unit}" flood-color="#0B1F3B" flood-opacity=".22"/></filter>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">${paperDefinitions(shadow)}`
    + `<path d="${paperPath(largeLayout)}" fill="url(#paper)" stroke="${paperStroke}" stroke-width="${strokePixels * unit}" stroke-linejoin="round"${shadow ? ' filter="url(#shadow)"' : ''}/>`
    + `<path d="${foldPath(largeLayout)}" fill="url(#fold)" stroke="${paperStroke}" stroke-width="${strokePixels * unit}" stroke-linejoin="round"/>`
    + `${markMarkup(markX, markY, markWidth, useMicro ? masters.micro : masters.symbol, ink)}</svg>`
}

// 同 generate-tray-icons.mjs：小于 256 的用经典 32 位 BMP 图标项（BGRA 自下而上 + 一位透明掩码），
// LoadImage 对它最稳；256 那档按惯例存 PNG，否则一张就要 256KB。
function bitmapEntry(size, rgba) {
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
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  const entries = images.map(({ size, rgba, png }, index) => {
    const entry = size === 256 ? png : bitmapEntry(size, rgba)
    const at = 6 + index * 16
    // 宽高各占一个字节，256 写 0。
    directory.writeUInt8(size % 256, at)
    directory.writeUInt8(size % 256, at + 1)
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.length
    return entry
  })
  return Buffer.concat([directory, ...entries])
}

const masters = {
  symbol: innerMarkup(await fs.readFile(path.join(brandDirectory, 'symbol-standard.svg'), 'utf8')),
  micro: innerMarkup(await fs.readFile(path.join(brandDirectory, 'micro32-standard.svg'), 'utf8')),
}

const browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
const images = []
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.route('**/*', (route) => route.abort())
  await page.setContent('<!doctype html><title>canvas project icon</title>')
  for (const size of sizes) {
    const rendered = await page.evaluate(async ({ markup, edge }) => {
      const image = new Image()
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = edge
      canvas.height = edge
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, edge, edge)
      return { rgba: Array.from(context.getImageData(0, 0, edge, edge).data), png: canvas.toDataURL('image/png') }
    }, { markup: buildIconSvg(size, masters), edge: size })
    images.push({
      size,
      rgba: Uint8Array.from(rendered.rgba),
      png: Buffer.from(rendered.png.slice(rendered.png.indexOf(',') + 1), 'base64'),
    })
  }
} finally { await browser.close() }
await fs.writeFile(output, buildIco(images))
process.stdout.write(`Generated build/canvas-project.ico (${sizes.join('/')}px).\n`)
