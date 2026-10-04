import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createSystemService, type SystemServiceOptions } from './system-service'
import { createDownloadAccelerationCoordinator, type DownloadAccelerationLease } from './download-acceleration'
import {
  resolveNodeRuntimeNetworkRegion,
  type InstallNodeRuntimeOptions,
  type NodeRuntimeInstallResult,
} from './node-runtime'
import type { InstallPythonRuntimeOptions, PythonRuntimeInstallResult } from './python-runtime'
import type { WindowsMachinePaths } from './windows-machine-paths'

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
  platform?: NodeJS.Platform
  subprocessProxy?: NodeJS.ProcessEnv
  probeLoopbackProxy?: SystemServiceOptions['probeLoopbackProxy']
} = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-download-acceleration-'))
  temporaryDirectories.push(temporaryRoot)
  const root = fs.realpathSync(temporaryRoot)
  const homeDirectory = path.join(root, 'home')
  const runtimeBin = path.join(homeDirectory, '.local', 'bin')
  fs.mkdirSync(runtimeBin, { recursive: true })
  vi.stubEnv('HOME', homeDirectory)
  // Linux 上托管目录跟着 XDG_DATA_HOME 走：开发机上设了它，测试就会写进真实的数据目录。
  vi.stubEnv('XDG_DATA_HOME', undefined)
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
    platform: options.platform ?? 'linux',
    windowsExecutionMode: 'same-user',
    runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
    findExecutable: vi.fn(async (command: string) => command === 'npm' ? npmExecutable : null),
    // 宿主已有的原生 CLI 会提前拒绝 npm 安装，让下载代理断言无法触达。
    resolveCliInstallation: vi.fn(async () => null),
    resolveSubprocessProxyEnvironment: async () => options.subprocessProxy ?? { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    acquireDownloadAcceleration: acquire,
    probeLoopbackProxy: options.probeLoopbackProxy,
  })
  const target = { isDestroyed: () => false, send: vi.fn() as unknown as (channel: string, payload: unknown) => void }
  return { service, settingsStore, target, registries, subprocessEnvironments, acquire, release }
}

