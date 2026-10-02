// Starts the application exactly as an installed .deb leaves it. First it reads
// the installed tree's owners and modes off the disk, then it checks the two
// things a package can get wrong without any file looking wrong: that it
// starts at all for an ordinary user (on Ubuntu 24.04 that needs the setuid
// chrome-sandbox postinst installs), and that it starts *sandboxed*. The
// predictable "fix" for a sandbox that will not come up is --no-sandbox, which
// would quietly strip the canvas window's isolation (AGENTS.md I15), so the
// verdict reads the renderer processes' seccomp state from /proc rather than
// trusting that the app came up.
//
// Run as the non-root runner user under a display server, after
// `apt-get install ./xingmang-ai-manager_<version>_<arch>.deb`:
//   xvfb-run -a node e2e/linux-deb-smoke.mjs /usr/bin/xingmang-ai-manager
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const executablePath = process.argv[2] || '/usr/bin/xingmang-ai-manager'
// A cold start on a shared runner, inside the step's own bound.
const readinessBudgetMs = Number(process.env.XINGMANG_LINUX_SMOKE_TIMEOUT_MS ?? 90_000)
const sandboxSwitches = /^--(?:no-sandbox|disable-gpu-sandbox|disable-setuid-sandbox)$/

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

if (process.platform !== 'linux') throw new Error('Linux 安装包冒烟只能在 Linux 上运行')
// Electron refuses to start as root without --no-sandbox, and a customer never
// runs it as root; passing here as root would prove nothing about either.
if (process.getuid() === 0) throw new Error('请用普通用户运行 Linux 安装包冒烟，root 下 Electron 必须关沙箱才能启动')

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-linux-smoke-'))
const userDataDirectory = path.join(temporaryRoot, 'user-data')
const isolatedHome = path.join(temporaryRoot, 'home')
const runtimeLogPath = path.join(userDataDirectory, 'logs', 'runtime.jsonl')

function readProcessTable() {
  const parents = new Map()
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // The command name sits in parentheses and may itself contain spaces or
      // parentheses, so the fields after it are read from the last ")".
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      parents.set(Number(name), Number(fields[1]))
    } catch {
      // The process exited between readdir and read.
    }
  }
  return parents
}

function descendantsOf(rootPid) {
  const parents = readProcessTable()
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const pid = queue.shift()
    found.push(pid)
    for (const [child, parent] of parents) if (parent === pid && !found.includes(child)) queue.push(child)
  }
  return found
}

function readCommandLine(pid) {
  try {
    // Zygote-forked children rewrite their title in place, so /proc shows one
    // space-separated string instead of NUL-separated arguments. Flags never
    // contain spaces, so splitting on both is enough to find them.
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0\s]+/).filter(Boolean)
  } catch {
    return null
  }
}

function readSeccompMode(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8')
  const match = /^Seccomp:\s*(\d+)$/m.exec(status)
  return match ? Number(match[1]) : null
}

// dpkg applies the owners and modes the package lists, then postinst changes
// exactly one of them. This reads the result off the disk rather than out of
// the .deb, because the installed tree is what a customer's machine runs:
// anything in it an ordinary user can rewrite is code that user gets to run
// in every later launch, and Linux has no signature check to notice.
function inspectInstallation(executable) {
  const installDirectory = path.dirname(realpathSync(executable))
  const offenders = []
  const pending = [installDirectory]
  let entryCount = 0
  while (pending.length > 0) {
    const current = pending.pop()
    const stats = lstatSync(current)
    entryCount += 1
    if (stats.uid !== 0 || stats.gid !== 0) offenders.push(`${current} 不归 root`)
    if (!stats.isSymbolicLink() && (stats.mode & 0o022) !== 0) offenders.push(`${current} 组或其他用户可写`)
    if (stats.isDirectory()) for (const name of readdirSync(current)) pending.push(path.join(current, name))
  }
  assert.deepEqual(offenders, [], `${installDirectory} 里有普通用户能改的东西`)
  const sandbox = statSync(path.join(installDirectory, 'chrome-sandbox'))
  assert.equal(sandbox.uid, 0, 'chrome-sandbox 不归 root')
  assert.equal(sandbox.mode & 0o7777, 0o4755, `chrome-sandbox 的权限是 ${(sandbox.mode & 0o7777).toString(8)}，安装脚本没把它设成 4755`)
  return { installDirectory, entryCount }
}

async function waitForRendererReady(child) {
  const deadline = Date.now() + readinessBudgetMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`安装后的程序提前退出（退出码 ${child.exitCode}，信号 ${child.signalCode}），多半是沙箱没装好`)
    }
    try {
      const log = await fs.readFile(runtimeLogPath, 'utf8')
      if (log.includes('"source":"renderer","event":"page.loaded"')) return
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await delay(250)
  }
  throw new Error(`等待渲染页就绪超时（${readinessBudgetMs} 毫秒）`)
}

function inspectSandbox(rootPid) {
  const processes = descendantsOf(rootPid)
    .map((pid) => ({ pid, argv: readCommandLine(pid) }))
    .filter((entry) => entry.argv !== null)
  const disabled = processes.filter((entry) => entry.argv.some((argument) => sandboxSwitches.test(argument)))
  assert.deepEqual(disabled.map((entry) => entry.argv.join(' ')), [], '有进程带着关闭沙箱的参数在跑')
  const renderers = processes.filter((entry) => entry.argv.includes('--type=renderer'))
  assert.ok(renderers.length > 0, `没找到渲染进程，进程树：${processes.map((entry) => entry.argv[0]).join('、')}`)
  for (const renderer of renderers) {
    // 2 = seccomp-bpf filter mode, which only Chromium's sandbox installs.
    assert.equal(readSeccompMode(renderer.pid), 2, `渲染进程 ${renderer.pid} 没有进沙箱（Seccomp 不是 2）`)
  }
  return { processCount: processes.length, rendererCount: renderers.length }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('close', resolve))
  child.kill('SIGTERM')
  if (await Promise.race([exited.then(() => true), delay(10_000).then(() => false)])) return
  child.kill('SIGKILL')
  await Promise.race([exited, delay(5_000)])
}

let application = null
let failure = null
let summary = null
const installation = inspectInstallation(executablePath)
try {
  await fs.mkdir(isolatedHome, { recursive: true })
  await fs.mkdir(userDataDirectory, { recursive: true })
  application = spawn(executablePath, [`--user-data-dir=${userDataDirectory}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOME: isolatedHome,
      XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
      XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
      XDG_CACHE_HOME: path.join(isolatedHome, '.cache'),
    },
  })
  let stderr = ''
  application.stderr.on('data', (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
  })
  try {
    await waitForRendererReady(application)
  } catch (error) {
    throw new Error(`${error.message}\n程序输出：\n${stderr.trim() || '（无）'}`)
  }
  // Give the canvas-less first window a moment; a sandbox failure in a late
  // child process kills the browser shortly after the first paint.
  await delay(2_000)
  assert.equal(application.exitCode, null, '安装后的程序在渲染页就绪后退出了')
  summary = inspectSandbox(application.pid)
} catch (error) {
  failure = error
} finally {
  if (application) await stopProcess(application)
  await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
}

if (failure) throw failure
console.log(`Linux 安装包冒烟通过：${installation.installDirectory} 下 ${installation.entryCount} 项全归 root 且只有 root 能改，chrome-sandbox 是 4755；${executablePath} 以普通用户启动，渲染页就绪，${summary.rendererCount} 个渲染进程全在沙箱里（共 ${summary.processCount} 个进程，无关沙箱参数）`)
