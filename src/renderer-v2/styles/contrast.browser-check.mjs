import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../e2e/harness.mjs'
import { openFixturePage, waitForFixtureMount } from '../../../e2e/fixture-readiness.mjs'

// Chromium's forced-colors emulation applies the same repaint a Windows high
// contrast theme does (system palette, no box-shadow, no gradient backgrounds,
// a backplate behind text), only with the Linux default palette. What it cannot
// show is how a particular Windows theme looks; that stays a manual check.

let server, browser, origin
before(async () => {
  ;({ server, origin } = await createFixtureServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error' }))
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open({ theme = 'light', forced = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  if (forced) await page.emulateMedia({ forcedColors: 'active' })
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await openFixturePage(page, `${origin}/src/renderer-v2/testing/app.html?theme=${theme}`,
    (timeout) => waitForFixtureMount(page, { timeout, what: 'the contrast fixture', ready: () => Boolean(window.v2Test) && Boolean(document.querySelector('.v2-nav-item')) }),
    { label: 'contrast fixture' })
  return page
}

// The fixture has no platform bridge, so the switch that would set these is
// shown as unsupported; set the root state exactly as platform-api.ts does.
// Reduced motion only switches off the 150ms transitions, so a computed style
// read right after the flip is the settled one.
async function highContrast(page) {
  await page.evaluate(() => {
    document.documentElement.dataset.reduceMotion = '1'
    document.documentElement.dataset.contrast = 'high'
    document.documentElement.classList.add('hc')
  })
}

async function style(locator, properties, pseudo = null) {
  return await locator.evaluate((element, [properties, pseudo]) => {
    const computed = getComputedStyle(element, pseudo)
    return Object.fromEntries(properties.map((property) => [property, computed.getPropertyValue(property)]))
  }, [properties, pseudo])
}

async function systemColor(page, keyword) {
  return await page.evaluate((keyword) => {
    const probe = document.createElement('span')
    probe.style.color = keyword
    document.body.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, keyword)
}

async function openSettings(page) {
  await page.getByTestId('nav-settings').click()
  await page.locator('.xm-switch').first().waitFor()
}

for (const theme of ['light', 'dark']) {
  test(`in-app high contrast (${theme}) swaps the whole palette, not just borders and secondary text`, async () => {
    const page = await open({ theme })
    try {
      const primary = page.locator('.xm-btn-primary').first()
      const before = await style(primary, ['background-image'])
      assert.match(before['background-image'], /gradient/, 'the normal primary button is a gradient')
      await highContrast(page)
      const tokens = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        return Object.fromEntries(['--text', '--panel', '--glow-top'].map((name) => [name, root.getPropertyValue(name).trim()]))
      })
      assert.equal(tokens['--text'], theme === 'dark' ? '#FFFFFF' : '#020A18')
      assert.match(tokens['--panel'], /^#[0-9A-F]{6}$/i, 'panels are opaque so text contrast does not depend on what sits beneath')
      assert.equal(tokens['--glow-top'], 'none')
      const after = await style(primary, ['background-image', 'box-shadow'])
      assert.equal(after['background-image'], 'none')
      assert.equal(after['box-shadow'], 'none')
      assert.equal(await page.locator('.v2-workspace-starfield').isVisible(), false)
      await openSettings(page)
      const track = await style(page.locator('.xm-switch').first(), ['border-top-width', 'border-top-style'], '::before')
      assert.deepEqual(track, { 'border-top-width': '2px', 'border-top-style': 'solid' })
      const active = await style(page.getByTestId('nav-settings'), ['box-shadow'])
      assert.match(active['box-shadow'], /inset/, 'the active page keeps a solid marker, not only a tint')
    } finally { await page.close() }
  })
}

test('Windows high contrast (forced colors) redraws selection, switches, progress and dialog edges with system colors', async () => {
  const page = await open({ theme: 'dark', forced: true })
  try {
    // The OS setting also turns the in-app switch on; forced colors must still win.
    await highContrast(page)
    const highlight = await systemColor(page, 'Highlight')
    const highlightText = await systemColor(page, 'HighlightText')
    const buttonText = await systemColor(page, 'ButtonText')

    const activeNav = page.getByTestId('nav-home')
    const nav = await style(activeNav, ['background-color', 'color', 'forced-color-adjust'])
    assert.equal(nav['background-color'], highlight, 'the current page is marked with the system selection color')
    assert.equal(nav.color, highlightText)
    // Without opting out, forced colors paints a Canvas backplate behind the label
    // and the HighlightText label disappears into it.
    assert.equal(nav['forced-color-adjust'], 'none')
    const label = await style(activeNav.locator('span').first(), ['color'])
    assert.equal(label.color, highlightText)

    const progress = await style(page.locator('.xm-progress-track').first(), ['outline-style'])
    assert.equal(progress['outline-style'], 'solid')
    const bar = await style(page.locator('.xm-progress-bar').first(), ['background-color'])
    assert.equal(bar['background-color'], highlight)
    const primary = await style(page.locator('.xm-btn-primary').first(), ['border-top-width', 'border-top-color'])
    assert.deepEqual(primary, { 'border-top-width': '2px', 'border-top-color': buttonText })

    await openSettings(page)
    const toggle = page.locator('.xm-switch').first()
    const track = await style(toggle, ['border-top-width', 'border-top-color'], '::before')
    assert.deepEqual(track, { 'border-top-width': '2px', 'border-top-color': buttonText })
    const thumb = await style(toggle.locator('i'), ['background-color'])
    assert.equal(thumb['background-color'], buttonText, 'the switch thumb stays visible')
    const segment = await style(page.locator('.xm-segment button.is-active').first(), ['background-color'])
    assert.equal(segment['background-color'], highlight)
    const select = await style(page.locator('.xm-field select').first(), ['appearance'])
    assert.equal(select.appearance, 'auto', 'the native arrow replaces the gradient one')

    await page.keyboard.press('Control+k')
    const dialog = page.locator('.xm-modal[open]').first()
    await dialog.waitFor()
    const edge = await style(dialog, ['border-top-width', 'border-top-style'])
    assert.deepEqual(edge, { 'border-top-width': '1px', 'border-top-style': 'solid' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  } finally { await page.close() }
})
