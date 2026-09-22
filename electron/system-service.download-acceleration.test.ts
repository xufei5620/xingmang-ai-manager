import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createSystemService, type SystemServiceOptions } from './system-service'
import type { DownloadAccelerationLease } from './download-acceleration'

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
  env?: NodeJS.ProcessEnv
}

/**
 * 一台「探测出来是中国大陆」的机器：缺省顺序是镜像优先，所以只要下载走了
 * 加速，第一条 npm 命令的 --registry 就必须翻成官方源。
 */
function createInstallFixture(options: {
  lease?: Partial<DownloadAccelerationLease>
  acquire?: () => Promise<DownloadAccelerationLease>
  mirrorPolicy?: 'mirror-first' | 'official-first'
} = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-download-acceleration-'))
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
    if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=CN\n', { status: 200 })
    const match = /\/(?:%40anthropic-ai%2F)?claude-code\/(.+)$/.exec(url)
    if (match) {
      const version = match[1] === 'latest' ? '2.1.300' : decodeURIComponent(match[1])
      return new Response(JSON.stringify({ name: '@anthropic-ai/claude-code', version, dist: { integrity } }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))

  const registries: string[] = []
  const subprocessEnvironments: NodeJS.ProcessEnv[] = []
  const runCommand = vi.fn(async (spec: CommandSpecLike, commandOptions: CommandOptionsLike = {}) => {
    if (spec.argv.includes('--package-lock-only')) {
      const cwd = commandOptions.cwd
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
        packages: { '': { dependencies: manifest.dependencies }, [`node_modules/${packageName}`]: { version, integrity } },
      }))
    } else if (spec.argv[0] === 'ci') {
      // 下载这一步才按区域挑源；记下这一次用的是哪个源就够了，本文件测的是
      // 源顺序，不是安装本身。
      registries.push(spec.argv.find((argument) => argument.startsWith('--registry=')) ?? '')
      subprocessEnvironments.push({ ...commandOptions.env })
      throw new Error('依赖下载失败（测试夹具）')
    }
    return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, durationMs: 1 }
  })

  const release = vi.fn(async () => {})
  const lease: DownloadAccelerationLease = {
    endpoint: { scheme: 'http', host: '127.0.0.1', port: 7890 },
    accelerated: true,
    release,
    ...options.lease,
  }
  const acquire = vi.fn(options.acquire ?? (async () => lease))
  const settingsStore = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const service = createSystemService(settingsStore, {
    platform: 'linux',
    windowsExecutionMode: 'same-user',
    runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
    findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmExecutable : null),
    resolveSubprocessProxyEnvironment: async () => ({ HTTPS_PROXY: 'http://127.0.0.1:7890' }),
    acquireDownloadAcceleration: acquire,
  })
  const target = { isDestroyed: () => false, send: vi.fn() as unknown as (channel: string, payload: unknown) => void }
  return { service, settingsStore, target, registries, subprocessEnvironments, acquire, release }
}

describe('installing a CLI with download acceleration', () => {
  it('prefers the official registry once the route is up', async () => {
    const fixture = createInstallFixture()
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.acquire).toHaveBeenCalledTimes(1)
    // 缺省顺序是镜像优先（探测到 CN），加速把它翻了过来。
    expect(fixture.registries[0]).toContain('registry.npmjs.org')
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it('tells the user which source order it is using', async () => {
    const fixture = createInstallFixture()
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    const messages = (fixture.target.send as unknown as { mock: { calls: Array<[string, { message?: string }]> } })
      .mock.calls.map(([, payload]) => payload.message ?? '')
    expect(messages.some((message) => message.includes('已为本次下载启用加速线路'))).toBe(true)
    expect(messages.some((message) => message.includes('已启用下载加速，优先使用官方源'))).toBe(true)
  })

  it('keeps the existing order when no route could be started', async () => {
    const fixture = createInstallFixture({ lease: { endpoint: null, accelerated: false } })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.registries[0]).toContain('npmmirror.com')
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it('installs as before when acquiring the route throws', async () => {
    const fixture = createInstallFixture({ acquire: async () => { throw new Error('加速服务不可用') } })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.registries[0]).toContain('npmmirror.com')
    expect(fixture.release).not.toHaveBeenCalled()
  })

  it('respects a pinned mirror-first policy', async () => {
    const fixture = createInstallFixture()
    await fixture.settingsStore.update({ version: 2, mirrorPolicy: 'mirror-first' })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.registries[0]).toContain('npmmirror.com')
    // 线路照样起：用户钉的是源顺序，不是「别用加速」。
    expect(fixture.acquire).toHaveBeenCalledTimes(1)
  })

  it('hands the route back even when the install fails', async () => {
    const fixture = createInstallFixture()
    await expect(fixture.service.installCli('claude', fixture.target)).rejects.toThrow()
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it('passes the loopback proxy down to npm', async () => {
    const fixture = createInstallFixture()
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.subprocessEnvironments[0]?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })
})
