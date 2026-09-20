import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createSystemService, type SystemServiceOptions } from './system-service'

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

  const downloadStarted = deferred<void>()
  const downloadAttempts: string[] = []
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
      downloadStarted.resolve()
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
      runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
      findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmExecutable : null),
    },
  )
  return { service, target, runCommand, downloadStarted, downloadAttempts }
}

describe('cancelling a CLI install', () => {
  it('reports that nothing is running when no install is in flight', () => {
    const { service } = createCancellableInstallFixture()
    const outcome = service.cancelCliInstall('claude')
    expect(outcome.cancelled).toBe(false)
    expect(outcome.reason).toContain('没有正在进行的安装')
  })

  it('aborts the running npm download and does not fall through to the mirror', async () => {
    const fixture = createCancellableInstallFixture()
    const install = fixture.service.installCli('claude', fixture.target)
    const settled = install.catch((error: unknown) => error)
    await fixture.downloadStarted.promise

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

  it('stops tracking the install once it has finished unwinding', async () => {
    const fixture = createCancellableInstallFixture()
    const install = fixture.service.installCli('claude', fixture.target)
    const settled = install.catch(() => undefined)
    await fixture.downloadStarted.promise
    fixture.service.cancelCliInstall('claude')
    await settled

    const outcome = fixture.service.cancelCliInstall('claude')
    expect(outcome.cancelled).toBe(false)
    expect(outcome.reason).toContain('没有正在进行的安装')
  })

  it('lets a second install start after the cancelled one unwound', async () => {
    const fixture = createCancellableInstallFixture()
    const settled = fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    await fixture.downloadStarted.promise
    fixture.service.cancelCliInstall('claude')
    await settled

    const retry = fixture.service.installCli('claude', fixture.target).catch((error: unknown) => error)
    // 第二次能起来就说明登记表和 installing 集合都已经放开了。
    await vi.waitFor(() => expect(fixture.downloadAttempts).toHaveLength(2))
    expect(fixture.service.cancelCliInstall('claude').cancelled).toBe(true)
    expect(((await retry) as Error).message).toContain('安装已取消')
  })
})
