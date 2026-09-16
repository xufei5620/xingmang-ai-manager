import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import TOML from '@iarna/toml'

const executablePath = path.resolve(
  process.argv[2] || 'release/win-unpacked/星芒AI管理工具.exe',
)
const temporaryRoot = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-packaged-smoke-')))
const userDataDirectory = path.join(temporaryRoot, 'user-data')
const isolatedHome = path.join(temporaryRoot, 'home')
const codexHome = path.join(isolatedHome, '.codex')
const runtimeLogPath = path.join(userDataDirectory, 'logs', 'runtime.jsonl')
const childEnvironment = { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome, CODEX_HOME: codexHome }
const configNames = ['config.toml', 'xingmang-config-chatgpt.toml', 'xingmang-config-relay.toml']
const oldLimits = 'model_context_window = 1000000\nmodel_auto_compact_token_limit = 900000\n'
const customConfig = '# packaged migration fixture\nmodel = "smoke-custom"\n[profiles.smoke]\nmodel_context_window = 128000\n'
const originalConfig = `${oldLimits}${customConfig}`

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// A cold Windows launch can spend up to 15 seconds on the fail-closed token
// probe before the packaged renderer and IPC initialization begin.
async function waitForRendererReady(child, logOffset, timeoutMilliseconds = 40_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`生产程序提前退出，退出码：${child.exitCode}`)
    try {
      const log = (await fs.readFile(runtimeLogPath, 'utf8')).slice(logOffset)
      if (
        log.includes('"source":"renderer","event":"page.loaded"')
        || log.includes('"source":"system","event":"scan.completed"')
      ) return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(250)
  }
  throw new Error('等待生产渲染页与 IPC 就绪超时')
}

async function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return child.exitCode
  return Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(timeoutMilliseconds).then(() => null),
  ])
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  child.kill()
  if (await waitForExit(child, 5_000) !== null) return

  const pid = Number(child.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`无效的测试进程 ID：${child.pid}`)
  if (!processIsRunning(pid)) return
  if (process.platform !== 'win32') {
    child.kill('SIGKILL')
    if (await waitForExit(child, 5_000) !== null || !processIsRunning(pid)) return
    throw new Error(`无法结束测试进程 ${pid}：SIGKILL 后仍在运行`)
  }
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
  const result = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    if (!processIsRunning(pid) || await waitForExit(child, 1_000) !== null) return
    const detail = result.error?.message || result.stderr?.toString().trim() || `exit ${result.status}`
    throw new Error(`无法结束测试进程 ${pid}：${detail}`)
  }
}

async function verifyFirstMigration() {
  const entries = await fs.readdir(codexHome)
  for (const name of configNames) {
    const content = await fs.readFile(path.join(codexHome, name), 'utf8')
    assert.deepEqual(TOML.parse(content), TOML.parse(customConfig), `${name} 首次启动未正确迁移或丢失自定义配置`)
    const backups = entries.filter((entry) => entry.startsWith(`${name}.bak.`))
    assert.equal(backups.length, 1, `${name} 没有保留唯一的原始备份`)
    assert.equal(await fs.readFile(path.join(codexHome, backups[0]), 'utf8'), originalConfig, `${name} 备份内容不完整`)
  }
}

async function verifyMigrationStaysCompleted() {
  const entries = await fs.readdir(codexHome)
  for (const name of configNames) {
    assert.equal(await fs.readFile(path.join(codexHome, name), 'utf8'), originalConfig, `${name} 第二次启动重复执行了迁移`)
    assert.equal(entries.filter((entry) => entry.startsWith(`${name}.bak.`)).length, 1, `${name} 第二次启动产生了多余备份`)
  }
}

let application = null
try {
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(userDataDirectory, { recursive: true })
  for (const name of configNames) await fs.writeFile(path.join(codexHome, name), originalConfig, 'utf8')

  for (const verify of [verifyFirstMigration, verifyMigrationStaysCompleted]) {
    let logOffset = 0
    try {
      logOffset = (await fs.readFile(runtimeLogPath, 'utf8')).length
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    application = spawn(executablePath, [`--user-data-dir=${userDataDirectory}`], {
      stdio: 'ignore',
      windowsHide: true,
      env: childEnvironment,
    })
    await waitForRendererReady(application, logOffset)
    await delay(1_000)
    if (application.exitCode !== null) throw new Error('生产渲染页就绪后异常退出')
    await verify()
    await stopProcess(application)
    application = null
    if (verify === verifyFirstMigration) {
      for (const name of configNames) await fs.writeFile(path.join(codexHome, name), originalConfig, 'utf8')
    }
  }

  application = spawn(executablePath, [
    `--user-data-dir=${path.join(temporaryRoot, 'user-data-debug')}`,
    '--remote-debugging-port=9222',
  ], {
    stdio: 'ignore',
    windowsHide: true,
    env: childEnvironment,
  })
  const debugExitCode = await waitForExit(application, 5_000)
  if (debugExitCode === null) throw new Error('生产程序没有拒绝远程调试参数')
  if (debugExitCode === 0) throw new Error('生产程序拒绝远程调试参数时返回了成功退出码')
  application = null
} finally {
  if (application) await stopProcess(application)
  if (path.dirname(temporaryRoot) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith('xingmang-packaged-smoke-')) {
    throw new Error('拒绝清理测试临时根目录以外的路径')
  }
  await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}
console.log('生产程序启动校验通过：渲染页与 IPC 正常，配置仅首次迁移并保留备份，远程调试参数已拒绝')
