import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import layout from './macos-dmg-layout.cjs'

// Mac 安装包窗口的背景（IC-9）。打开 DMG 原来只有 electron-builder 自带的灰底虚线箭头，
// 小白常直接在窗口里双击星芒打开，没拖进「应用程序」。这张图在品牌深蓝上写一行中文告诉
// 客户怎么做，两个图标放在一块浅色底板上（为什么要浅色见 macos-dmg-layout.cjs 的 panel）。
// 版面数字全来自 macos-dmg-layout.cjs，打包配置按同一份摆图标。
// 重新生成：node scripts/generate-dmg-background.mjs，需要项目已有的 Playwright Chromium。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = path.join(root, 'build')
const hintPath = path.join(buildDirectory, 'dmg-background-hint.svg')

const { width, height, iconSize, application, applications, panel } = layout
// 应用图标那块深蓝（generate-app-icons.mjs），Windows 安装向导左图用的也是它。
const navy = '#0B1F3B'
const cream = '#FAF7EE'
const gold = '#D4A355'

// 那行字：18px，左右居中，基线在 68。字已经在 dmg-background-hint.svg 里转成轮廓。
const hintFontSize = 18
const hintBaseline = 68

// 深蓝上零星的小星点：[x, y, 半径, 不透明度]。写死位置，每次生成都一样。
const starDust = [
  [64, 18, 1.1, 0.55], [92, 92, 0.8, 0.35], [148, 22, 0.7, 0.3], [210, 98, 0.9, 0.3], [318, 18, 0.8, 0.35],
  [384, 96, 0.7, 0.3], [452, 26, 1.2, 0.5], [500, 86, 0.8, 0.35], [18, 210, 0.8, 0.3], [520, 250, 0.9, 0.35],
  [70, 362, 0.9, 0.35], [196, 360, 0.7, 0.25], [350, 366, 0.8, 0.3], [478, 358, 1.1, 0.45],
]

// 四角小星，跟品牌图形右上角那颗小星同一个样子。
function sparkle(cx, cy, r, fill) {
  const near = r * 0.12
  const side = r * 0.75
  return `<path fill="${fill}" d="M ${cx} ${cy - r} C ${cx + near} ${cy - near} ${cx + near} ${cy - near} ${cx + side} ${cy} `
    + `C ${cx + near} ${cy + near} ${cx + near} ${cy + near} ${cx} ${cy + r} `
    + `C ${cx - near} ${cy + near} ${cx - near} ${cy + near} ${cx - side} ${cy} `
    + `C ${cx - near} ${cy - near} ${cx - near} ${cy - near} ${cx} ${cy - r} Z"/>`
}

// 两个图标之间的金色点线箭头，跟图标边缘各留 22px。
function arrow() {
  const y = application.y
  const start = application.x + iconSize / 2 + 22
  const tip = applications.x - iconSize / 2 - 22
  return `<line x1="${start}" y1="${y}" x2="${tip - 20}" y2="${y}" stroke="#C99A4C" stroke-width="5" stroke-linecap="round" stroke-dasharray="0.1 12"/>`
    + `<path d="M ${tip - 14} ${y - 13} L ${tip} ${y} L ${tip - 14} ${y + 13}" fill="none" stroke="#B98A3E" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`
}

// 字的轮廓原样搬进背景这张 SVG（不当成 <image> 引用），截图时不用等它解码。
function hintGroup(hintSvg) {
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(hintSvg)
  const ascender = /data-ascender="([\d.]+)"/.exec(hintSvg)
  const paths = hintSvg.match(/<path [^>]*\/>/g)
  if (!viewBox || !ascender || !paths) throw new Error('dmg-background-hint.svg 缺 viewBox、data-ascender 或字形')
  const scale = hintFontSize / 1000
  const left = (width - Number(viewBox[1]) * scale) / 2
  const top = hintBaseline - Number(ascender[1]) * scale
  return `<g transform="translate(${left} ${top}) scale(${scale})">${paths.join('')}</g>`
}

function backgroundSvg(hintSvg) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <radialGradient id="glow" cx="${width / 2}" cy="-40" r="420" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#1B3B69"/><stop offset=".55" stop-color="#10274A"/><stop offset="1" stop-color="${navy}"/>
  </radialGradient>
  <linearGradient id="panelFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FCFAF4"/><stop offset="1" stop-color="#F3EEE1"/></linearGradient>
  <filter id="panelShadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity=".28"/></filter>
</defs>
<rect width="${width}" height="${height}" fill="${navy}"/>
<rect width="${width}" height="${height}" fill="url(#glow)"/>
${starDust.map(([x, y, r, opacity]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${cream}" opacity="${opacity}"/>`).join('')}
${sparkle(30, 32, 7, gold)}${sparkle(508, 100, 4.5, 'rgba(250,247,238,.55)')}
${hintGroup(hintSvg)}
<rect x="${panel.x}" y="${panel.y}" width="${panel.width}" height="${panel.height}" rx="${panel.radius}" fill="url(#panelFill)" filter="url(#panelShadow)"/>
<rect x="${panel.x + 0.5}" y="${panel.y + 0.5}" width="${panel.width - 1}" height="${panel.height - 1}" rx="${panel.radius - 0.5}" fill="none" stroke="rgba(212,163,85,.35)"/>
${arrow()}
</svg>`
}

// Chromium writes no pHYs chunk, so both PNGs would read as 72 dpi and the
// @2x one as twice the size in points. tiffutil -cathidpicheck (what
// electron-builder runs to merge the pair) wants the two to match in points,
// so the 2x image has to say 144 dpi.
function withPixelDensity(png, dotsPerInch) {
  const ihdrEnd = 8 + 25
  if (png.toString('ascii', 12, 16) !== 'IHDR') throw new Error('不是 PNG：缺 IHDR')
  const data = Buffer.alloc(9)
  const pixelsPerMetre = Math.round(dotsPerInch / 0.0254)
  data.writeUInt32BE(pixelsPerMetre, 0)
  data.writeUInt32BE(pixelsPerMetre, 4)
  data.writeUInt8(1, 8)
  const type = Buffer.from('pHYs', 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])), 8 + data.length)
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)])
}

const svg = backgroundSvg(await fs.readFile(hintPath, 'utf8'))
const browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
try {
  for (const [scale, name] of [[1, layout.backgroundName], [2, layout.retinaBackgroundName]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
    await page.route('**/*', (route) => route.abort())
    await page.setContent(`<!doctype html><title>dmg</title><style>html,body{margin:0;background:${navy}}svg{display:block}</style>${svg}`)
    const png = await page.screenshot({ clip: { x: 0, y: 0, width, height } })
    await fs.writeFile(path.join(buildDirectory, name), withPixelDensity(png, 72 * scale))
    await page.close()
    process.stdout.write(`Generated build/${name} (${width * scale}×${height * scale}).\n`)
  }
} finally { await browser.close() }
