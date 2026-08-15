import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const executablePath = path.resolve(
  process.argv[2] || 'release/win-unpacked/星芒AI管理工具.exe',
)
const userDataDirectory = path.join(os.tmpdir(), `xingmang-packaged-smoke-${process.pid}`)

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// A cold Windows launch can spend up to 15 seconds on the fail-closed token
// probe before the packaged renderer and IPC initialization begin.
async function waitForRendererReady(child, timeoutMilliseconds = 40_000) {
  const deadline = Date.now() + timeoutMilliseconds
  const runtimeLog = path.join(userDataDirectory, 'logs', 'runtime.jsonl')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`生产程序提前退出，退出码：${child.exitCode}`)
    try {
      const log = await fs.readFile(runtimeLog, 'utf8')
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

await fs.rm(userDataDirectory, { recursive: true, force: true })
await fs.mkdir(userDataDirectory, { recursive: true })

const application = spawn(executablePath, [`--user-data-dir=${userDataDirectory}`], {
  stdio: 'ignore',
})

try {
  await waitForRendererReady(application)
  await delay(1_000)
  if (application.exitCode !== null) throw new Error('生产渲染页就绪后异常退出')
} finally {
  await stopProcess(application)
}

const debugAttempt = spawn(executablePath, [
  `--user-data-dir=${userDataDirectory}-debug`,
  '--remote-debugging-port=9222',
], {
  stdio: 'ignore',
})
const debugExitCode = await waitForExit(debugAttempt, 5_000)
if (debugExitCode === null) {
  await stopProcess(debugAttempt)
  throw new Error('生产程序没有拒绝远程调试参数')
}
if (debugExitCode === 0) throw new Error('生产程序拒绝远程调试参数时返回了成功退出码')

await fs.rm(userDataDirectory, { recursive: true, force: true })
await fs.rm(`${userDataDirectory}-debug`, { recursive: true, force: true })
console.log('生产程序启动校验通过：渲染页与 IPC 正常，远程调试参数已拒绝')
