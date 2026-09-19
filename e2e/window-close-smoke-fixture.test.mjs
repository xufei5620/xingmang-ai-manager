import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// The control loop under test is the bootFixture function inside
// e2e/window-close-smoke.mjs. That module cannot be imported: its top level
// launches Electron. It also cannot be copied here, because a copy would keep
// passing while the fixture the smoke actually injects regressed. So the real
// source text is lifted out and evaluated the same way the smoke evaluates it,
// against stubs that can refuse a write on demand.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const smokeSource = fs.readFileSync(path.join(root, 'e2e', 'window-close-smoke.mjs'), 'utf8')

function readBootFixtureSource() {
  const start = smokeSource.indexOf('function bootFixture(config) {')
  assert.ok(start >= 0, 'window-close-smoke.mjs must still inject a bootFixture')
  const end = smokeSource.indexOf('\n}\n', start)
  assert.ok(end > start, 'bootFixture must still be a top level declaration')
  return smokeSource.slice(start, end + 2)
}

function permissionDenied() {
  const error = new Error('EPERM: operation not permitted, rename')
  error.code = 'EPERM'
  return error
}

// Everything the fixture reaches for, reduced to what its control loop needs.
// The real filesystem backs the evidence and command files so the atomic swap
// is exercised for real; only the failures are injected.
function startFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-window-close-fixture-'))
  const evidence = path.join(workspace, 'main-process.json')
  const command = path.join(workspace, 'command.json')
  const userHome = path.join(workspace, 'home')
  fs.mkdirSync(userHome, { recursive: true })

  const refusals = { rename: 0, unlink: 0 }
  const closes = []
  const emitted = []
  const exits = []
  const fsStub = {
    existsSync: (target) => fs.existsSync(target),
    readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
    writeFileSync: (target, contents, encoding) => fs.writeFileSync(target, contents, encoding),
    unlinkSync: (target) => {
      if (refusals.unlink > 0) { refusals.unlink--; throw permissionDenied() }
      return fs.unlinkSync(target)
    },
    renameSync: (from, to) => {
      if (refusals.rename > 0) { refusals.rename--; throw permissionDenied() }
      return fs.renameSync(from, to)
    },
  }
  const window = { isVisible: () => true, close: () => closes.push(Date.now()) }
  const modules = {
    'node:fs': fsStub,
    'node:path': path,
    'node:os': { homedir: () => userHome },
    'node:http': {},
    'node:https': {},
    electron: {
      app: {
        setAppPath: () => undefined,
        setPath: () => undefined,
        getPath: () => path.join(workspace, 'user-data'),
        whenReady: () => Promise.resolve(),
        on: () => undefined,
        emit: (event) => emitted.push(event),
        getAppMetrics: () => [{ pid: 4242 }],
        exit: (code) => exits.push(code),
      },
      BrowserWindow: { getAllWindows: () => [window] },
      dialog: {},
      net: {},
      session: { defaultSession: { webRequest: { onBeforeRequest: () => undefined } } },
      shell: {},
    },
  }

  let tick = () => undefined
  const context = vm.createContext({
    require: (id) => modules[id] ?? {},
    setInterval: (callback) => { tick = callback; return { unref: () => undefined } },
  })
  const config = {
    userHome, userData: path.join(workspace, 'user-data'), projectRoot: root,
    evidence, command, entry: path.join(workspace, 'entry.js'),
  }
  vm.runInContext(`(${readBootFixtureSource()})(${JSON.stringify(config)})`, context)

  let actionId = 0
  return {
    refusals, closes, emitted, exits,
    tick: () => tick(),
    schedule: (action, extra = {}) => {
      const staged = `${command}.tmp`
      fs.writeFileSync(staged, JSON.stringify({ id: ++actionId, action, choice: null, blockQuit: false, ...extra }), 'utf8')
      fs.renameSync(staged, command)
    },
    readEvidence: () => {
      if (!fs.existsSync(evidence)) return null
      return JSON.parse(fs.readFileSync(evidence, 'utf8'))
    },
    commandPending: () => fs.existsSync(command),
  }
}

test('a transient evidence write failure neither drops the command nor its acknowledgement', () => {
  const fixture = startFixture()

  fixture.refusals.rename = 1
  fixture.schedule('close')
  fixture.tick()

  assert.equal(fixture.closes.length, 1, 'the close must run despite the refused swap')
  assert.equal(fixture.readEvidence()?.lastActionId, 1, 'the retried swap must publish the acknowledgement')
})

test('an evidence write that keeps failing still runs the command exactly once', () => {
  const fixture = startFixture()

  // Enough refusals to exhaust every retry of the write that follows the close.
  // This is the CI failure itself: the command file is already deleted, so a
  // write that throws past the action left it neither run nor acknowledged, and
  // the next tick found nothing to retry (#170).
  fixture.refusals.rename = 20
  fixture.schedule('close')
  fixture.tick()

  assert.equal(fixture.closes.length, 1, 'the close must run before the evidence is published')
  assert.equal(fixture.readEvidence(), null, 'nothing can be published while every swap is refused')

  fixture.refusals.rename = 0
  fixture.tick()

  const state = fixture.readEvidence()
  assert.equal(state?.lastActionId, 1, 'a later tick must republish the acknowledgement it could not write')
  assert.equal(fixture.closes.length, 1, 'republishing an acknowledgement must not replay its command')
  assert.ok(state.evidenceFailures.length > 0, 'the refused swap must be visible in the failure dump')
  assert.equal(state.commandLog.length, 1)
})

test('a command that could not be consumed is retried rather than lost', () => {
  const fixture = startFixture()

  fixture.refusals.unlink = 1
  fixture.schedule('activate')
  fixture.tick()

  assert.deepEqual(fixture.emitted, [], 'a command that is still on disk must not run yet')
  assert.ok(fixture.commandPending(), 'the command must stay on disk for the next tick')
  assert.ok(fixture.readEvidence()?.commandFailures.length > 0, 'the refusal must be recorded')

  fixture.tick()

  assert.deepEqual(fixture.emitted, ['activate'], 'the next tick must run the command exactly once')
  assert.equal(fixture.readEvidence()?.lastActionId, 1)
})
