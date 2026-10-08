import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { networkFailureMessages, toolCertificateMessages } from './network-failure'
import { createSystemService, interactiveTerminalEnvironment, sameUserTerminalEnvironment, type SystemServiceOptions } from './system-service'

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

function registryResponse(input: string | URL | Request): Response {
  const url = String(input)
  if (url.includes('cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
  const match = /\/(?:%40anthropic-ai%2F)?claude-code\/(.+)$/.exec(url)
  if (!match) throw new Error(`Unexpected fetch: ${url}`)
  const version = match[1] === 'latest' ? '2.1.300' : decodeURIComponent(match[1])
  return new Response(JSON.stringify({ name: '@anthropic-ai/claude-code', version, dist: { integrity } }), { status: 200 })
}

/**
 * 一次在普通权限下的 Claude Code 安装：npm 解析依赖图那一步按 `lockFailure` 失败
 * （缺省成功），下载那一步一律失败——这里只看 npm 带着什么环境去跑、失败时说了什么。
 */
function createInstallFixture(options: {
  lockFailure?: string
  nodeVersion?: string
  registryFetch?: SystemServiceOptions['registryFetch']
} = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-certificate-trust-'))
  temporaryDirectories.push(temporaryRoot)
  const root = fs.realpathSync(temporaryRoot)
  const homeDirectory = path.join(root, 'home')
  const runtimeBin = path.join(homeDirectory, '.local', 'bin')
  fs.mkdirSync(runtimeBin, { recursive: true })
  vi.stubEnv('HOME', homeDirectory)
  // Linux 上托管目录跟着 XDG_DATA_HOME 走，不清掉会写进开发机真实的数据目录。
  vi.stubEnv('XDG_DATA_HOME', undefined)
  vi.stubEnv('NODE_USE_SYSTEM_CA', undefined)
  const npmExecutable = path.join(runtimeBin, 'npm')
  const nodeExecutable = path.join(runtimeBin, 'node')
  for (const executable of [npmExecutable, nodeExecutable]) {
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n')
    fs.chmodSync(executable, 0o700)
  }

  const globalFetch = vi.fn(async (input: string | URL | Request) => registryResponse(input))
  vi.stubGlobal('fetch', globalFetch)

  const npmEnvironments: NodeJS.ProcessEnv[] = []
  const runCommand = vi.fn(async (spec: CommandSpecLike, commandOptions: CommandOptionsLike = {}) => {
    const ok = (stdout = '') => ({ executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: 0, durationMs: 1 })
    if (spec.executable === nodeExecutable && spec.argv[0] === '--version') return ok(options.nodeVersion ?? 'v24.11.0')
    if (spec.argv.includes('--package-lock-only')) {
      npmEnvironments.push({ ...commandOptions.env })
      if (options.lockFailure) throw new Error(options.lockFailure)
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
      npmEnvironments.push({ ...commandOptions.env })
      throw new Error('依赖下载失败（测试夹具）')
    }
    return ok()
  })

  const settingsStore = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const service = createSystemService(settingsStore, {
    platform: 'linux',
    windowsExecutionMode: 'same-user',
    runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
    findExecutable: vi.fn(async (command: string) => (
      command === 'npm' ? npmExecutable : command === 'node' ? nodeExecutable : null
    )),
    resolveSubprocessProxyEnvironment: async () => ({}),
    ...(options.registryFetch ? { registryFetch: options.registryFetch } : {}),
  })
  const target = { isDestroyed: () => false, send: vi.fn() as unknown as (channel: string, payload: unknown) => void }
  return { service, target, npmEnvironments, globalFetch }
}

async function installError(fixture: ReturnType<typeof createInstallFixture>): Promise<string> {
  try {
    await fixture.service.installCli('claude', fixture.target)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('install unexpectedly succeeded')
}

const selfSignedFailure = 'npm error code SELF_SIGNED_CERT_IN_CHAIN\nnpm error request to https://registry.npmjs.org/@anthropic-ai%2fclaude-code failed, reason: self-signed certificate in certificate chain'

describe('installing a CLI behind a certificate the machine trusts', () => {
  // 这几条模拟 Linux 的安装会在 HOME 下建本软件的托管 npm 目录（Linux 版拆分 ②）；Windows
  // 主机上的 HOME 不是 POSIX 路径，建不出来，所以只在 macOS / Linux 主机上跑。
  it.runIf(process.platform !== 'win32')('lets npm trust the operating system certificate store on the same-user path', async () => {
    const fixture = createInstallFixture()
    await installError(fixture)
    expect(fixture.npmEnvironments.length).toBeGreaterThan(0)
    for (const env of fixture.npmEnvironments) expect(env.NODE_USE_SYSTEM_CA).toBe('1')
  })

  it.runIf(process.platform !== 'win32')('keeps a value the user already chose', async () => {
    const fixture = createInstallFixture()
    vi.stubEnv('NODE_USE_SYSTEM_CA', '0')
    await installError(fixture)
    expect(fixture.npmEnvironments.length).toBeGreaterThan(0)
    for (const env of fixture.npmEnvironments) expect(env.NODE_USE_SYSTEM_CA).toBe('0')
  })

  it.runIf(process.platform !== 'win32')('asks the host fetch for registry metadata when one is provided', async () => {
    const registryFetch = vi.fn(async (input: string | URL | Request) => registryResponse(input))
    const fixture = createInstallFixture({ registryFetch: registryFetch as unknown as typeof fetch })
    await installError(fixture)
    expect(registryFetch.mock.calls.map(([input]) => String(input)).some((url) => url.includes('registry.npmjs.org'))).toBe(true)
    expect(fixture.globalFetch.mock.calls.map(([input]) => String(input)).some((url) => url.includes('registry.npmjs.org'))).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('names an outdated Node.js when npm still rejects the certificate', async () => {
    const fixture = createInstallFixture({ lockFailure: selfSignedFailure, nodeVersion: 'v22.12.0' })
    const message = await installError(fixture)
    expect(message).toContain(toolCertificateMessages.outdatedNode)
    expect(message).not.toContain(networkFailureMessages.tls)
  })

  it.runIf(process.platform !== 'win32')('adds nothing when Node.js already reads the store, so the machine itself rejects the certificate', async () => {
    const fixture = createInstallFixture({ lockFailure: selfSignedFailure, nodeVersion: 'v24.11.0' })
    const message = await installError(fixture)
    expect(message).toContain('SELF_SIGNED_CERT_IN_CHAIN')
    expect(message).not.toContain(toolCertificateMessages.outdatedNode)
    expect(message).not.toContain(toolCertificateMessages.elevated)
  })

  it('leaves unrelated npm failures untouched', async () => {
    const fixture = createInstallFixture({ lockFailure: 'npm error code ETIMEDOUT', nodeVersion: 'v18.20.0' })
    const message = await installError(fixture)
    expect(message).not.toContain(toolCertificateMessages.outdatedNode)
  })
})

describe('opening a CLI as the current user', () => {
  it('lets the terminal trust the operating system certificate store and keeps the colours', () => {
    const env = interactiveTerminalEnvironment({ PATH: '/usr/bin', HOME: '/home/tester' }, sameUserTerminalEnvironment)
    expect(env.NODE_USE_SYSTEM_CA).toBe('1')
    expect(env.FORCE_COLOR).toBe('3')
  })
})
