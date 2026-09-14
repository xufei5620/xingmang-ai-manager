import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from '@playwright/test'
import { getAvailableLoopbackPort, injectCodexDesktopChineseLocale } from './codex-desktop-cdp'

let server: http.Server
let browser: Browser
let origin: string
let port: number

beforeAll(async () => {
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (request.url === '/zh-CN-fixture.js') {
      response.setHeader('Content-Type', 'application/javascript')
      response.end('document.getElementById("root").textContent = "简体中文已加载";')
      return
    }
    if (request.url === '/auxiliary') {
      response.end('<!doctype html><div id="root">Auxiliary webview</div>')
      return
    }
    response.end(`<!doctype html><html lang="en"><body><div id="root">English interface</div><script>
      window.electronBridge = { sendMessageFromView() {} };
      setTimeout(() => {
        window.__STATSIG__ = { firstInstance: {
          getLayer: () => ({ value: { enable_i18n: false, locale_source: 'IDE' }, get(key, fallback) { return this.value[key] ?? fallback } })
        }};
        const config = window.__STATSIG__.firstInstance.getLayer('72216192');
        const enabled = config.get('enable_i18n', false);
        const source = config.get('locale_source', 'IDE');
        if (enabled && source === 'SYSTEM' && navigator.language === 'zh-CN') {
          const script = document.createElement('script');
          script.src = '/zh-CN-fixture.js'; document.body.appendChild(script);
        }
        window.fixtureInitialized = true;
      }, 150);
    </script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable')
  origin = `http://127.0.0.1:${address.port}`
  port = await getAvailableLoopbackPort()
  browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--lang=zh-CN'] })
}, 30_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
})

describe('Codex locale with real isolated Chromium documents', () => {
  it('restores the real renderer from the reported no-patch state while an auxiliary webview is present', async () => {
    const context = await browser.newContext({ locale: 'zh-CN' })
    try {
      const auxiliary = await context.newPage()
      await auxiliary.goto(`${origin}/auxiliary`)
      const page = await context.newPage()
      await page.goto(`${origin}/app`)
      await page.waitForFunction(() => Reflect.get(window, 'fixtureInitialized') === true)
      const initial = await page.evaluate(() => ({
        language: navigator.language,
        ready: document.readyState,
        hasBridge: Boolean(Reflect.get(window, 'electronBridge')),
        hasPatch: Boolean(Reflect.get(window, '__xingmangCodexChineseLocaleState')),
        hasStatsig: Boolean(Reflect.get(window, '__STATSIG__')),
        chineseResourcesLoaded: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('zh-CN-')).length,
      }))
      expect(initial).toEqual({ language: 'zh-CN', ready: 'complete', hasBridge: true, hasPatch: false, hasStatsig: true, chineseResourcesLoaded: 0 })
      const result = await injectCodexDesktopChineseLocale(port, {
        fetch: async (url, init) => {
          const response = await fetch(url, init)
          const targets = await response.json() as Array<{ url: string; type: string }>
          const fixtureTargets = targets.filter((target) => target.url.startsWith(`${origin}/`))
            .map((target) => ({ ...target, type: target.url.endsWith('/auxiliary') ? 'webview' : target.type }))
            .sort((left, right) => Number(right.type === 'webview') - Number(left.type === 'webview'))
          return new Response(JSON.stringify(fixtureTargets))
        },
      })
      expect(result.injectedTargets).toBeGreaterThan(0)
      await page.waitForFunction(() => document.getElementById('root')?.textContent === '简体中文已加载')
      expect(await page.evaluate(() => performance.getEntriesByType('resource').filter((entry) => entry.name.includes('zh-CN-')).length)).toBe(1)
      expect(await auxiliary.locator('#root').innerText()).toBe('Auxiliary webview')
      expect(await page.evaluate(() => Reflect.get(window, '__xingmangCodexChineseLocaleState')?.localeReads)).toBeGreaterThan(0)
    } finally { await context.close() }
  }, 30_000)
})
