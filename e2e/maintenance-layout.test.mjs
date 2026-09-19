import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { fixtureReadyTimeoutMs } from './fixture-readiness.mjs'
import { createPageErrorCollector } from './page-errors.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pageErrors = createPageErrorCollector()
let server
let browser
let baseUrl

before(async () => {
  server = await createServer({ configFile: path.join(projectRoot, 'vite.config.ts'), root: projectRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  // Hosted CI installs the exact browser revision Playwright expects, but
  // ad-hoc containers (cloud agent sessions) often ship a different one and
  // fail the launch with "Executable doesn't exist". Honouring an explicit
  // executable keeps `npm test` runnable there; CI leaves the variable unset
  // and keeps using the managed download.
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close(); pageErrors.assertNone() })

// 量的是 MaintenancePage 真正渲染出来的那一行,而不是抄进测试的一份 markup 副本:
// 抄下来的副本在组件结构改掉之后照样能让这些断言全绿。
async function inspectLayout({ viewportWidth, fixtureWidth }) {
  const page = pageErrors.watch(await browser.newPage({ viewport: { width: viewportWidth, height: 500 } }))
  try {
    await page.goto(`${baseUrl}/e2e/maintenance-layout-fixture.html`)
    const row = page.locator('.maintenance-cli-section .maintenance-row').first()
    await row.waitFor({ timeout: fixtureReadyTimeoutMs })
    await page.locator('.maintenance-cli-section').evaluate((section, width) => {
      section.style.width = `${width}px`
      section.style.flex = '0 0 auto'
    }, fixtureWidth)

    return await row.evaluate((element) => {
      const copy = element.querySelector('.operation-row-copy')
      const actions = element.querySelector('.maintenance-row-actions')
      const select = element.querySelector('.maintenance-select')
      const statusIcon = element.querySelector('.operation-status-icon')
      const buttons = actions?.querySelectorAll('button')
      if (!copy || !actions || !select || !statusIcon || !buttons || buttons.length !== 2) {
        throw new Error('Maintenance row no longer has the select, status icon, copy and two action buttons this layout is about')
      }

      const rect = (target) => {
        const bounds = target.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        }
      }
      const rowStyle = getComputedStyle(element)
      const actionsStyle = getComputedStyle(actions)

      return {
        row: rect(element),
        copy: rect(copy),
        actions: rect(actions),
        select: rect(select),
        statusIcon: rect(statusIcon),
        firstButton: rect(buttons[0]),
        secondButton: rect(buttons[1]),
        gridTemplateColumns: rowStyle.gridTemplateColumns,
        justifyContent: actionsStyle.justifyContent,
        flexWrap: actionsStyle.flexWrap,
        statusIconDisplay: getComputedStyle(statusIcon).display,
      }
    })
  } finally {
    await page.close()
  }
}

function approximatelyEqual(actual, expected, tolerance = 1) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance}px of ${expected}`,
  )
}

test('Maintenance actions use the content column and wrap at narrow widths', async () => {
  const layout = await inspectLayout({ viewportWidth: 760, fixtureWidth: 220 })

  assert.equal(layout.gridTemplateColumns.split(/\s+/).length, 2)
  assert.equal(layout.statusIconDisplay, 'none')
  assert.equal(layout.justifyContent, 'flex-start')
  assert.equal(layout.flexWrap, 'wrap')
  approximatelyEqual(layout.actions.left, layout.copy.left)
  approximatelyEqual(layout.actions.right, layout.copy.right)
  assert.ok(layout.select.right <= layout.copy.left)
  assert.ok(layout.secondButton.top > layout.firstButton.top)
  assert.ok(layout.firstButton.right <= layout.actions.right + 1)
  assert.ok(layout.secondButton.right <= layout.actions.right + 1)
})

test('Maintenance rows retain four ordered columns above the narrow breakpoint', async () => {
  const layout = await inspectLayout({ viewportWidth: 1000, fixtureWidth: 760 })

  assert.equal(layout.gridTemplateColumns.split(/\s+/).length, 4)
  assert.notEqual(layout.statusIconDisplay, 'none')
  assert.ok(layout.select.left < layout.statusIcon.left)
  assert.ok(layout.statusIcon.left < layout.copy.left)
  assert.ok(layout.copy.right <= layout.actions.left)
  approximatelyEqual(layout.firstButton.top, layout.secondButton.top)
})
