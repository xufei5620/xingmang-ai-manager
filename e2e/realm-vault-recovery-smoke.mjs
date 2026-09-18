import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import electronPath from 'electron'

// Exercise native Windows safeStorage across real process/key lifetimes.
// No application entry, network client or BrowserWindow is loaded.
if (process.platform !== 'win32') {
  console.log('SKIP: native Windows safeStorage recovery smoke')
  process.exit(0)
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryRoot = path.resolve(os.tmpdir())
const sandbox = await fs.mkdtemp(path.join(temporaryRoot, 'xingmang-vault-recovery-'))
const userData = path.join(sandbox, 'user-data')
const bundle = path.join(sandbox, 'realm-account-vault-file.cjs')
const bootstrap = path.join(sandbox, 'bootstrap.cjs')
const expectedFile = path.join(sandbox, 'original-vault.bin')
const vaultFile = path.join(userData, 'realm-accounts-v2.dat')
const localState = path.join(userData, 'Local State')

function bootFixture(config) {
  const assert = require('node:assert/strict')
  const fs = require('node:fs')
  const path = require('node:path')
  const { app, safeStorage, BrowserWindow } = require('electron')
  const phase = process.env.XINGMANG_VAULT_SMOKE_PHASE
  const resultPath = path.join(config.sandbox, `result-${phase}.json`)
  let stage = 'isolate'
  const checks = []
  const check = (condition, label) => {
    assert.ok(condition, label)
    checks.push(label)
  }
  try {
    check(['seed', 'recover', 'restart'].includes(phase), 'valid phase')
    app.setPath('userData', config.userData)
    app.setPath('sessionData', config.userData)
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-background-networking')
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, phase, stage, error: error.name }), 'utf8')
    app.exit(1)
    return
  }
  app.whenReady().then(async () => {
    stage = 'native encryption availability'
    check(path.resolve(app.getPath('userData')) === config.userData, 'isolated userData')
    check(path.resolve(app.getPath('sessionData')) === config.userData, 'isolated sessionData')
    check(safeStorage.isEncryptionAvailable(), 'native encryption available')
    check(BrowserWindow.getAllWindows().length === 0, 'no windows created')
    const { createFileRealmAccountVault } = require(config.bundle)
    const recovered = []
    const vault = createFileRealmAccountVault(config.userData, safeStorage, {
      onRecovered: (name) => recovered.push(name),
    })
    const account = (userId) => ({ version: 2, realmId: 'xm-account', userId,
      origin: 'https://xm.solov.cc', username: 'native-recovery-fixture',
      credential: { kind: 'new-api', cookies: [`session=synthetic-fixture-${userId}`] } })
    const backups = () => fs.readdirSync(config.userData)
      .filter((name) => /^realm-accounts-v2\.dat\.unreadable-.*\.bak$/.test(name))
    const checkBackup = () => {
      const names = backups()
      check(names.length === 1, 'exactly one backup')
      check(fs.readFileSync(path.join(config.userData, names[0])).equals(fs.readFileSync(config.expectedFile)),
        'backup preserves exact original ciphertext')
    }
    if (phase === 'seed') {
      stage = 'initial native encrypted write'
      await vault.activate(account('7001'))
      check((await vault.active())?.userId === '7001', 'initial account decrypts')
      check(fs.readFileSync(config.vaultFile, 'utf8').length > 0, 'encrypted vault persisted')
      check(recovered.length === 0, 'initial write needs no recovery')
    } else if (phase === 'recover') {
      stage = 'old key mismatch'
      let failure
      try { await vault.active() } catch (error) { failure = error }
      check(failure?.code === 'STORAGE' && failure?.stage === 'decrypt', 'lost key causes decrypt failure')
      check(fs.readFileSync(config.vaultFile).equals(fs.readFileSync(config.expectedFile)), 'failed read preserves original')
      stage = 'native recovery'
      check(await vault.recoverUnreadable() === true, 'unreadable vault recovered')
      check(recovered.length === 1, 'recovery reported once')
      checkBackup()
      check(await vault.active() === null && (await vault.list()).length === 0, 'recovered vault is signed out')
      check(await vault.hasMigratedLegacy(), 'legacy migration remains complete')
      stage = 'new native encrypted write'
      await vault.activate(account('7002'))
      check((await vault.active())?.userId === '7002', 'new account decrypts')
    } else {
      stage = 'restart durability'
      const active = await vault.active()
      check(active?.userId === '7002', 'new account survives restart')
      check(active?.credential.kind === 'new-api'
        && active.credential.cookies[0] === account('7002').credential.cookies[0], 'new credential survives restart')
      check(await vault.hasMigratedLegacy(), 'migration marker survives restart')
      check(await vault.recoverUnreadable() === false, 'healthy vault needs no recovery')
      check(recovered.length === 0, 'restart does not trigger recovery')
      checkBackup()
    }
    fs.writeFileSync(resultPath, JSON.stringify({ ok: true, phase, checks }), 'utf8')
    // Graceful shutdown flushes Chromium Local State before the next process.
    app.quit()
  }).catch((error) => {
    // Native errors and assertion details are intentionally not logged.
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, phase, stage, error: error.name }), 'utf8')
    app.exit(1)
  })
}

async function run(phase) {
  const env = { ...process.env, XINGMANG_VAULT_SMOKE_PHASE: phase }
  delete env.ELECTRON_RUN_AS_NODE
  const resultPath = path.join(sandbox, `result-${phase}.json`)
  await new Promise((resolve, reject) => {
    const child = spawn(electronPath, [bootstrap, `--user-data-dir=${userData}`], {
      cwd: sandbox, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 25000)
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', async (code) => {
      clearTimeout(timer)
      if (timedOut) { reject(new Error(`${phase}: Electron exceeded 25 seconds`)); return }
      try {
        const result = JSON.parse(await fs.readFile(resultPath, 'utf8'))
        assert.ok(code === 0 && result.ok === true, `${phase}: ${result.stage ?? 'exit'} (${result.error ?? code})`)
        console.log(`PASS: ${phase} (${result.checks.length} checks)`)
        resolve()
      } catch (error) { reject(error) }
    })
  })
}

async function cleanup() {
  const resolved = path.resolve(sandbox)
  assert.equal(path.dirname(resolved), temporaryRoot, 'cleanup must stay in the allocated temporary parent')
  assert.ok(path.basename(resolved).startsWith('xingmang-vault-recovery-'), 'cleanup requires the fixture prefix')
  assert.equal(await fs.realpath(resolved), resolved, 'cleanup must not follow a replaced fixture directory')
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

try {
  await fs.mkdir(userData)
  await build({ entryPoints: [path.join(projectRoot, 'electron/realm-account-vault-file.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent' })
  await fs.writeFile(bootstrap, `(${bootFixture.toString()})(${JSON.stringify({ sandbox, userData, bundle, expectedFile, vaultFile })})\n`, 'utf8')
  await run('seed')
  const originalCiphertext = await fs.readFile(vaultFile)
  await fs.writeFile(expectedFile, originalCiphertext)
  // This file belongs only to the unique fixture. Keep its old key for the
  // entire smoke test while forcing Electron to create a different key.
  await fs.rename(localState, `${localState}.original`)
  await run('recover')
  await run('restart')
  assert.ok((await fs.stat(`${localState}.original`)).isFile(), 'original fixture Local State is preserved')
  console.log('PASS: native Windows safeStorage key-loss recovery and restart')
} finally {
  await cleanup()
}
