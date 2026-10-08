import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { InstallCancellationRegistry, InstallCancelledError, isInstallCancelledError } from './install-cancellation'
import { createSystemService, finishClaudeInstallWithGit, type SystemServiceOptions } from './system-service'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

const integrity = `sha512-${Buffer.alloc(64, 0x31).toString('base64')}`

interface CommandSpecLike {
  executable: string
  argv: readonly string[]
}

interface CommandOptionsLike {
  cwd?: string
  signal?: AbortSignal
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/**
 * 装一个能跑到 `npm ci` 那一步的最小安装：依赖图解析立刻成功，下载这一步
 * 挂在取消信号上，模拟用户在真正漫长的那一段按下「取消」。
 */
function createCancellableInstallFixture() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-install-cancel-'))
  temporaryDirectories.push(temporaryRoot)
  const root = fs.realpathSync(temporaryRoot)
  const homeDirectory = path.join(root, 'home')
  const runtimeBin = path.join(homeDirectory, '.local', 'bin')
  fs.mkdirSync(runtimeBin, { recursive: true })
  vi.stubEnv('HOME', homeDirectory)
  // Linux 上托管目录跟着 XDG_DATA_HOME 走，不清掉会写进开发机真实的数据目录。
  vi.stubEnv('XDG_DATA_HOME', undefined)
  const npmExecutable = path.join(runtimeBin, 'npm')
  fs.writeFileSync(npmExecutable, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(npmExecutable, 0o700)

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
    const match = /\/(?:%40anthropic-ai%2F)?claude-code\/(.+)$/.exec(url)
    if (match) {
      const version = match[1] === 'latest' ? '2.1.300' : decodeURIComponent(match[1])
      return new Response(JSON.stringify({
        name: '@anthropic-ai/claude-code',
        version,
        dist: { integrity },
      }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))

  const downloadAttempts: string[] = []
  const downloadWaiters: Array<{ count: number, resolve: () => void }> = []
  // 等「第 N 次 npm ci 已经起来」这件事本身，而不是隔一段墙钟去轮询计数：
  // 从 installCli 到 npm ci 中间要过磁盘检查、建临时目录、写 package.json、
  // 生成并核对 lockfile 这一串真实文件 I/O，Windows runner 忙的时候一秒走不完
  // （PR #653 在 69ea566 上就是这样红的）。
  function downloadAttemptStarted(count: number): Promise<void> {
    if (downloadAttempts.length >= count) return Promise.resolve()
    const waiter = deferred<void>()
    downloadWaiters.push({ count, resolve: waiter.resolve })
    return waiter.promise
  }
  const runCommand = vi.fn(async (spec: CommandSpecLike, options: CommandOptionsLike = {}) => {
    if (spec.argv.includes('--package-lock-only')) {
      const cwd = options.cwd
      if (!cwd) throw new Error('Fake npm requires cwd')
      const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
        name: string
        version: string
        dependencies: Record<string, string>
      }
      const [[packageName, version]] = Object.entries(manifest.dependencies)
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        packages: {
          '': { dependencies: manifest.dependencies },
          [`node_modules/${packageName}`]: { version, integrity },
        },
      }))
    } else if (spec.argv[0] === 'ci') {
      const registry = spec.argv.find((argument) => argument.startsWith('--registry=')) ?? ''
      downloadAttempts.push(registry)
      for (const waiter of downloadWaiters) {
        if (downloadAttempts.length >= waiter.count) waiter.resolve()
      }
      // 真实的 npm ci 会跑好几分钟；这里只等取消信号，等到了就照 execFile
      // 被中止时的样子抛错。
      await new Promise((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('命令已被中止')), { once: true })
      })
    }
    return {
      executable: spec.executable,
      argv: [...spec.argv],
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputBytes: 0,
      durationMs: 1,
    }
  })

  const target = { isDestroyed: () => false, send: vi.fn() }
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      platform: 'linux',
      // installCliOperation 里有几处读的是真实的 process.platform，注入的 platform
      // 管不到它们。在 Windows runner 上跑到 trusted-only 分支就会去建机器级的
      // 托管 npm 目录、再落进受信任临时目录，这条路径和本文件要测的取消无关。
      // 钉成 same-user，三个平台走的都是同一段：mkdtemp + 注入的 runCommand。
      windowsExecutionMode: 'same-user',
      runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmExecutable : null),
    },
  )
  return { service, target, runCommand, downloadAttemptStarted, downloadAttempts }
}

