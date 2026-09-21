import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { openFixturePage } from './fixture-readiness.mjs'
import { createBrowserFixture } from './harness.mjs'

// 此前这个文件开 page 时不传 viewport，拿的是 Playwright 的 1280x720 默认值。
// 换成显式写出来，免得以后 harness 的默认视口一改就悄悄改了这里的布局断言。
const fixture = createBrowserFixture({ viewport: { width: 1280, height: 720 } })
let page
let row

before(async () => {
  await fixture.start()
  // 一个 page 走完整个文件，不按用例开。browser.newPage() 每次都新建一个
  // BrowserContext，HTTP 缓存是空的，整张模块图要从 Vite dev server 重新取一遍；
  // Windows runner 上好几个 e2e 文件并行跑时，第二次冷开连 90 秒都不够（quality
  // run 35423428733 实测：同一文件第一个用例 4.1 秒通过，第二个卡满 90 秒超时）。
  page = await fixture.newPage()
  row = page.locator('.maintenance-cli-section .maintenance-row').first()
  await openFixturePage(page, `${fixture.baseUrl}/e2e/maintenance-layout-fixture.html`,
    (timeout) => row.waitFor({ timeout }), { label: 'maintenance-layout fixture' })
})
after(async () => { await fixture.stop(); fixture.assertNoPageErrors() })

// 量的是 MaintenancePage 真正渲染出来的那一行,而不是抄进测试的一份 markup 副本:
// 抄下来的副本在组件结构改掉之后照样能让这些断言全绿。
//
// 复用同一个 page 是安全的：夹具纯展示，没有任何跟视口走的一次性副作用，
// 而每次量之前视口宽度与夹具宽度都会被显式重设，不会把上一个用例的状态带进来。
async function inspectLayout({ viewportWidth, fixtureWidth }) {
  // 窄屏布局由 styles.css 的 @media (max-width: 800px) 决定，所以这里改的是视口；
  // 夹具宽度是另一个变量，两者都要设。
  await page.setViewportSize({ width: viewportWidth, height: 500 })
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
