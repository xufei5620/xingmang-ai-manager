import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyOperationError } from '../src/renderer-v2/operation-error'
import { AppSettingsStore } from './app-settings'
import { CommandRunnerError } from './command-runner'
import {
  createNpmDownloadStallWatch,
  createSystemService,
  measureDirectoryBytes,
  npmDownloadCeilingMs,
  npmDownloadProgressCheckMs,
  npmDownloadStallTimeoutMs,
  npmDownloadTimeoutMs,
  npmResolutionTimeoutMs,
  type SystemServiceOptions,
} from './system-service'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  while (temporaryDirectories.length) {
    const directory = temporaryDirectories.pop()
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
  }
})

const integrity = `sha512-${Buffer.alloc(64, 0x37).toString('base64')}`
const officialRegistry = 'https://registry.npmjs.org'
const mirrorRegistry = 'https://registry.npmmirror.com'
const timedOutDetail = '下载超时，长时间没有完成，已中止'

function temporaryDirectory(prefix: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  temporaryDirectories.push(directory)
  return directory
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

/** 另起一个进程开着文件往里写：先写一块，stdin 每来一行再写一块，stdin 关了才关文件。 */
const growingFileWriter = `
const fs = require('node:fs')
const fd = fs.openSync(process.argv[1], 'w')
let blocks = 0
function grow() {
  fs.writeSync(fd, Buffer.alloc(65536, 97))
  blocks += 1
  process.stdout.write(blocks + '\\n')
}
grow()
process.stdin.on('data', grow)
process.stdin.on('end', () => {
  fs.closeSync(fd)
  process.exit(0)
})
`

function writerOutput(writer: ChildProcess, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    function onData(chunk: Buffer): void {
      output += chunk.toString('utf8')
      if (!output.split('\n').includes(line)) return
      writer.stdout?.off('data', onData)
      writer.off('exit', onExit)
      resolve()
    }
    function onExit(code: number | null): void {
      writer.stdout?.off('data', onData)
      reject(new Error(`写文件的进程提前退出了（${code}）`))
    }
    writer.stdout?.on('data', onData)
    writer.once('exit', onExit)
  })
}

// 只拨 setInterval 和单调时钟：安装流程里其余的计时器（取地区、读盘超时）照真实时间走，
// 假时钟拨几分钟也不会把它们一起触发。
function useWatchClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
}

describe('npm download stall constants', () => {
  it('ends a download only after three minutes without any change', () => {
    expect(npmDownloadStallTimeoutMs).toBe(3 * 60_000)
    // A stuck download used to cost the full five minutes before the next registry was tried.
    expect(npmDownloadStallTimeoutMs).toBeLessThan(npmDownloadTimeoutMs)
  })

  it('lets a download that keeps moving run for up to half an hour', () => {
    expect(npmDownloadCeilingMs).toBe(30 * 60_000)
    // Codex for Windows is ~160 MB: at 0.1 MB/s that is ~27 minutes, still inside the ceiling.
    expect(npmDownloadCeilingMs).toBeGreaterThan(npmResolutionTimeoutMs)
  })

  it('looks at the download every fifteen seconds, many times within one stall window', () => {
    expect(npmDownloadProgressCheckMs).toBe(15_000)
    // One quiet check never decides alone; it takes a dozen in a row.
    expect(npmDownloadStallTimeoutMs / npmDownloadProgressCheckMs).toBeGreaterThanOrEqual(10)
  })
})