describe('installing a CLI with download acceleration', () => {
  // 这几条模拟 Linux 的安装会在 HOME 下建本软件的托管 npm 目录（Linux 版拆分 ②）；Windows
  // 主机上的 HOME 不是 POSIX 路径，建不出来，所以只在 macOS / Linux 主机上跑。
  it.runIf(process.platform !== 'win32')('prefers the official registry once the route is up', async () => {
    const fixture = createInstallFixture()
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.acquire).toHaveBeenCalledTimes(1)
    // 缺省顺序是镜像优先（探测到 CN），加速把它翻了过来。
    expect(fixture.registries[0]).toContain('registry.npmjs.org')
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  it.runIf(process.platform !== 'win32')('tells the user which source order it is using', async () => {
    const fixture = createInstallFixture()
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    const messages = (fixture.target.send as unknown as { mock: { calls: Array<[string, { message?: string }]> } })
      .mock.calls.map(([, payload]) => payload.message ?? '')
    expect(messages.some((message) => message.includes('已为本次下载启用加速线路'))).toBe(true)
    expect(messages.some((message) => message.includes('已启用下载加速，优先使用官方源'))).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('keeps the existing order when no route could be started', async () => {
    const fixture = createInstallFixture({ lease: { endpoint: null, accelerated: false } })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.registries[0]).toContain('npmmirror.com')
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })

  // 电脑里留着一个关掉的代理，星芒这次运行整个改成了直连，之后又开了加速（PR #834 核实的 F10）：
  // 下载和 npm 其实都直连，以前却说已经加速、还先连官方源。
  it.runIf(process.platform !== 'win32')('keeps the mirror first when this run connects directly while acceleration is on', async () => {
    const coordinator = createDownloadAccelerationCoordinator({
      getAccountScope: () => 'xm-account:7',
      startRoute: async () => ({ status: 'system-proxy-active' }),
      stopRoute: async () => {},
      downloadsFollowSystemProxy: () => false,
    })
    const fixture = createInstallFixture({ acquire: () => coordinator.acquire(), subprocessProxy: {} })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.registries[0]).toContain('npmmirror.com')
    const messages = (fixture.target.send as unknown as { mock: { calls: Array<[string, { message?: string }]> } })
      .mock.calls.map(([, payload]) => payload.message ?? '')
    expect(messages.some((message) => message.includes('未启用下载加速，按现有下载源顺序继续'))).toBe(true)
    expect(messages.some((message) => message.includes('检测到中国大陆网络'))).toBe(true)
    expect(messages.some((message) => message.includes('已为本次下载启用加速线路'))).toBe(false)
    expect(messages.some((message) => message.includes('已启用下载加速，优先使用官方源'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('installs as before when acquiring the route throws', async () => {
    const fixture = createInstallFixture({ acquire: async () => { throw new Error('加速服务不可用') } })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.registries[0]).toContain('npmmirror.com')
    expect(fixture.release).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('respects a pinned mirror-first policy', async () => {
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

  it.runIf(process.platform !== 'win32')('passes the loopback proxy down to npm', async () => {
    const fixture = createInstallFixture()
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.subprocessEnvironments[0]?.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('leaves out a proxy setting that points at a closed local port when npm runs on Windows', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7899')
    vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1080')
    const probe = vi.fn(async (target: { port: number }) => target.port === 1080)
    const fixture = createInstallFixture({ platform: 'win32', subprocessProxy: {}, probeLoopbackProxy: probe })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    const env = fixture.subprocessEnvironments[0]
    expect(env).toBeDefined()
    expect(Object.keys(env ?? {}).some((key) => key.toUpperCase() === 'HTTPS_PROXY')).toBe(false)
    expect(env?.ALL_PROXY).toBe('http://127.0.0.1:1080')
  })

  // Linux 版拆分 ②：网上教程常让人把 `export https_proxy=…7890` 写进 ~/.profile，代理软件一关就装不上。
  it.runIf(process.platform !== 'win32')('leaves out a proxy setting that points at a closed local port when npm runs on Linux', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7899')
    vi.stubEnv('ALL_PROXY', 'http://127.0.0.1:1080')
    const probe = vi.fn(async (target: { port: number }) => target.port === 1080)
    const fixture = createInstallFixture({ platform: 'linux', subprocessProxy: {}, probeLoopbackProxy: probe })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    const env = fixture.subprocessEnvironments[0]
    expect(env).toBeDefined()
    expect(Object.keys(env ?? {}).some((key) => key.toUpperCase() === 'HTTPS_PROXY')).toBe(false)
    expect(env?.ALL_PROXY).toBe('http://127.0.0.1:1080')
  })

  it.runIf(process.platform !== 'win32')('keeps the proxy settings untouched for npm on macOS', async () => {
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:7899')
    const probe = vi.fn(async () => false)
    const fixture = createInstallFixture({ platform: 'darwin', subprocessProxy: {}, probeLoopbackProxy: probe })
    await fixture.service.installCli('claude', fixture.target).catch(() => undefined)
    expect(fixture.subprocessEnvironments[0]?.HTTPS_PROXY).toBe('http://127.0.0.1:7899')
    expect(probe).not.toHaveBeenCalled()
  })
})

function createRoute() {
  const release = vi.fn(async () => {})
  const acquire = vi.fn(async (): Promise<DownloadAccelerationLease> => ({
    endpoint: { scheme: 'http', host: '127.0.0.1', port: 7890 },
    accelerated: true,
    release,
  }))
  return { acquire, release }
}

describe('installing Python with download acceleration', () => {
  const installedFromPythonOrg: PythonRuntimeInstallResult = {
    installed: true,
    action: 'installed',
    method: 'exe',
    source: 'python-org',
    version: 'Python 3.12',
    architecture: 'x64',
    pathRefreshRequired: true,
  }

  function createPythonService(
    route: ReturnType<typeof createRoute>,
    installPythonRuntime: NonNullable<SystemServiceOptions['installPythonRuntime']>,
  ) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-python-download-acceleration-'))
    temporaryDirectories.push(directory)
    const downloadFetch = vi.fn() as unknown as typeof fetch
    const service = createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform: 'win32',
        windowsExecutionMode: 'same-user',
        findExecutable: async () => null,
        acquireDownloadAcceleration: route.acquire,
        downloadFetch,
        installPythonRuntime,
        inspectInstalledPythonRuntime: async () => { throw new Error('Python 3.12 fixed install not found') },
      },
    )
    return { service, downloadFetch }
  }

  it('borrows the download route only once the installer falls back to python.org', async () => {
    const route = createRoute()
    const installPythonRuntime = vi.fn(async (options: InstallPythonRuntimeOptions = {}) => {
      // 先试商店：它自己下载、不走这条线路，不该等加速内核起来。
      expect(route.acquire).not.toHaveBeenCalled()
      if (!options.withDownloadRoute) throw new Error('退到 python.org 时要能借下载线路')
      await options.withDownloadRoute(async () => {
        // 下载那一刻线路必须还握在手里。
        expect(route.acquire).toHaveBeenCalledTimes(1)
        expect(route.release).not.toHaveBeenCalled()
      })
      expect(route.release).toHaveBeenCalledTimes(1)
      return installedFromPythonOrg
    })
    const { service, downloadFetch } = createPythonService(route, installPythonRuntime)

    await service.installPythonRuntime({ isDestroyed: () => false, send: vi.fn() })
    expect(installPythonRuntime).toHaveBeenCalledWith(expect.objectContaining({ dependencies: { fetch: downloadFetch } }))
    expect(route.acquire).toHaveBeenCalledTimes(1)
  })

  it('never starts the route when the Microsoft Store installs Python', async () => {
    const route = createRoute()
    const { service } = createPythonService(route, vi.fn(async (): Promise<PythonRuntimeInstallResult> => ({
      ...installedFromPythonOrg,
      method: 'winget',
      source: 'winget',
    })))

    await expect(service.installPythonRuntime({ isDestroyed: () => false, send: vi.fn() }))
      .resolves.toMatchObject({ method: 'winget' })
    expect(route.acquire).not.toHaveBeenCalled()
  })
})

describe('installing Node.js with download acceleration', () => {
  const testMachinePaths: WindowsMachinePaths = {
    systemRoot: 'D:\\Windows',
    system32: 'D:\\Windows\\System32',
    programFiles: 'D:\\Program Files',
    programFilesX86: 'D:\\Program Files (x86)',
    programData: 'D:\\ProgramData',
  }
  const installedNode: NodeRuntimeInstallResult = {
    installed: true,
    action: 'installed',
    method: 'msi',
    source: 'official',
    version: 'v24.19.0',
    architecture: 'x64',
    pathRefreshRequired: true,
    systemRestartRequired: false,
  }

  /** 探测出来是中国大陆的一台没装 Node.js 的电脑：不借线路时镜像优先。 */
  function createNodeService(
    platform: NodeJS.Platform,
    route: ReturnType<typeof createRoute>,
    installNodeRuntime: NonNullable<SystemServiceOptions['installNodeRuntime']>,
  ) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-node-download-acceleration-'))
    temporaryDirectories.push(directory)
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=CN\n', { status: 200 })
      throw new Error(`Unexpected fetch: ${url}`)
    }))
    return createSystemService(
      new AppSettingsStore(path.join(directory, 'settings.json'), directory),
      {
        platform,
        windowsExecutionMode: 'same-user',
        providerRoots: { userHome: directory, codexHome: path.join(directory, '.codex') },
        findExecutable: async () => null,
        inspectWindowsRestartRequired: async () => ({ required: false, reasons: [] }),
        inspectWindowsProcessor: async () => 'x64',
        resolveWindowsMachinePaths: () => testMachinePaths,
        readWindowsLivePath: async () => null,
        acquireDownloadAcceleration: route.acquire,
        installNodeRuntime,
      },
    )
  }

  it('borrows the route only when Windows falls back to the installer, then prefers the official site', async () => {
    const route = createRoute()
    const installNodeRuntime = vi.fn(async (options: InstallNodeRuntimeOptions): Promise<NodeRuntimeInstallResult> => {
      // 先试 winget：它自己下载、不走这条线路，不该等加速内核起来，先走哪个源也还没定。
      expect(route.acquire).not.toHaveBeenCalled()
      expect(await resolveNodeRuntimeNetworkRegion(options.networkRegion)).toBe('mainland-china')
      if (!options.withDownloadRoute) throw new Error('Windows 退到安装包时要能借下载线路')
      const region = await options.withDownloadRoute(() => resolveNodeRuntimeNetworkRegion(options.networkRegion))
      // 借到线路以后再定顺序：线路就是为直连官方源准备的。
      expect(region).toBe('outside-mainland-china')
      expect(route.release).toHaveBeenCalledTimes(1)
      return installedNode
    })
    const service = createNodeService('win32', route, installNodeRuntime)

    await expect(service.installNodeRuntime({ isDestroyed: () => false, send: vi.fn() }))
      .resolves.toMatchObject({ method: 'msi' })
    expect(installNodeRuntime).toHaveBeenCalledOnce()
    expect(route.acquire).toHaveBeenCalledTimes(1)
  })

  it('never starts the route when winget installs Node.js on Windows', async () => {
    const route = createRoute()
    const service = createNodeService('win32', route, vi.fn(async (): Promise<NodeRuntimeInstallResult> => ({
      ...installedNode,
      method: 'winget',
      source: 'winget',
    })))

    await expect(service.installNodeRuntime({ isDestroyed: () => false, send: vi.fn() }))
      .resolves.toMatchObject({ method: 'winget' })
    expect(route.acquire).not.toHaveBeenCalled()
  })

  it('keeps holding the route for the whole install on macOS, where there is no winget', async () => {
    const route = createRoute()
    const installNodeRuntime = vi.fn(async (options: InstallNodeRuntimeOptions): Promise<NodeRuntimeInstallResult> => {
      expect(route.acquire).toHaveBeenCalledTimes(1)
      expect(options.withDownloadRoute).toBeUndefined()
      expect(await resolveNodeRuntimeNetworkRegion(options.networkRegion)).toBe('outside-mainland-china')
      expect(route.release).not.toHaveBeenCalled()
      return { ...installedNode, method: 'archive' }
    })
    const service = createNodeService('darwin', route, installNodeRuntime)

    await service.installNodeRuntime({ isDestroyed: () => false, send: vi.fn() })
    expect(installNodeRuntime).toHaveBeenCalledOnce()
    expect(route.release).toHaveBeenCalledTimes(1)
  })
})
