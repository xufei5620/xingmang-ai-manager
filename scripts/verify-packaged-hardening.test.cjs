const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createPackage } = require('@electron/asar')
const { inspectPackagedLaunchBoundary } = require('./verify-packaged-hardening.cjs')

const currentLaunchBoundary = [
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
  'pwsh.exe',
  '系统 PowerShell 路径必须是绝对路径',
].join(' ')

async function createFixture(t, { service, elevation = currentLaunchBoundary }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-hardening-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'dist-electron'), { recursive: true })
  await fs.writeFile(path.join(root, 'dist-electron', 'system-service.js'), service, 'utf8')
  await fs.writeFile(path.join(root, 'dist-electron', 'windows-elevation.js'), elevation, 'utf8')
  const archive = path.join(root, 'app.asar')
  await createPackage(root, archive)
  return archive
}

test('rejects legacy bare PowerShell CLI launch sequences in packaged artifacts', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace); wt.exe -w new-tab powershell.exe -NoExit',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /旧的裸 powershell\.exe/)
})

test('rejects a packaged CLI launch that still requests RunAs', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchElevatedCliPowerShell(command, workspace)',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /管理员提权启动链/)
})

test('accepts the current absolute-path same-user launch boundary', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace)',
  })
  assert.doesNotThrow(() => inspectPackagedLaunchBoundary(archive))
})

test('rejects a packaged elevation module that lost absolute path resolution', async (t) => {
  const archive = await createFixture(t, {
    service: 'launchCliPowerShell(command, workspace)',
    elevation: 'spawn("powershell.exe")',
  })
  assert.throws(() => inspectPackagedLaunchBoundary(archive), /缺少绝对 PowerShell 路径解析/)
})
