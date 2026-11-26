import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createBrowserFixture, projectRoot, withBrowserFixture } from './harness.mjs'

// U03（2026-10-28 审计）：浏览器起不来时，start 已经起好的
// Vite server 没人关，监听句柄让 node --test 的子进程一直不退出。前几条用假的 server 和
// 浏览器数每样各关了几次；最后一条起真的 Vite，看进程自己能不能退出，那才是客户（这里是
// CI）真正撞上的症状。

function recordingDependencies({ launchError, serverCloseError, browserCloseError } = {}) {
  const calls = { serversStarted: 0, serversClosed: 0, browsersLaunched: 0, browsersClosed: 0 }
  return {
    calls,
    dependencies: {
      async startServer() {
        calls.serversStarted += 1
        return {
          baseUrl: `http://127.0.0.1:${calls.serversStarted}`,
          server: {
            async close() {
              calls.serversClosed += 1
              if (serverCloseError) throw serverCloseError
            },
          },
        }
      },
      async launchBrowser() {
        calls.browsersLaunched += 1
        if (launchError) throw launchError
        return {
          async close() {
            calls.browsersClosed += 1
            if (browserCloseError) throw browserCloseError
          },
        }
      },
    },
  }
}

test('a browser that fails to launch closes the server it was started with exactly once', async () => {
  const launchError = new Error('Executable doesn\'t exist')
  const { calls, dependencies } = recordingDependencies({ launchError })
  const fixture = createBrowserFixture({}, dependencies)

  await assert.rejects(fixture.start(), (error) => error === launchError)
  assert.deepEqual(calls, { serversStarted: 1, serversClosed: 1, browsersLaunched: 1, browsersClosed: 0 })
  assert.throws(() => fixture.baseUrl, /was not started/)

  // The after() hook of a before/after suite still calls stop; there is nothing left to close.
  await fixture.stop()
  assert.equal(calls.serversClosed, 1)
})

test('withBrowserFixture does not run the test body when the browser fails to launch', async () => {
  const launchError = new Error('Executable doesn\'t exist')
  const { calls, dependencies } = recordingDependencies({ launchError })
  let bodyRuns = 0

  await assert.rejects(withBrowserFixture({}, async () => { bodyRuns += 1 }, dependencies), (error) => error === launchError)
  assert.equal(bodyRuns, 0)
  assert.deepEqual(calls, { serversStarted: 1, serversClosed: 1, browsersLaunched: 1, browsersClosed: 0 })
})

test('a server that also fails to close keeps the launch failure first', async () => {
  const launchError = new Error('Executable doesn\'t exist')
  const serverCloseError = new Error('close failed')
  const { calls, dependencies } = recordingDependencies({ launchError, serverCloseError })

  await assert.rejects(createBrowserFixture({}, dependencies).start(), (error) => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, [launchError, serverCloseError])
    return true
  })
  assert.equal(calls.serversClosed, 1)
})

test('a failing test body still closes the browser and the server', async () => {
  const bodyError = new Error('assertion failed')
  const { calls, dependencies } = recordingDependencies()

  await assert.rejects(withBrowserFixture({}, async () => { throw bodyError }, dependencies), (error) => error === bodyError)
  assert.deepEqual(calls, { serversStarted: 1, serversClosed: 1, browsersLaunched: 1, browsersClosed: 1 })
})

test('a browser that fails to close does not keep the server open', async () => {
  const browserCloseError = new Error('browser close failed')
  const { calls, dependencies } = recordingDependencies({ browserCloseError })
  const fixture = createBrowserFixture({}, dependencies)
  await fixture.start()

  await assert.rejects(fixture.stop(), (error) => error === browserCloseError)
  assert.equal(calls.serversClosed, 1)

  // A second stop must not close either of them again.
  await fixture.stop()
  assert.deepEqual(calls, { serversStarted: 1, serversClosed: 1, browsersLaunched: 1, browsersClosed: 1 })
})

test('repeated start and stop cycles leave nothing open', async () => {
  const { calls, dependencies } = recordingDependencies()
  const fixture = createBrowserFixture({}, dependencies)

  assert.equal(await fixture.start(), 'http://127.0.0.1:1')
  // Starting again before stop would orphan the first server and browser.
  await assert.rejects(fixture.start(), /already started/)
  await fixture.stop()
  await fixture.stop()
  assert.equal(await fixture.start(), 'http://127.0.0.1:2')
  await fixture.stop()

  assert.deepEqual(calls, { serversStarted: 2, serversClosed: 2, browsersLaunched: 2, browsersClosed: 2 })
})

// The real thing: a real Vite server, and a Chromium path that does not exist. Before
// U03 the child printed its marker and then sat on the listening socket forever.
test('a run whose browser cannot launch exits on its own instead of hanging on the dev server', async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-harness-'))
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const harnessUrl = pathToFileURL(path.join(projectRoot, 'e2e', 'harness.mjs')).href
  const script = [
    `import { createBrowserFixture } from ${JSON.stringify(harnessUrl)}`,
    'try {',
    `  await createBrowserFixture({ cacheDir: ${JSON.stringify(path.join(scratch, 'vite-cache'))} }).start()`,
    "  console.log('fixture-started')",
    '} catch {',
    "  console.log('fixture-start-failed')",
    '}',
  ].join('\n')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: { ...process.env, XINGMANG_E2E_CHROMIUM: path.join(scratch, 'missing-chromium') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const outcome = await new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let exitWatch
    // Getting the dev server up on a cold Windows runner can take a while; once start
    // has failed, though, there is nothing legitimate left for the process to wait on.
    const startWatch = setTimeout(() => { child.kill(); resolve({ hung: 'before start finished', stdout, stderr }) }, 120_000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (exitWatch || !stdout.includes('fixture-start')) return
      clearTimeout(startWatch)
      exitWatch = setTimeout(() => { child.kill(); resolve({ hung: 'after start failed', stdout, stderr }) }, 15_000)
    })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => {
      clearTimeout(startWatch)
      clearTimeout(exitWatch)
      resolve({ code, stdout, stderr })
    })
  })

  assert.equal(outcome.hung, undefined, `the child process was still alive ${outcome.hung}\n${outcome.stdout}\n${outcome.stderr}`)
  assert.match(outcome.stdout, /fixture-start-failed/, outcome.stderr)
  assert.equal(outcome.code, 0, outcome.stderr)
})
