// 给一张 renderer-v2 界面截一张图，几秒钟出一张。
//
// 为什么要有：yoyo 2026-11-11 定了「配图」——动了版面的界面改动（加按钮、挪位置、新页面），
// 等他点头的帖子里除了逐字贴出的字，还要配一张改完的样子的图（docs/COLLABORATION.md §7.5）。
// v2-business-screenshots.mjs 一次出 240 张，是给整轮审阅用的；这里只截你指定的那一页。
//
// 用法（在仓库根目录）：
//   node scripts/audit/v2-page-screenshot.mjs <夹具页和参数> <输出.png> [等这个 data-testid 出现再截]
// 例：
//   node scripts/audit/v2-page-screenshot.mjs \
//     'e2e/v2-business-fixture.html?page=settings&theme=dark&os=win&system=1&evidence=1' \
//     /tmp/settings-dark.png page-settings
//
// 夹具只用 e2e/ 下的本地夹具页，数据全是本地假数据；除了本机这个 Vite 以外的请求一律掐掉，
// 不会连到任何线上站点。云端容器里带上 XINGMANG_E2E_CHROMIUM（docs/CLOUD-SANDBOX.md 第 2 节）。
// 截出来的是 Chromium 里的样子，不是 Windows / macOS 真机的样子，帖子里别写成真机截图。
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const projectRoot = path.resolve('.')
const fixturePattern = /^e2e\/[\w.-]+-fixture\.html(?:\?.*)?$/

function usageError(message) {
  console.error(`[v2-page-screenshot] ${message}`)
  console.error('用法：node scripts/audit/v2-page-screenshot.mjs <夹具页和参数> <输出.png> [data-testid]')
  process.exit(2)
}

const [fixture, output, waitForTestId] = process.argv.slice(2)
if (!fixture || !output || process.argv.length > 5) usageError('要给夹具页和输出文件两个参数。')
if (!fixturePattern.test(fixture)) usageError('夹具页只能是 e2e/ 下的 *-fixture.html，后面可以带 ? 参数。')
if (path.extname(output).toLowerCase() !== '.png') usageError('输出文件要以 .png 结尾。')
const outputFile = path.resolve(output)
// 截图不进源码 PR；写在仓库里迟早被 git add -A 捎进去。
if (!path.relative(projectRoot, outputFile).startsWith('..')) {
  usageError('输出文件放到仓库外面（临时目录或项目共享文件夹），截图不进仓库。')
}

process.env.XINGMANG_RENDERER = 'v2'
const server = await createServer({
  root: projectRoot,
  cacheDir: 'node_modules/.vite-v2-business-screenshots',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false },
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}`
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined,
})
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/*', (route) => (
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort()
  ))
  await page.goto(`${origin}/${fixture}`)
  if (waitForTestId) await page.getByTestId(waitForTestId).first().waitFor()
  else await page.waitForLoadState('networkidle')
  if (pageErrors.length > 0) throw new Error(`页面报错了，没截：${pageErrors.join('；')}`)
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await page.screenshot({ path: outputFile, fullPage: true })
  console.log(`[v2-page-screenshot] 截好了：${outputFile}`)
} finally {
  await browser.close()
  await server.close()
}
