import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, 'assets', 'brand', 'v3')
const symbol = (await fs.readFile(path.join(directory, 'symbol-dark.svg'), 'utf8'))
  .replace(/<\?xml[^>]*>\s*/, '')
  .replace('<svg ', '<svg x="64" y="114" ')
  .replace('width="288" height="256"', 'width="896" height="796"')
// Use the approved dark master unchanged, with the navy app tile and safe padding.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="208" fill="#0B1F3B"/>${symbol}</svg>`
const sizes = [16, 32, 64, 128, 256, 512, 1024]
const pngs = new Map()
const browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  await page.route('**/*', (route) => route.abort())
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;background:transparent}body>svg{display:block;width:100vw;height:100vh}</style>${svg}`)
    pngs.set(size, await page.screenshot({ omitBackground: true }))
  }
} finally { await browser.close() }

// Modern ICNS entries embed PNG bytes; retina entries explicitly cover 16/32/128/256/512 pt.
const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256],
  ['ic09', 512], ['ic10', 1024], ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]]
const chunks = types.map(([type, size]) => {
  const png = pngs.get(size)
  const header = Buffer.alloc(8)
  header.write(type, 0, 4, 'ascii')
  header.writeUInt32BE(png.length + 8, 4)
  return Buffer.concat([header, png])
})
const header = Buffer.alloc(8)
header.write('icns', 0, 4, 'ascii')
header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4)
await fs.writeFile(path.join(directory, 'app-icon.png'), pngs.get(1024))
await fs.writeFile(path.join(directory, 'app-icon.icns'), Buffer.concat([header, ...chunks]))
process.stdout.write('Generated v3 app-icon.png (1024px) and app-icon.icns (16–1024px).\n')
