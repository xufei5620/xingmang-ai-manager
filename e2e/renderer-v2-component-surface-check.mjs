import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
const require = createRequire(import.meta.url)
const reference = require('../ui-spec/work/reference-harness.cjs')
const artifactRoot = path.resolve('artifacts/renderer-v2-components/materials')
let server, browser
const comparisons = []
const equivalent = (left, right) => left === right || (/^-?\d+(?:\.\d+)?px$/.test(left) && /^-?\d+(?:\.\d+)?px$/.test(right) && Math.abs(parseFloat(left) - parseFloat(right)) <= 1 / 64)
try {
  await fs.mkdir(artifactRoot, { recursive: true })
  server = await createServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.route(/^https?:/, route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const source = await context.newPage(), actual = await context.newPage()
  source.setDefaultTimeout(30000); actual.setDefaultTimeout(30000)
  await source.setViewportSize({ width: 1460, height: 1080 })
  const style = (page, selector, properties) => page.locator(selector).first().evaluate((element, properties) => Object.fromEntries(properties.map(property => [property, getComputedStyle(element)[property]])), properties)
  const baseProps = ['backgroundImage', 'backgroundColor', 'borderRadius', 'boxShadow', 'color', 'fontWeight']
  for (const theme of ['light', 'dark']) {
    await reference.open(source); await reference.setPage(source, 'home', 'default', 'win', theme)
    await source.evaluate(() => {
      const specimen = document.createElement('section')
      specimen.id = 'material-reference'
      specimen.style.cssText = 'position:absolute;left:20px;top:150px;width:620px;padding:20px;background:var(--bg);z-index:100'
      specimen.innerHTML = '<div style="display:flex;gap:12px;margin-bottom:20px"><button id="ref-md" type="button" class="btn btn-primary">保存配置</button><button id="ref-sm" type="button" class="btn btn-primary sm">保存配置</button><button id="ref-xs" type="button" class="btn btn-primary xs">保存配置</button><button id="ref-secondary" type="button" class="btn btn-secondary">取消</button></div><div id="ref-card" class="card"><div class="card-head"><h2>当前配置</h2></div><div id="ref-card-body" class="card-body"><input id="ref-input" class="input" placeholder="配置名称"><div style="margin-top:16px"><span id="ref-pill" class="pill ok"><i></i>已配好</span></div></div></div>'
      document.getElementById('win').append(specimen)
    })
    await actual.goto(origin + '/src/renderer-v2/gallery.html?theme=' + theme)
    await actual.getByRole('heading', { name: '星芒 AI / 组件检阅' }).waitFor()
    const pairs = [
      ['primary-md', '#ref-md', '.xm-gallery-button-matrix .xm-btn-primary.xm-btn-md', [...baseProps, 'height', 'paddingLeft', 'fontSize']],
      ['primary-sm', '#ref-sm', '.xm-gallery-button-matrix .xm-btn-primary.xm-btn-sm', [...baseProps, 'height', 'paddingLeft', 'fontSize']],
      ['primary-xs', '#ref-xs', '.xm-gallery-button-matrix .xm-btn-primary.xm-btn-xs', [...baseProps, 'height', 'paddingLeft', 'fontSize']],
      ['secondary', '#ref-secondary', '.xm-gallery-button-matrix .xm-btn-secondary.xm-btn-md', [...baseProps, 'borderTopColor']],
      ['card', '#ref-card', '.xm-card', ['backgroundImage', 'backgroundColor', 'borderRadius', 'boxShadow', 'borderTopColor']],
      ['status-pill', '#ref-pill', '.xm-gallery-inline .xm-pill.xm-tone-ok', [...baseProps, 'borderTopColor', 'height']],
      ['field', '#ref-input', '[data-testid="gallery-name"]', ['backgroundColor', 'borderRadius', 'borderTopColor', 'height', 'paddingLeft']],
    ]
    for (const [component, ref, impl, properties] of pairs) {
      const expected = await style(source, ref, properties), observed = await style(actual, impl, properties)
      const differences = properties.filter(property => !equivalent(expected[property], observed[property])).map(property => ({ property, expected: expected[property], actual: observed[property] }))
      comparisons.push({ theme, component, expected, actual: observed, differences })
    }
    await source.locator('#ref-input').focus(); await actual.getByTestId('gallery-name').focus()
    await actual.waitForTimeout(180)
    const properties = ['borderTopColor', 'boxShadow', 'outlineStyle', 'outlineColor', 'outlineWidth', 'outlineOffset']
    const expected = await style(source, '#ref-input', properties), observed = await style(actual, '[data-testid="gallery-name"]', properties)
    comparisons.push({ theme, component: 'field-focus', expected, actual: observed, differences: properties.filter(property => !equivalent(expected[property], observed[property])).map(property => ({ property, expected: expected[property], actual: observed[property] })) })
    await source.locator('#material-reference').screenshot({ path: path.join(artifactRoot, 'prototype-' + theme + '.png') })
    await actual.locator('.xm-gallery-button-matrix').screenshot({ path: path.join(artifactRoot, 'implementation-buttons-' + theme + '.png') })
    await actual.locator('.xm-card').first().screenshot({ path: path.join(artifactRoot, 'implementation-card-' + theme + '.png') })
  }
  const differences = comparisons.flatMap(row => row.differences.map(difference => ({ theme: row.theme, component: row.component, ...difference })))
  const unresolved = differences
  await fs.writeFile(path.join(artifactRoot, 'comparison.json'), JSON.stringify({ source: reference.publicPrototype, sourceSha256: reference.hash(reference.publicPrototype), numericPixelTolerance: '1/64 CSS px to account for Chromium CSS zoom serialization; all color, gradient and shadow values compare exactly', comparisons, differences, unresolved }, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ comparisons: comparisons.length, differences, unresolved }, null, 2))
  assert.equal(unresolved.length, 0, 'Material properties differ from the canonical prototype')
} finally { await browser?.close(); await server?.close() }