describe('measureDirectoryBytes', () => {
  it('adds up every file below the directory', async () => {
    const root = temporaryDirectory('xingmang-measure-bytes-')
    fs.mkdirSync(path.join(root, 'cache', '_cacache', 'tmp'), { recursive: true })
    fs.mkdirSync(path.join(root, 'resolution', 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(root, 'cache', '_cacache', 'tmp', 'partial'), Buffer.alloc(1_500))
    fs.writeFileSync(path.join(root, 'resolution', 'package.json'), Buffer.alloc(20))
    fs.writeFileSync(path.join(root, 'resolution', 'node_modules', 'pkg', 'index.js'), Buffer.alloc(300))

    await expect(measureDirectoryBytes(root)).resolves.toBe(1_820)
  })

  it('rejects when it cannot read the directory itself instead of reporting zero', async () => {
    // A reading stuck at zero would look exactly like a download that stopped moving.
    const root = temporaryDirectory('xingmang-measure-missing-')
    await expect(measureDirectoryBytes(path.join(root, 'attempt-0'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not follow links or junctions out of the directory', async () => {
    const root = temporaryDirectory('xingmang-measure-links-')
    const outside = temporaryDirectory('xingmang-measure-outside-')
    fs.writeFileSync(path.join(outside, 'large'), Buffer.alloc(50_000))
    fs.mkdirSync(path.join(root, 'attempt'))
    fs.writeFileSync(path.join(root, 'attempt', 'own'), Buffer.alloc(10))
    // Windows 上普通权限建得了目录联接，建不了文件符号链接。
    fs.symlinkSync(outside, path.join(root, 'attempt', 'folder-link'), 'junction')
    if (process.platform !== 'win32') fs.symlinkSync(path.join(outside, 'large'), path.join(root, 'attempt', 'file-link'))

    await expect(measureDirectoryBytes(path.join(root, 'attempt'))).resolves.toBe(10)
  })

  it('sees a file grow while another process still has it open', async () => {
    // npm 下载时，缓存里的临时文件一直开着、边下边长，到下完才关。Windows 上文件夹列表里记的
    // 大小要等关了才更新，所以这里要量到的是文件此刻真正的大小。
    const root = temporaryDirectory('xingmang-measure-open-')
    const partial = path.join(root, 'cache', '_cacache', 'tmp', 'partial')
    fs.mkdirSync(path.dirname(partial), { recursive: true })
    const writer = spawn(process.execPath, ['-e', growingFileWriter, partial], { stdio: ['pipe', 'pipe', 'inherit'] })
    try {
      await writerOutput(writer, '1')
      await expect(measureDirectoryBytes(root)).resolves.toBe(64 * 1024)
      const second = writerOutput(writer, '2')
      writer.stdin?.write('more\n')
      await second
      await expect(measureDirectoryBytes(root)).resolves.toBe(2 * 64 * 1024)
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) {
        const exited = new Promise<void>((resolve) => writer.once('exit', () => resolve()))
        writer.stdin?.end()
        await exited
      }
    }
  })
})

describe('createNpmDownloadStallWatch', () => {
  it('fires once the size has not changed for the stall window, and not a moment earlier', async () => {
    useWatchClock()
    const measure = vi.fn(async () => 4_096)
    const watch = createNpmDownloadStallWatch(measure)

    await vi.advanceTimersByTimeAsync(npmDownloadStallTimeoutMs - 1)
    expect(watch.signal.aborted).toBe(false)
    expect(watch.stalled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(watch.signal.aborted).toBe(true)
    expect(watch.stalled).toBe(true)
    expect(watch.bytes).toBe(4_096)
    expect((watch.signal.reason as Error).message).toBe(timedOutDetail)

    // Once fired it stops measuring.
    const calls = measure.mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(measure.mock.calls.length).toBe(calls)
  })

  it('keeps waiting on a download that is still moving, however slowly', async () => {
    useWatchClock()
    let bytes = 0
    // One byte per check: as slow as a download can be while still moving.
    const watch = createNpmDownloadStallWatch(async () => ++bytes)

    await vi.advanceTimersByTimeAsync(npmDownloadCeilingMs)
    expect(watch.signal.aborted).toBe(false)
    expect(watch.stalled).toBe(false)
    watch.stop()
  })

  it('counts the stall window from the last change, a shrink included', async () => {
    useWatchClock()
    // Grows for 10 checks, then npm drops a broken partial download before its own retry
    // (the directory shrinks), then nothing moves.
    const sizes = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000, 1_100, 40]
    let calls = 0
    const watch = createNpmDownloadStallWatch(async () => sizes[Math.min(calls++, sizes.length - 1)])
    const lastChangeAt = (sizes.length - 1) * npmDownloadProgressCheckMs

    await vi.advanceTimersByTimeAsync(lastChangeAt + npmDownloadStallTimeoutMs - 1)
    expect(watch.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(watch.signal.aborted).toBe(true)
    expect(watch.bytes).toBe(40)
  })

  it('never ends a download it could not measure', async () => {
    useWatchClock()
    const watch = createNpmDownloadStallWatch(async () => { throw new Error('EACCES') })

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(watch.signal.aborted).toBe(false)
    watch.stop()
  })

  it('does not read a measurement that is slow to finish as a stall', async () => {
    useWatchClock()
    const slow = deferred<number>()
    const measure = vi.fn()
      .mockImplementationOnce(() => slow.promise)
      .mockImplementation(async () => 2_048)
    const watch = createNpmDownloadStallWatch(measure)

    // The first walk takes four minutes (a busy disk); the checks in between are skipped
    // rather than stacked on top of it.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(measure).toHaveBeenCalledTimes(1)
    slow.resolve(1_024)
    await vi.advanceTimersByTimeAsync(0)
    expect(watch.signal.aborted).toBe(false)

    // The next check sees a different size: still moving.
    await vi.advanceTimersByTimeAsync(npmDownloadProgressCheckMs)
    expect(measure).toHaveBeenCalledTimes(2)
    expect(watch.signal.aborted).toBe(false)
    watch.stop()
  })

  it('stays quiet once stopped', async () => {
    useWatchClock()
    const measure = vi.fn(async () => 1)
    const watch = createNpmDownloadStallWatch(measure)
    await vi.advanceTimersByTimeAsync(npmDownloadProgressCheckMs)
    watch.stop()
    const calls = measure.mock.calls.length

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(measure.mock.calls.length).toBe(calls)
    expect(watch.signal.aborted).toBe(false)
    expect(watch.stalled).toBe(false)
  })
})

interface CommandSpecLike {
  executable: string
  argv: readonly string[]
}

interface CommandOptionsLike {
  cwd?: string
  signal?: AbortSignal
  timeoutMs?: number
}

interface DownloadAttempt {
  registry: string
  cache: string
  timeoutMs: number | undefined
  startedAt: number
  abortedAt: number | null
  /** 这一次 npm ci 起来的时候，事务目录里还有哪几轮的临时目录。 */
  attemptDirectories: string[]
}

function abortedCommand(spec: CommandSpecLike): CommandRunnerError {
  return new CommandRunnerError('命令已取消：node', {
    code: 'ABORTED',
    executable: spec.executable,
    argv: [...spec.argv],
    exitCode: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
    outputBytes: 0,
    maxOutputBytes: 8 * 1024 * 1024,
    durationMs: 1,
  })
}

/**
 * 能跑到 `npm ci` 的最小安装（同 install-cancel 那份）：依赖图立刻解析好，npm ci 要么一直
 * 不结束、直到它收到的信号停下它（下得动下不动由测试往缓存目录里写字节决定），要么立刻
 * 成功、后面「装到本机」那一步失败，用来看那一步拿到的时长。
 */
function createDownloadFixture(downloadBehavior: 'hang' | 'succeed') {
  const root = temporaryDirectory('xingmang-download-stall-')
  const homeDirectory = path.join(root, 'home')
  const runtimeBin = path.join(homeDirectory, '.local', 'bin')
  fs.mkdirSync(runtimeBin, { recursive: true })
  vi.stubEnv('HOME', homeDirectory)
  // Linux 上托管目录跟着 XDG_DATA_HOME 走，不清掉会写进开发机真实的数据目录。
  vi.stubEnv('XDG_DATA_HOME', undefined)
  vi.stubEnv('npm_config_prefix', undefined)
  vi.stubEnv('npm_config_userconfig', undefined)
  const npmExecutable = path.join(runtimeBin, 'npm')
  fs.writeFileSync(npmExecutable, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(npmExecutable, 0o700)

  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
    const match = /\/(?:%40anthropic-ai%2F)?claude-code\/(.+)$/.exec(url)
    if (match) {
      const version = match[1] === 'latest' ? '2.1.300' : decodeURIComponent(match[1])
      return new Response(JSON.stringify({ name: '@anthropic-ai/claude-code', version, dist: { integrity } }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))

  const downloads: DownloadAttempt[] = []
  const offlineInstalls: CommandOptionsLike[] = []
  const waiters: Array<{ count: number, resolve: () => void }> = []
  // 等「第 N 次 npm ci 已经起来」这件事本身，不隔一段墙钟去轮询（同 install-cancel 的理由）。
  function downloadStarted(count: number): Promise<void> {
    if (downloads.length >= count) return Promise.resolve()
    const waiter = deferred<void>()
    waiters.push({ count, resolve: waiter.resolve })
    return waiter.promise
  }
  const runCommand = vi.fn(async (spec: CommandSpecLike, options: CommandOptionsLike = {}) => {
    if (spec.executable !== npmExecutable) throw new Error(`Unexpected command: ${spec.executable}`)
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
      const cache = spec.argv.find((argument) => argument.startsWith('--cache='))?.slice('--cache='.length)
      if (!cache) throw new Error('npm ci ran without its own cache')
      const transaction = path.dirname(path.dirname(cache))
      const attempt: DownloadAttempt = {
        registry: spec.argv.find((argument) => argument.startsWith('--registry='))?.slice('--registry='.length) ?? '',
        cache,
        timeoutMs: options.timeoutMs,
        startedAt: performance.now(),
        abortedAt: null,
        attemptDirectories: fs.readdirSync(transaction).filter((name) => name.startsWith('attempt-')).sort(),
      }
      downloads.push(attempt)
      for (const waiter of waiters) {
        if (downloads.length >= waiter.count) waiter.resolve()
      }
      if (downloadBehavior === 'hang') {
        // 照命令运行器被信号中止时的样子抛错；是客户取消还是卡住被掐，由安装流程自己分辨。
        await new Promise((_, reject) => {
          const abort = () => {
            attempt.abortedAt = performance.now()
            reject(abortedCommand(spec))
          }
          if (options.signal?.aborted) abort()
          else options.signal?.addEventListener('abort', abort, { once: true })
        })
      }
    } else if (spec.argv.includes('--offline')) {
      offlineInstalls.push(options)
      throw new CommandRunnerError('命令执行失败（退出码 1）：node', {
        code: 'EXIT_NON_ZERO',
        executable: spec.executable,
        argv: [...spec.argv],
        exitCode: 1,
        signal: null,
        stdout: '',
        stderr: 'npm error code E500\n',
        outputBytes: 0,
        maxOutputBytes: 8 * 1024 * 1024,
        durationMs: 1,
      })
    } else {
      throw new Error(`Unexpected npm command: ${spec.argv.join(' ')}`)
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

  const runtimeLog = { log: vi.fn() }
  const target = { isDestroyed: () => false, send: vi.fn() }
  const service = createSystemService(
    new AppSettingsStore(path.join(root, 'settings.json'), root),
    {
      platform: 'linux',
      // 钉成 same-user：Windows runner 上 trusted-only 会去建机器级目录，和这里要测的无关。
      windowsExecutionMode: 'same-user',
      runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmExecutable : null),
      runtimeLog,
    },
  )
  return { service, target, runCommand, runtimeLog, downloads, offlineInstalls, downloadStarted }
}

/** 假时钟往前拨一次检查的间隔，再让真实的读盘（量目录、删目录）跑完。 */
async function advanceOneCheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(npmDownloadProgressCheckMs)
  await new Promise<void>((resolve) => setTimeout(resolve, 30))
}

/** 一直拨到这次下载被停下；拨到上限还没停就让用例当场红，而不是干等超时。 */
async function advanceUntilAborted(attempt: DownloadAttempt, limitMs: number): Promise<void> {
  for (let elapsed = 0; attempt.abortedAt === null; elapsed += npmDownloadProgressCheckMs) {
    if (elapsed > limitMs) throw new Error(`下载过了 ${elapsed / 1000} 秒还没被停下`)
    await advanceOneCheck()
  }
}

// 这几条模拟 Linux 的安装会在 HOME 下建本软件的托管 npm 目录；Windows 主机上的 HOME 不是
// POSIX 路径，建不出来，所以只在 macOS / Linux 主机上跑（同 install-cancel）。
describe('a CLI download that stops moving', () => {
  it.runIf(process.platform !== 'win32')('gives up on a stuck registry after three minutes and says download timed out', async () => {
    useWatchClock()
    const fixture = createDownloadFixture('hang')
    const install = fixture.service.installCli('claude', fixture.target).catch((error: unknown) => error)

    await fixture.downloadStarted(1)
    const [official] = fixture.downloads
    expect(official.registry).toBe(officialRegistry)
    expect(official.timeoutMs).toBe(npmDownloadCeilingMs)
    await advanceUntilAborted(official, 2 * npmDownloadStallTimeoutMs)
    const stalledAfter = (official.abortedAt ?? 0) - official.startedAt
    expect(stalledAfter).toBeGreaterThanOrEqual(npmDownloadStallTimeoutMs)
    expect(stalledAfter).toBeLessThanOrEqual(npmDownloadStallTimeoutMs + 3 * npmDownloadProgressCheckMs)

    // Not a cancel: the install moves on to the other registry, with the first one's
    // half-downloaded files already gone.
    await fixture.downloadStarted(2)
    const mirror = fixture.downloads[1]
    expect(mirror.registry).toBe(mirrorRegistry)
    expect(mirror.attemptDirectories).toEqual(['attempt-1'])
    expect(fixture.runtimeLog.log).toHaveBeenCalledWith(
      'warn',
      'install',
      'cli.install.download-stalled',
      expect.stringContaining('没有进展'),
      expect.objectContaining({ provider: 'claude', registry: officialRegistry }),
    )

    await advanceUntilAborted(mirror, 2 * npmDownloadStallTimeoutMs)
    const error = await install
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toBe(`Claude Code 安装失败：npm 官方源：${timedOutDetail}；国内 npm 镜像：${timedOutDetail}`)
    expect(classifyOperationError(message)).toBe('downloadTimeout')
    expect(fixture.target.send).not.toHaveBeenCalledWith(
      'cli:install-progress',
      expect.objectContaining({ message: expect.stringContaining('安装已取消') }),
    )
  })

  it.runIf(process.platform !== 'win32')('keeps a slow download going past the old five minutes for as long as it moves', async () => {
    useWatchClock()
    const fixture = createDownloadFixture('hang')
    const install = fixture.service.installCli('claude', fixture.target).catch((error: unknown) => error)

    await fixture.downloadStarted(1)
    const [official] = fixture.downloads
    const partial = path.join(official.cache, '_cacache', 'tmp', 'partial')
    fs.mkdirSync(path.dirname(partial), { recursive: true })
    // A trickle: a little more arrives before every check, for twice the old five-minute budget.
    let lastGrowthAt = official.startedAt
    for (let elapsed = 0; elapsed < 2 * npmDownloadTimeoutMs; elapsed += npmDownloadProgressCheckMs) {
      fs.appendFileSync(partial, Buffer.alloc(512))
      lastGrowthAt = performance.now()
      await advanceOneCheck()
    }
    expect(official.abortedAt).toBeNull()
    expect(fixture.downloads).toHaveLength(1)

    // Then it stops moving: three minutes from the last change, not from the start.
    await advanceUntilAborted(official, 2 * npmDownloadStallTimeoutMs)
    expect((official.abortedAt ?? 0) - lastGrowthAt).toBeGreaterThanOrEqual(npmDownloadStallTimeoutMs)
    expect((official.abortedAt ?? 0) - lastGrowthAt).toBeLessThanOrEqual(npmDownloadStallTimeoutMs + 4 * npmDownloadProgressCheckMs)

    // The customer cancelling the next registry's download is still a cancel.
    await fixture.downloadStarted(2)
    expect(fixture.service.cancelCliInstall('claude')).toEqual({ cancelled: true, reason: null })
    const error = await install
    expect((error as Error).message).toBe('Claude Code 安装已取消')
    expect(fixture.downloads).toHaveLength(2)
  })

  it.runIf(process.platform !== 'win32')('keeps the five-minute budget for the offline install from the verified cache', async () => {
    const fixture = createDownloadFixture('succeed')

    const error = await fixture.service.installCli('claude', fixture.target).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(fixture.downloads.map((attempt) => attempt.timeoutMs)).toEqual([npmDownloadCeilingMs, npmDownloadCeilingMs])
    expect(fixture.offlineInstalls.map((options) => options.timeoutMs)).toEqual([npmDownloadTimeoutMs, npmDownloadTimeoutMs])
    const resolutions = fixture.runCommand.mock.calls
      .filter(([spec]) => spec.argv.includes('--package-lock-only'))
      .map(([, options]) => options?.timeoutMs)
    expect(resolutions).toEqual([npmResolutionTimeoutMs, npmResolutionTimeoutMs, npmResolutionTimeoutMs])
  })
})
