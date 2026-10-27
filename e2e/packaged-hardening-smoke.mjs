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

// 去掉不认识的开关后重新打开的那个进程不是这里起的子进程，只能按命令行里独有的临时
// 目录找到它。值经环境变量交给 PowerShell，不拼进脚本。
function findWindowsProcessesByCommandLine(fragment) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = 'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:XINGMANG_SMOKE_COMMAND_LINE) } | ForEach-Object { $_.ProcessId }'
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, XINGMANG_SMOKE_COMMAND_LINE: fragment },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`查不到测试进程：${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`)
  }
  return result.stdout.split(/\r?\n/).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid)
}

async function stopWindowsProcessesByCommandLine(fragment) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
  const deadline = Date.now() + 20_000
  for (;;) {
    const pids = findWindowsProcessesByCommandLine(fragment)
    if (pids.length === 0) return
    if (Date.now() > deadline) throw new Error(`无法结束测试进程 ${pids.join(', ')}`)
    // Already gone between the query and this call is fine; the next query decides.
    for (const pid of pids) spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    await delay(500)
  }
}

async function waitForLog(logPath, ready, description, timeoutMilliseconds = 40_000) {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    try {
      if (ready(await fs.readFile(logPath, 'utf8'))) return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(250)
  }
  throw new Error(`等待${description}超时`)
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

// 清理阶段的问题不能顶掉 try 里的真实失败原因。旧写法把清理失败直接 throw 在
// finally 里，「生产程序没有拒绝远程调试参数」这类真实断言失败会被清理异常替换掉，
// CI 日志里看到的是错误的根因。这里改成收集问题，只有在断言本身没挂时才由它们
// 决定退出码。
async function cleanUpPackagedFixture(child) {
  const problems = []
  if (child) {
    try {
      await stopProcess(child)
    } catch (error) {
      // 进程可能仍持有临时目录里的文件，此时不清理，保留现场供排查。
      problems.push(`${error?.message ?? error}，已保留临时目录`)
      return problems
    }
  }
  if (process.platform === 'win32') {
    try {
      await stopWindowsProcessesByCommandLine(temporaryRoot)
    } catch (error) {
      problems.push(`${error?.message ?? error}，已保留临时目录`)
      return problems
    }
  }
  if (path.dirname(temporaryRoot) !== path.resolve(os.tmpdir()) || !path.basename(temporaryRoot).startsWith('xingmang-packaged-smoke-')) {
    problems.push('拒绝清理测试临时根目录以外的路径')
    return problems
  }
  try {
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
  } catch (error) {
    problems.push(`清理测试临时目录失败：${error?.message ?? error}`)
  }
  return problems
}

let application = null
let failure = null
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

  // Chromium 把单短横线、Windows 上的斜杠也当开关读，换个写法不能绕过（#1065）。
  const debugSwitchSpellings = [
    '--remote-debugging-port=9222',
    '-remote-debugging-port=9222',
    ...(process.platform === 'win32' ? ['/remote-debugging-port=9222'] : []),
  ]
  for (const [index, spelling] of debugSwitchSpellings.entries()) {
    application = spawn(executablePath, [
      `--user-data-dir=${path.join(temporaryRoot, `user-data-debug-${index}`)}`,
      spelling,
    ], {
      stdio: 'ignore',
      windowsHide: true,
      env: childEnvironment,
    })
    const debugExitCode = await waitForExit(application, 5_000)
    if (debugExitCode === null) throw new Error(`生产程序没有拒绝远程调试参数 ${spelling}`)
    if (debugExitCode === 0) throw new Error(`生产程序拒绝远程调试参数 ${spelling} 时返回了成功退出码`)
    application = null
  }

  // Windows 打包版只认已知的启动参数：带了不认识的开关，去掉它重新打开一次，而不是
  // 打不开；重新打开的进程要是还带着，就直接退出，不会一直重开（#1065）。
  if (process.platform === 'win32') {
    const unknownSwitch = '--xingmang-smoke-unknown-switch'
    const relaunchDirectory = path.join(temporaryRoot, 'user-data-relaunch')
    application = spawn(executablePath, [`--user-data-dir=${relaunchDirectory}`, unknownSwitch], {
      stdio: 'ignore',
      windowsHide: true,
      env: childEnvironment,
    })
    const firstExitCode = await waitForExit(application, 15_000)
    if (firstExitCode === null) throw new Error('生产程序遇到不认识的启动参数时没有重新打开自己')
    if (firstExitCode !== 0) throw new Error(`生产程序遇到不认识的启动参数时退出码是 ${firstExitCode}，应当重新打开自己`)
    application = null
    // The relaunched process keeps --user-data-dir, so its log lands in this directory.
    await waitForLog(path.join(relaunchDirectory, 'logs', 'runtime.jsonl'), (log) => (
      log.includes('"event":"launch-arguments.relaunched"')
      && log.includes(`"${unknownSwitch.slice(2)}"`)
      && (log.includes('"source":"renderer","event":"page.loaded"') || log.includes('"source":"system","event":"scan.completed"'))
    ), '重新打开的生产程序渲染页就绪并记下去掉的开关')
    await stopWindowsProcessesByCommandLine(relaunchDirectory)

    const loopDirectory = path.join(temporaryRoot, 'user-data-relaunch-loop')
    application = spawn(executablePath, [`--user-data-dir=${loopDirectory}`, unknownSwitch], {
      stdio: 'ignore',
      windowsHide: true,
      // electron/launch-argument-relaunch.ts 的 launchArgumentRelaunchEnvironmentKey：
      // 假装这已经是重新打开的那一次。
      env: { ...childEnvironment, XINGMANG_RELAUNCHED_WITHOUT_SWITCHES: unknownSwitch.slice(2) },
    })
    const loopExitCode = await waitForExit(application, 15_000)
    if (loopExitCode === null) throw new Error('重新打开的进程还带着不认识的启动参数，却没有退出')
    if (loopExitCode === 0) throw new Error('重新打开的进程还带着不认识的启动参数，却又重新打开了一次')
    application = null
    await delay(3_000)
    await assert.rejects(fs.access(path.join(loopDirectory, 'logs', 'runtime.jsonl')), '重新打开的进程还带着不认识的启动参数，却打开了桌面')
  }
} catch (error) {
  failure = error
}

const cleanupProblems = await cleanUpPackagedFixture(application)
for (const problem of cleanupProblems) console.error(`生产程序启动校验清理阶段问题：${problem}`)
if (failure) throw failure
if (cleanupProblems.length > 0) throw new Error(cleanupProblems.join('；'))

console.log(`生产程序启动校验通过：渲染页与 IPC 正常，配置仅首次迁移并保留备份，远程调试参数已拒绝${process.platform === 'win32' ? '，不认识的启动参数去掉后重新打开' : ''}`)
