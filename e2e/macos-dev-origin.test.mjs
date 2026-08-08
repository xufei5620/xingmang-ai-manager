import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { createServer, resolveConfig } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

test('the configured macOS development origin renders the real Electron app', {
  skip: process.platform !== 'darwin',
  timeout: 30_000,
}, async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const configuredUrl = packageJson.scripts.dev.match(/VITE_DEV_SERVER_URL=(https?:\/\/[^\s"]+)/)?.[1]
  assert.ok(configuredUrl, 'dev script must provide VITE_DEV_SERVER_URL')
  const configuredOrigin = new URL(configuredUrl)
  const viteConfig = await resolveConfig({ root: projectRoot, logLevel: 'silent' }, 'serve')
  assert.equal(configuredOrigin.hostname, '127.0.0.1')
  assert.equal(configuredOrigin.hostname, viteConfig.server.host)
  assert.equal(Number(configuredOrigin.port), viteConfig.server.port)
  assert.equal(viteConfig.server.strictPort, true)
  assert.ok(
    packageJson.scripts.dev.includes(`wait-on tcp:${configuredOrigin.host}`),
    'dev script must wait on the same origin that Electron loads',
  )

  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-dev-origin-test-'))
  const homeDirectory = path.join(stateRoot, 'home')
  const userDataDirectory = path.join(stateRoot, 'user-data')
  await fs.mkdir(homeDirectory, { recursive: true })

  let application
  let server
  try {
    server = await createServer({
      root: projectRoot,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: 5173, strictPort: false },
    })
    await server.listen()
    const address = server.httpServer?.address()
    assert.ok(address && typeof address !== 'string')

    const devUrl = new URL(configuredOrigin)
    devUrl.port = String(address.port)
    application = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDirectory}`],
      cwd: projectRoot,
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
        VITE_DEV_SERVER_URL: devUrl.origin,
        XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
      },
    })
    const page = await application.firstWindow({ timeout: 10_000 })
    const failedRequests = []
    page.on('requestfailed', (request) => {
      failedRequests.push({ url: request.url(), error: request.failure()?.errorText })
    })

    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 })
    try {
      await page.locator('.desktop-frame').waitFor({ state: 'visible', timeout: 5_000 })
    } catch {
      assert.fail(JSON.stringify(failedRequests))
    }
    assert.equal(new URL(page.url()).origin, devUrl.origin)
    const rootChildren = await page.locator('#root').evaluate((element) => element.childElementCount)
    assert.equal(rootChildren, 1)
  } finally {
    try {
      await application?.close()
    } finally {
      try {
        await server?.close()
      } finally {
        await fs.rm(stateRoot, { recursive: true, force: true })
      }
    }
  }
})

test('the configured development server refuses to reuse an occupied port', {
  skip: process.platform !== 'darwin',
  timeout: 15_000,
}, async () => {
  const config = await resolveConfig({ root: projectRoot, logLevel: 'silent' }, 'serve')
  const port = config.server.port
  const host = typeof config.server.host === 'string' ? config.server.host : '127.0.0.1'
  const blocker = net.createServer()
  let blockerListening = false
  let server

  try {
    try {
      await listen(blocker, { host, port })
      blockerListening = true
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }

    server = await createServer({ root: projectRoot, logLevel: 'silent' })
    await assert.rejects(server.listen(), /Port \d+ is already in use/)
  } finally {
    try {
      await server?.close()
    } finally {
      if (blockerListening) await close(blocker)
    }
  }
})
