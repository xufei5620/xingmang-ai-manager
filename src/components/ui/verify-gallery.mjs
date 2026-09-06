import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const outputDirectory = path.join(projectRoot, '.project-surgeon/audits/20260906-ui-implementation/ui-gallery')
await fs.mkdir(outputDirectory, { recursive: true })
const server = await createServer({
  configFile: path.join(projectRoot, 'vite.config.ts'), root: projectRoot, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})
await server.listen()
const address = server.httpServer.address()
const browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
const results = []

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${address.port}/src/components/ui/gallery.html`)
  await page.getByRole('heading', { name: '星芒 AI / 组件检阅' }).waitFor()
  const gallery = page.getByTestId('component-gallery')
  const primary = page.getByTestId('gallery-primary')
  const initialWidth = (await primary.boundingBox()).width
  await primary.click()
  assert.equal(await primary.isDisabled(), true)
  assert.equal((await primary.boundingBox()).width, initialWidth)
  assert.equal(await primary.innerText(), '下载更新')
  await page.getByRole('button', { name: '重新检查', exact: true }).click()

  await page.getByLabel('配置名称', { exact: true }).fill('')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  assert.equal(await page.getByLabel('配置名称', { exact: true }).getAttribute('aria-invalid'), 'true')
  assert.equal(await page.getByLabel('配置名称', { exact: true }).evaluate((element) => element === document.activeElement), true)
  await page.getByLabel('配置名称', { exact: true }).fill('更新工具配置')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  assert.equal(await page.getByLabel('配置名称', { exact: true }).getAttribute('aria-invalid'), null)

  const password = page.getByLabel('API Key', { exact: true })
  const passwordValue = await password.inputValue()
  await page.getByRole('button', { name: '显示 API Key', exact: true }).click()
  assert.equal(await password.getAttribute('type'), 'text')
  assert.equal(await password.inputValue(), passwordValue)
  await page.getByRole('button', { name: '隐藏 API Key', exact: true }).click()
  assert.equal(await password.getAttribute('type'), 'password')
  assert.equal(await page.getByLabel('部分工具已选中', { exact: true }).evaluate((element) => element.indeterminate), true)

  const overview = page.getByRole('tab', { name: '账号概览' })
  const usage = page.getByRole('tab', { name: '使用记录' })
  await overview.focus()
  await overview.press('ArrowRight')
  assert.equal(await usage.evaluate((element) => element === document.activeElement), true)
  assert.equal(await overview.getAttribute('aria-selected'), 'true')
  await usage.press('Enter')
  assert.equal(await usage.getAttribute('aria-selected'), 'true')
  await usage.press('ArrowRight')
  assert.equal(await page.getByRole('tab', { name: '登录设备' }).evaluate((element) => element === document.activeElement), true)
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await page.getByRole('group', { name: '记录筛选' }).getByRole('button', { name: '全部', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.getByRole('group', { name: '记录筛选' }).getByRole('button', { name: '最近', exact: true }).getAttribute('aria-pressed'), 'true')

  const motion = page.getByRole('switch', { name: '减少动画', exact: true })
  await motion.focus()
  await motion.press('Space')
  assert.equal(await motion.getAttribute('aria-checked'), 'true')
  await primary.click()
  assert.equal(await primary.locator('svg').evaluate((element) => getComputedStyle(element).animationName), 'none')
  await page.getByRole('button', { name: '重新检查', exact: true }).click()

  for (const theme of ['light', 'dark']) {
    await page.getByRole('group', { name: '明暗主题' }).getByRole('button', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click()
    for (const [skin, label] of [['dawn', '晨曦金'], ['obsidian', '极夜黑金'], ['mist', '雾青'], ['aurora', '极光紫']]) {
      await page.getByRole('button', { name: label, exact: true }).click()
      await primary.hover()
      await page.waitForTimeout(180)
      const measurements = await gallery.evaluate((element) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const context = canvas.getContext('2d')
        const rgb = (value) => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = value
          context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const luminance = (channels) => {
          const [r, g, b] = channels.slice(0, 3).map((value) => value / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
          return r * .2126 + g * .7152 + b * .0722
        }
        const contrast = (fg, bg) => {
          const a = luminance(rgb(fg)); const b = luminance(rgb(bg))
          return (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
        }
        const button = getComputedStyle(element.querySelector('[data-testid="gallery-primary"]'))
        const hint = getComputedStyle(element.querySelector('.ui-field-hint'))
        const root = getComputedStyle(element)
        const input = element.querySelector('.ui-input')
        return {
          primaryContrast: contrast(button.color, button.backgroundColor),
          hintContrast: contrast(hint.color, root.backgroundColor),
          bodyFont: root.fontSize,
          inputHeight: input.getBoundingClientRect().height,
          overflow: element.scrollWidth > element.clientWidth + 1,
        }
      })
      assert.ok(measurements.primaryContrast >= 4.5, `${theme}/${skin} primary ${measurements.primaryContrast}`)
      assert.ok(measurements.hintContrast >= 4.5, `${theme}/${skin} hint ${measurements.hintContrast}`)
      assert.equal(measurements.bodyFont, '14px')
      assert.equal(measurements.inputHeight, 36)
      assert.equal(measurements.overflow, false)
      results.push({ theme, skin, ...measurements })
      await gallery.evaluate((element) => { element.scrollTop = 0 })
      await page.screenshot({ path: path.join(outputDirectory, `${theme}-${skin}-1280.png`) })
    }
  }

  await page.getByRole('button', { name: '默认皮肤', exact: true }).click()
  assert.equal(await gallery.getAttribute('data-skin'), 'obsidian')
  for (const viewport of [{ width: 960, height: 560 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport)
    assert.equal(await gallery.evaluate((element) => element.scrollWidth > element.clientWidth + 1), false)
    await page.screenshot({ path: path.join(outputDirectory, `dark-obsidian-${viewport.width}.png`) })
  }
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(outputDirectory, 'results.json'), JSON.stringify({ interactions: 'passed', results }, null, 2), 'utf8')
  console.log(JSON.stringify({ interactions: 'passed', themes: results.length, screenshots: outputDirectory }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