describe('cancelling a CLI install', () => {
  it('reports that nothing is running when no install is in flight', () => {
    const { service } = createCancellableInstallFixture()
    const outcome = service.cancelCliInstall('claude')
    expect(outcome.cancelled).toBe(false)
    expect(outcome.reason).toContain('没有正在进行的安装')
  })

  // 这几条模拟 Linux 的安装会在 HOME 下建本软件的托管 npm 目录（Linux 版拆分 ②）；Windows
  // 主机上的 HOME 不是 POSIX 路径，建不出来，所以只在 macOS / Linux 主机上跑。
  it.runIf(process.platform !== 'win32')('aborts the running npm download and does not fall through to the mirror', async () => {
    const fixture = createCancellableInstallFixture()
    const install = fixture.service.installCli('claude', fixture.target)
    const settled = install.catch((error: unknown) => error)
    await fixture.downloadAttemptStarted(1)

    expect(fixture.service.cancelCliInstall('claude')).toEqual({ cancelled: true, reason: null })
    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('安装已取消')
    // 只试过一条源:取消要是只让它换一条镜像接着下,用户看到的还是「正在下载」。
    expect(fixture.downloadAttempts).toHaveLength(1)
    expect(fixture.target.send).toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ state: 'error', message: expect.stringContaining('安装已取消') }),
    )
  })

  it.runIf(process.platform !== 'win32')('stops tracking the install once it has finished unwinding', async () => {
    const fixture = createCancellableInstallFixture()
    const install = fixture.service.installCli('claude', fixture.target)
    const settled = install.catch(() => undefined)
    await fixture.downloadAttemptStarted(1)
    fixture.service.cancelCliInstall('claude')
    await settled

    const outcome = fixture.service.cancelCliInstall('claude')
    expect(outcome.cancelled).toBe(false)
    expect(outcome.reason).toContain('没有正在进行的安装')
  })

  it.runIf(process.platform !== 'win32')('lets a second install start after the cancelled one unwound', async () => {
    const fixture = createCancellableInstallFixture()
    const settled = fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    await fixture.downloadAttemptStarted(1)
    fixture.service.cancelCliInstall('claude')
    await settled

    const retry = fixture.service.installCli('claude', fixture.target).catch((error: unknown) => error)
    // 第二次能起来就说明登记表和 installing 集合都已经放开了。第二次要是
    // 在走到下载之前就失败了（比如还被当成「正在安装中」），立刻带着原因红，
    // 不要干等到用例超时。
    await Promise.race([
      fixture.downloadAttemptStarted(2),
      retry.then((outcome) => {
        // 走到下载之后被取消也会落到这里，那时不能再抛，否则就是一条没人接的拒绝。
        if (fixture.downloadAttempts.length >= 2) return
        throw new Error(`第二次安装没走到下载就结束了：${outcome instanceof Error ? outcome.message : String(outcome)}`)
      }),
    ])
    expect(fixture.downloadAttempts).toHaveLength(2)
    expect(fixture.service.cancelCliInstall('claude').cancelled).toBe(true)
    expect(((await retry) as Error).message).toContain('安装已取消')
  })

  it.runIf(process.platform !== 'win32')('takes an install still waiting behind another out at once and leaves the running one alone', async () => {
    const fixture = createCancellableInstallFixture()
    const running = fixture.service.installCli('claude', fixture.target).catch((error: unknown) => error)
    await fixture.downloadAttemptStarted(1)
    const queued = fixture.service.installCli('codex', fixture.target).then(() => 'installed', (error: unknown) => error)

    expect(fixture.service.cancelCliInstall('codex')).toEqual({ cancelled: true, reason: null })
    await new Promise<void>((resolve) => setImmediate(resolve))

    // Claude Code 还在下载，排在它后面的 Codex 已经出队、结束了，不用等它装完。
    const error = await Promise.race([queued, Promise.resolve('still waiting for the install ahead')])
    expect(isInstallCancelledError(error)).toBe(true)
    expect((error as Error).message).toBe('Codex CLI 安装已取消')
    expect(fixture.target.send).toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ provider: 'codex', state: 'error', message: 'Codex CLI 安装已取消' }),
    )
    expect(fixture.service.cancelCliInstall('codex').cancelled).toBe(false)
    expect(fixture.downloadAttempts).toHaveLength(1)

    expect(fixture.service.cancelCliInstall('claude')).toEqual({ cancelled: true, reason: null })
    expect(((await running) as Error).message).toContain('安装已取消')
    // 出队的那次一直没跑：前前后后只下过 Claude Code 那一次。
    expect(fixture.downloadAttempts).toHaveLength(1)
  })
})

