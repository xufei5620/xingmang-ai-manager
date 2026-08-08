import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const stylesheetPath = path.resolve(testDirectory, '../src/styles.css')

const fixture = `
  <section class="maintenance-cli-section" data-testid="fixture">
    <div class="operations-list">
      <article class="operation-row maintenance-row" data-testid="row">
        <label class="maintenance-select"><input type="checkbox" aria-label="选择 Codex CLI"></label>
        <div class="operation-status-icon" aria-hidden="true"></div>
        <div class="operation-row-copy" data-testid="copy">
          <div class="operation-row-title"><strong>Codex CLI</strong></div>
          <p>当前 0.1.0 · 最新 0.2.0</p>
        </div>
        <div class="maintenance-row-actions" data-testid="actions">
          <button class="secondary-button" type="button">检查更新</button>
          <button class="secondary-button maintenance-uninstall-button" type="button">卸载帮助</button>
        </div>
      </article>
    </div>
  </section>
`

async function inspectLayout({ viewportWidth, fixtureWidth }) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 500 } })
    await page.setContent(fixture)
    await page.addStyleTag({ path: stylesheetPath })
    await page.locator('[data-testid="fixture"]').evaluate((element, width) => {
      element.style.width = `${width}px`
    }, fixtureWidth)

    return await page.locator('[data-testid="row"]').evaluate((row) => {
      const copy = row.querySelector('[data-testid="copy"]')
      const actions = row.querySelector('[data-testid="actions"]')
      const select = row.querySelector('.maintenance-select')
      const statusIcon = row.querySelector('.operation-status-icon')
      const buttons = actions?.querySelectorAll('button')
      if (!copy || !actions || !select || !statusIcon || !buttons || buttons.length !== 2) {
        throw new Error('Maintenance layout fixture is incomplete')
      }

      const rect = (element) => {
        const bounds = element.getBoundingClientRect()
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        }
      }
      const rowStyle = getComputedStyle(row)
      const actionsStyle = getComputedStyle(actions)

      return {
        row: rect(row),
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
    await browser.close()
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
