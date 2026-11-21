// 临时探测：按段计时 macOS 开发版首屏，核完就删（不进 main）。
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { createFixtureServer, observeFixtureBootstrap } from '../e2e/harness.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
process.env.XINGMANG_RENDERER = 'v2'
const t0 = Date.now()
const mark = (e, x) => console.log(`[probe] ${Date.now() - t0}ms ${e}${x ? ' ' + JSON.stringify(x) : ''}`)
const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'probe-dev-origin-'))
const home = path.join(stateRoot, 'home'); await fs.mkdir(home, { recursive: true })
const { server, port } = await createFixtureServer({ root: projectRoot, logLevel: process.env.PROBE_VITE_LOG || 'silent' })
mark('vite.listening')
const args = [path.join(here, 'entry.cjs'), `--user-data-dir=${path.join(stateRoot, 'user-data')}`]
if (process.getuid?.() === 0) args.push('--no-sandbox')
const mainLog = path.join(stateRoot, 'main.log')
const app = await electron.launch({ args, cwd: projectRoot, timeout: 60_000, env: { ...process.env, PROBE_LOG_FILE: mainLog, PROBE_APP_PATH: projectRoot, PROBE_T0: String(t0), PROBE_REAL_ENTRY: path.join(projectRoot, 'dist-electron/platform/entry.js'), HOME: home, USERPROFILE: home, VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}`, XINGMANG_DISABLE_SINGLE_INSTANCE: '1' } })
mark('electron.launched')
process.on('exit', () => { try { console.log(require('node:fs').readFileSync(mainLog, 'utf8').trimEnd()) } catch { console.log('(no main log)') } })
const page = await app.firstWindow({ timeout: 60_000 })
mark('firstWindow', { url: page.url() })
page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) mark('framenavigated', { url: frame.url().slice(0, 80) }) })
page.on('domcontentloaded', () => mark('event.domcontentloaded', { url: page.url().slice(0, 80) }))
const evidence = observeFixtureBootstrap(page, server)
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || /vite/i.test(m.text())) mark('console', { type: m.type(), text: m.text().slice(0, 200) }) })
await page.waitForLoadState('domcontentloaded', { timeout: 60_000 })
const dcl = Date.now() - t0
mark('domcontentloaded', { url: page.url().slice(0, 80) })
mark('renderer-clock', await page.evaluate((zero) => ({ navigationStartAt: Math.round(performance.timeOrigin - zero) }), t0).catch((error) => ({ error: String(error).slice(0, 120) })))
await page.evaluate(() => {
  window.__probeLong = []
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__probeLong.push([Math.round(e.startTime), Math.round(e.duration)]) }).observe({ type: 'longtask', buffered: true }) } catch (error) { window.__probeLong.push(['unsupported', String(error)]) }
}).catch(() => undefined)
let previous = ''
const deadline = Date.now() + 45_000
let welcomeAt = null
while (Date.now() < deadline) {
  const s = await page.evaluate(() => {
    const q = (id) => Boolean(document.querySelector(`[data-testid="${id}"]`))
    const text = document.body?.innerText ?? ''
    return { root: document.getElementById('root')?.childElementCount ?? 0, splash: /正在准备星芒/.test(text), restoring: /正在恢复登录/.test(text), welcome: q('welcome-page'), now: Math.round(performance.now()) }
  }).catch((error) => ({ error: String(error).slice(0, 120) }))
  const key = JSON.stringify({ ...s, now: undefined })
  if (key !== previous) { previous = key; mark('state', s) }
  if (s.welcome) { welcomeAt = Date.now() - t0; break }
  await new Promise((r) => setTimeout(r, 50))
}
mark('summary', { dclToWelcomeMs: welcomeAt === null ? null : welcomeAt - dcl, totalMs: welcomeAt })
const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { responseEnd: Math.round(n.responseEnd), domInteractive: Math.round(n.domInteractive), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null }).catch(() => null)
mark('navigation', nav)
mark('longtasks', await page.evaluate(() => window.__probeLong).catch(() => null))
const resources = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => [r.name.replace(location.origin, ''), Math.round(r.startTime), Math.round(r.duration)]).sort((a, b) => b[2] - a[2]).slice(0, 12)).catch(() => null)
mark('slowest-resources', resources)
mark('evidence', await evidence.snapshot())
// Let the main-process profile summary print before closing.
await new Promise((r) => setTimeout(r, Math.max(0, Number(process.env.PROBE_PROFILE_MS || 15000) - (Date.now() - t0)) + 1500))
await app.close().catch(() => undefined)
await server.close()
mark('done')