// Windows 上装 Claude Code 时接着装 Git 的那一段（第四十批 C）。注入的 platform 管不到
// installCliOperation 里读真实 process.platform 的那几处，在 Linux / macOS 主机上走不通
// Windows 那条安装，所以这里只测「封住 → 装 Git → 收」这一段，三个平台都能跑。
describe('the Git step that follows a Claude Code install on Windows', () => {
  const key = 'cli:install:claude'

  it('refuses a cancel while Git is being installed and says the step can no longer be cancelled', async () => {
    const registry = new InstallCancellationRegistry()
    const cancellation = registry.begin(key)
    const gitStarted = deferred<void>()
    const git = deferred<void>()
    const finished = finishClaudeInstallWithGit(Promise.resolve(), cancellation, () => {
      gitStarted.resolve()
      return git.promise
    })
    await gitStarted.promise

    // 那一行还在写「正在安装 Git」：不能回「没有正在进行的安装」，也不能真把 Git 停掉。
    expect(registry.cancel(key)).toEqual({ cancelled: false, reason: '这一步已经不能取消了。' })
    expect(cancellation.cancelled).toBe(false)

    git.resolve()
    await finished
    expect(registry.activeKeys()).toEqual([])
    expect(registry.cancel(key).reason).toContain('没有正在进行的安装')
  })

  it('stops tracking the install once Git is over, even when the Git step throws', async () => {
    const registry = new InstallCancellationRegistry()
    const cancellation = registry.begin(key)
    const failure = new Error('Git 没装上')

    await expect(finishClaudeInstallWithGit(Promise.resolve(), cancellation, async () => { throw failure })).rejects.toBe(failure)
    expect(registry.activeKeys()).toEqual([])
  })

  it('lets Claude Code itself be cancelled as before, skips Git and stops tracking at once', async () => {
    const registry = new InstallCancellationRegistry()
    const cancellation = registry.begin(key)
    // 安装那一步看到取消信号，照真实的样子带着 InstallCancelledError 结束。
    const claude = new Promise<void>((_, reject) => {
      cancellation.signal.addEventListener('abort', () => reject(new InstallCancelledError('Claude Code 安装已取消')), { once: true })
    })
    const installGit = vi.fn(async () => undefined)
    const finished = finishClaudeInstallWithGit(claude, cancellation, installGit).catch((error: unknown) => error)

    expect(registry.cancel(key)).toEqual({ cancelled: true, reason: null })
    expect(isInstallCancelledError(await finished)).toBe(true)
    expect(installGit).not.toHaveBeenCalled()
    expect(registry.activeKeys()).toEqual([])
  })

  it('skips Git and stops tracking at once when Claude Code itself failed to install', async () => {
    const registry = new InstallCancellationRegistry()
    const cancellation = registry.begin(key)
    const failure = new Error('Claude Code 安装失败：npm 官方源：网络连接中断')
    const installGit = vi.fn(async () => undefined)

    await expect(finishClaudeInstallWithGit(Promise.reject(failure), cancellation, installGit)).rejects.toBe(failure)
    expect(installGit).not.toHaveBeenCalled()
    expect(registry.activeKeys()).toEqual([])
  })
})
