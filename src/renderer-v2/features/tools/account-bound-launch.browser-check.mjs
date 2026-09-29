import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { openFixturePage, waitForFixtureMount } from '../../../../e2e/fixture-readiness.mjs'

let server, origin, browser, root

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-account-bound-launch-'))
  const fixture = await createFixtureServer({
    root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error',
    cacheDir: path.join(root, 'vite-cache'),
    optimizeDeps: { entries: ['src/renderer-v2/testing/app.html'] },
    server: { fs: { allow: [path.resolve('.'), root] } },
  })
  server = fixture.server
  origin = fixture.origin
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})

after(async () => {
  await browser?.close()
  await server?.close()
  if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    await fs.rm(root, { recursive: true, force: true })
})

async function open(query = 'allInstalled=1') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await openFixturePage(page, `${origin}/src/renderer-v2/testing/app.html?${query}`,
    (timeout) => waitForFixtureMount(page, { timeout, what: 'account-bound launch fixture' }),
    { label: 'account-bound launch fixture' })
  await page.getByTestId('tool-row-codex').waitFor()
  return page
}

async function switchAccount(page) {
  await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', {
    authenticated: true, siteId: 'solov',
    account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 },
  }))
}

async function launchCalls(page) {
  return page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli' || entry.method === 'launchCodexDesktop'))
}

async function settle(page) {
  await page.waitForTimeout(100)
  assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
}

test('a config read from the previous account cannot start a CLI', async () => {
  const page = await open()
  try {
    await page.evaluate(() => window.v2Test.holdNextConfigRead())
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'getConfig'))
    await switchAccount(page)
    await page.evaluate(() => window.v2Test.releaseConfigRead())
    await settle(page)
    assert.deepEqual(await launchCalls(page), [])
  } finally { await page.close() }
})

test('a model check from the previous account cannot open the model question or a CLI', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => new Promise((resolve) => {
        window.releaseModelCheck = () => resolve({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
      })
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => typeof window.releaseModelCheck === 'function')
    await switchAccount(page)
    await page.evaluate(() => window.releaseModelCheck())
    await settle(page)
    assert.equal(await page.getByTestId('model-swap-question').count(), 0)
    assert.deepEqual(await launchCalls(page), [])
  } finally { await page.close() }
})

test('an account switch during model saving stops the old CLI launch even when saving fails', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => ({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
      window.v2Test.holdNextConfigSave()
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfig'))
    await switchAccount(page)
    await page.evaluate(() => window.v2Test.releaseConfigSave('账号已变化'))
    await settle(page)
    assert.deepEqual(await launchCalls(page), [])
  } finally { await page.close() }
})

test('an ordinary model-save failure still falls back to opening the same-account CLI', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => ({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
      window.v2Test.holdNextConfigSave()
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfig'))
    await page.evaluate(() => window.v2Test.releaseConfigSave('临时模型服务故障'))
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    assert.equal((await launchCalls(page)).length, 1)
    await settle(page)
  } finally { await page.close() }
})

test('a folder chosen after an account switch cannot start the old CLI launch', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.chooseWorkspace = async () => new Promise((resolve) => {
        window.releaseWorkspace = () => resolve('C:\\Selected Project')
      })
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => typeof window.releaseWorkspace === 'function')
    await switchAccount(page)
    await page.evaluate(() => window.releaseWorkspace())
    await settle(page)
    assert.deepEqual(await launchCalls(page), [])
  } finally { await page.close() }
})

test('a desktop status response from the previous account cannot show a restart prompt', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.getCodexDesktopStatus = async () => new Promise((resolve) => {
        window.releaseDesktopStatus = () => resolve({ running: true })
      })
    })
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.waitForFunction(() => typeof window.releaseDesktopStatus === 'function')
    await switchAccount(page)
    await page.evaluate(() => window.releaseDesktopStatus())
    await settle(page)
    assert.equal(await page.getByRole('dialog', { name: 'Codex 已在运行' }).count(), 0)
    assert.deepEqual(await launchCalls(page), [])
  } finally { await page.close() }
})
