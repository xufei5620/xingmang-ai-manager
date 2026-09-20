// The macOS packaging gate verified signatures, entitlements, fuses, the
// update manifest and every artifact hash, and all of it was green on
// 2026-09-19 for a package that could not start: dyld refused to map the
// bundled Electron framework into a process signed without a team identifier
// and killed it before a line of the app's own code ran. Nothing that reads an
// artifact can see that, because the artifact is exactly right; only starting
// it can. So this is the one check in the macOS pipeline that runs the thing.
//
// It takes the directory `scripts/run-macos-free-build.cjs --ci-keep-package`
// leaves behind, or a path to a .app, extracts the ZIP for the host
// architecture and launches the packaged binary in an isolated HOME with its
// own user-data directory. A launch failure of this kind is immediate, so the
// verdict is: the process reported itself ready, or it was still alive when
// the budget ran out (pass), or it exited on its own (fail, with whatever dyld
// or the app printed on the way out).
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Long enough for a cold Electron start on a shared runner, and far inside the
// step bound so this script is what prints the diagnosis rather than the job
// being cancelled around it.
const launchBudgetMs = Number(process.env.XINGMANG_MACOS_LAUNCH_TIMEOUT_MS ?? 90_000)
// A dyld refusal happens before the app can open anything, so the process is
// gone within a second. Staying up this long without a ready signal means the
// bundle loaded and the app is merely slow, which is not what this asserts.
const aliveWithoutReadinessMs = Number(process.env.XINGMANG_MACOS_LAUNCH_ALIVE_MS ?? 25_000)
const maximumCapturedOutput = 64 * 1024

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function runCommand(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8', shell: false, maxBuffer: 4 * 1024 * 1024 })
  if (result.error) throw new Error(`无法运行 ${executable}：${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`${executable} 失败（退出码 ${result.status}）：${(result.stderr || '').trim()}`)
  }
  return result.stdout || ''
}

function hostArchitecture() {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`不支持在 ${process.arch} 上运行 macOS 启动冒烟`)
}

async function resolveApplicationBundle(target, temporaryRoot) {
  if (target.endsWith('.app')) return path.resolve(target)
  const directory = path.resolve(target)
  const architecture = hostArchitecture()
  const names = (await fs.readdir(directory))
    .filter((name) => name.endsWith(`-${architecture}.zip`))
  // A directory holding two ZIPs for one architecture, or none, means the
  // build did not produce what this smoke was pointed at; guessing would
  // launch something other than the artifact under test.
  if (names.length !== 1) {
    throw new Error(`${directory} 里必须恰好有一个 ${architecture} ZIP 产物，实际找到 ${names.length} 个`)
  }
  const extracted = path.join(temporaryRoot, 'bundle')
  await fs.mkdir(extracted, { recursive: true })
  runCommand('/usr/bin/ditto', ['-x', '-k', path.join(directory, names[0]), extracted])
  const applications = (await fs.readdir(extracted)).filter((name) => name.endsWith('.app'))
  if (applications.length !== 1) throw new Error(`${names[0]} 必须且只能解压出一个 .app`)
  return path.join(extracted, applications[0])
}

async function resolveApplicationExecutable(applicationPath) {
  const directory = path.join(applicationPath, 'Contents', 'MacOS')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const executables = entries.filter((entry) => entry.isFile())
  if (executables.length !== 1) throw new Error('应用必须包含唯一的主可执行文件')
  return path.join(directory, executables[0].name)
}

async function waitForReadyOrExit(child, runtimeLogPath, output) {
  const deadline = Date.now() + launchBudgetMs
  const aliveDeadline = Date.now() + aliveWithoutReadinessMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ready: false, exited: true }
    }
    try {
      const log = await fs.readFile(runtimeLogPath, 'utf8')
      if (log.includes('"source":"renderer","event":"page.loaded"')
        || log.includes('"source":"system","event":"scan.completed"')) {
        return { ready: true, exited: false }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (Date.now() >= aliveDeadline) return { ready: false, exited: false }
    await delay(250)
  }
  // Only reachable when the readiness deadline is configured shorter than the
  // whole budget; treat a live process the same way either way.
  return { ready: false, exited: child.exitCode !== null || child.signalCode !== null, output: output.text }
}

// Electron's helpers (renderer, GPU, utility, the Crashpad handler) are
// separate processes that keep writing into the user-data directory after the
// main process is gone. Signalling only the main process leaves them running,
// and the cleanup below then races them. The launch is spawned into its own
// process group so one signal reaches the whole tree.
function signalProcessTree(child, signal) {
  if (child.pid === undefined) return
  try { process.kill(-child.pid, signal) }
  catch (error) {
    // ESRCH means the group is already gone, which is the outcome we wanted.
    if (error?.code !== 'ESRCH') throw error
  }
}

async function stopApplication(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  signalProcessTree(child, 'SIGTERM')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return
    await delay(250)
  }
  signalProcessTree(child, 'SIGKILL')
}

// A helper that outlives its own SIGKILL by a few milliseconds can recreate a
// file inside a directory rm has already walked, and rm then fails the whole
// removal with ENOTEMPTY. That says nothing about the verdict this script
// exists to reach, so it is retried and, at worst, reported: the directory sits
// under the OS temp root, which the runner discards anyway.
async function removeTemporaryRoot(temporaryRoot) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') throw error
      if (attempt === 5) {
        process.stdout.write(`应用的子进程仍在写入，未能清理临时目录 ${temporaryRoot}（不影响本次判定）\n`)
        return
      }
      await delay(attempt * 500)
    }
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS 启动冒烟只能在 macOS 上运行')
  const version = require(path.resolve('package.json')).version
  const target = process.argv[2] || `release-free-ci-${version}`
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-macos-launch-'))
  const userDataDirectory = path.join(temporaryRoot, 'user-data')
  const isolatedHome = path.join(temporaryRoot, 'home')
  await fs.mkdir(isolatedHome, { recursive: true })
  const runtimeLogPath = path.join(userDataDirectory, 'logs', 'runtime.jsonl')

  const applicationPath = await resolveApplicationBundle(target, temporaryRoot)
  const executablePath = await resolveApplicationExecutable(applicationPath)
  // Printed rather than asserted: verify-macos-free-artifacts.cjs already
  // decides whether this signature and these entitlements go together. Here it
  // is the evidence that turns a failure into a diagnosis instead of a hunt.
  process.stdout.write(`${runCommand('/usr/bin/codesign', ['-d', '--verbose=4', applicationPath])}\n`)

  const output = { text: '' }
  const child = spawn(executablePath, [`--user-data-dir=${userDataDirectory}`], {
    env: { ...process.env, HOME: isolatedHome },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopApplication can reach every helper the app
    // starts. The group is always signalled explicitly below, so nothing is
    // left behind when this script exits.
    detached: true,
  })
  const capture = (chunk) => {
    if (output.text.length < maximumCapturedOutput) output.text += String(chunk)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)

  try {
    const result = await waitForReadyOrExit(child, runtimeLogPath, output)
    assert.equal(
      result.exited,
      false,
      `打包后的 macOS 应用启动即退出（退出码 ${child.exitCode}，信号 ${child.signalCode}）。`
        + `dyld 因 team identifier 不匹配拒绝加载 Electron 框架时就是这个现象。`
        + `进程输出：\n${output.text.trim() || '（无）'}`,
    )
    process.stdout.write(result.ready
      ? '打包后的 macOS 应用已启动并完成首屏加载\n'
      : `打包后的 macOS 应用启动后存活超过 ${Math.round(aliveWithoutReadinessMs / 1000)} 秒（未等到首屏事件）\n`)
  } finally {
    await stopApplication(child)
    await removeTemporaryRoot(temporaryRoot)
  }
}

await main()
