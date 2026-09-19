import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

process.env.XINGMANG_RENDERER = 'v2'
const server = await createServer({
  root: path.resolve('.'),
  cacheDir: 'node_modules/.vite-v2-business-screenshots',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 5191, strictPort: false, watch: null, hmr: false },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined,
})
const directory = path.resolve('docs/v2-business-evidence')
await fs.mkdir(directory, { recursive: true })
const results = []
try {
  for (const theme of ['light', 'dark'])
    for (const os of ['win', 'mac'])
      for (const state of ['default', 'empty', 'failed']) {
        for (const route of [
          'account',
          'account-dashboard',
          'account-keys',
          'account-usage',
          'account-tasks',
          'account-recharge',
          'account-orders',
          'account-invite',
          'account-devices',
          'sessions',
          'mcp',
          'skills',
          'plugins',
          'backups',
          'health',
          'maintenance',
          'feedback',
          'updates',
          'settings',
          'tutorial',
        ]) {
          const page = await browser.newPage({
            viewport: { width: 1280, height: 900 },
          })
          const errors = []
          page.on('pageerror', (error) => errors.push(error.message))
          await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
          try {
            const actualPage = route.startsWith('account-') ? 'account' : route
            const parameters = new URLSearchParams({ page: actualPage, theme, os })
            parameters.set('system', '1')
            parameters.set('evidence', '1')
            if (actualPage !== route) parameters.set('accountTab', route.slice('account-'.length))
            if (state === 'empty') parameters.set('empty', '')
            if (state === 'failed') parameters.set('fail', 'load')
            await page.goto(
              `${origin}/e2e/v2-business-fixture.html?${parameters}`,
            )
            await page.getByTestId(`page-${actualPage}`).waitFor()
            await page
              .waitForFunction(
                () =>
                  !document.body.innerText.includes('正在读取') &&
                  !document.body.innerText.includes('正在查询'),
                undefined,
                { timeout: 1500 },
              )
              .catch(() => undefined)
            const file = `${route}-${theme}-${os}-${state}.png`
            await page.screenshot({
              path: path.join(directory, file),
              fullPage: true,
            })
            const size = await page.evaluate(() => ({
              body: document.body.scrollWidth,
              viewport: innerWidth,
              text: document.body.innerText.length,
            }))
            if (errors.length || size.body > size.viewport || size.text < 20)
              throw new Error(`${file}: ${JSON.stringify({ errors, size })}`)
            results.push(file)
          } finally {
            await page.close()
          }
        }
        console.log(`${theme}/${os}/${state}: 20 pages and account panels`)
      }
  await fs.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: 'e2e/v2-business-fixture.tsx',
        data: 'local mock only',
        note: 'macOS entries check platform styling in Chromium; they are not native macOS evidence. Native capabilities use a typed local platform mock. Settings with no natural empty state remain ordinary content.',
        files: results,
      },
      null,
      2,
    ),
    'utf8',
  )
  console.log(`${results.length} screenshots verified`)
} finally {
  await browser.close()
  await server.close()
}
