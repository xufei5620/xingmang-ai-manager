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
    const configReadsBefore = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length)
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfig'))
    await page.evaluate(() => window.v2Test.releaseConfigSave('临时模型服务故障'))
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    assert.equal((await launchCalls(page)).length, 1)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length), configReadsBefore)
    await settle(page)
  } finally { await page.close() }
})

test('a saved Codex model refreshes both the CLI and desktop summaries before launch', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => ({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => ['codex', 'codexDesktop'].every((id) =>
      document.querySelector(`[data-testid="tool-row-${id}"]`)?.textContent?.includes('gpt-6-astra')))
    const calls = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.ok(calls.lastIndexOf('getConfig') > calls.indexOf('saveConfig'))
    assert.ok(calls.lastIndexOf('getConfig') < calls.indexOf('launchCli'))
    await settle(page)
  } finally { await page.close() }
})

test('a swap initiated from Codex Desktop also refreshes the shared CLI model summary', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => ({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
    })
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    await page.waitForFunction(() => ['codex', 'codexDesktop'].every((id) =>
      document.querySelector(`[data-testid="tool-row-${id}"]`)?.textContent?.includes('gpt-6-astra')))
    await settle(page)
  } finally { await page.close() }
})

test('a failed post-save config read warns that the model saved but the summary is stale', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => ({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'getConfig' })
    await page.getByTestId('model-swap-confirm').click()
    await page.getByText(/模型已保存，但最新配置没有读到/).waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    assert.match(await page.getByTestId('tool-row-codex').innerText(), /fixture-model/)
    assert.equal(await page.getByText(/模型没换成，先照旧打开/).count(), 0)
    await settle(page)
  } finally { await page.close() }
})

test('a late model summary refresh from the previous account cannot overwrite the new account or launch', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.checkToolModels = async () => ({ status: 'unavailable', model: 'fixture-model', replacement: 'gpt-6-astra' })
    })
    await page.getByTestId('tool-codex-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.evaluate(() => {
      window.testAccount = 17
      const nativeRead = Object.getOwnPropertyDescriptor(window.xingmang, 'getConfig').value
      window.xingmang.getConfig = async () => {
        const accountAtRead = window.testAccount
        const config = await nativeRead()
        if (accountAtRead === 18) config.providers.codex.model = 'new-account-model'
        return config
      }
    })
    await page.evaluate(() => window.v2Test.holdNextConfigRead())
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfig'))
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length >= 2)
    await page.evaluate(() => { window.testAccount = 18 })
    await switchAccount(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-row-codex"]')?.textContent?.includes('new-account-model'))
    await page.evaluate(() => window.v2Test.releaseConfigRead())
    await settle(page)
    assert.match(await page.getByTestId('tool-row-codex').innerText(), /new-account-model/)
    assert.match(await page.getByTestId('tool-row-codexDesktop').innerText(), /new-account-model/)
    assert.deepEqual(await launchCalls(page), [])
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

test('a Codex Desktop already running on Windows still offers the restart prompt', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.getCodexDesktopStatus = async () => ({ running: true })
    })
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByRole('dialog', { name: 'Codex 已在运行' }).waitFor()
    await settle(page)
    assert.deepEqual(await launchCalls(page), [])
  } finally { await page.close() }
})

test('a Codex Desktop already running on a Mac comes to the front without the restart prompt it cannot honour', async () => {
  const page = await open('allInstalled=1&os=mac')
  try {
    await page.evaluate(() => {
      window.xingmang.getCodexDesktopStatus = async () => ({ running: true })
    })
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    await settle(page)
    assert.equal(await page.getByRole('dialog', { name: 'Codex 已在运行' }).count(), 0)
    assert.deepEqual((await launchCalls(page)).map((entry) => entry.args), [['open']])
  } finally { await page.close() }
})
