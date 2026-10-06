import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { cliVerifiedVersions } from './cli-verified-versions'
import { createSystemService, type SystemServiceOptions } from './system-service'
import type { resolveCliInstallation as resolveCliInstallationForTest } from './tool-installation'

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

function recommendedCodexVersion(): string {
  const recommended = cliVerifiedVersions.codex.recommended
  if (!recommended) throw new Error('cliVerifiedVersions.codex 必须有推荐版本')
  return recommended.version
}

/**
 * 一台 Linux 机器上，Codex 已经装在本软件的托管目录里（package.json 写着
 * installedVersion；Linux 版拆分 ② 起 Linux 和 macOS 一样装进托管目录）。假 npm
 * 把包写进它拿到的暂存前缀，本软件核对后整体换进托管目录，检测读的也是那份
 * package.json，所以前后两次检测看到的版本号和真机一致。
 */
function createFixture(installedVersion: string | null) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-cli-revert-'))
  temporaryDirectories.push(temporaryRoot)
  const root = fs.realpathSync(temporaryRoot)
  const homeDirectory = path.join(root, 'home')
  const managedPrefix = path.join(homeDirectory, '.local', 'share', 'XingMangAI', 'Cli', 'npm')
  const runtimeBin = path.join(root, 'runtime-bin')
  fs.mkdirSync(homeDirectory, { recursive: true })
  fs.mkdirSync(runtimeBin, { recursive: true })
  const npmExecutable = path.join(runtimeBin, 'npm')
  fs.writeFileSync(npmExecutable, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(npmExecutable, 0o700)
  vi.stubEnv('HOME', homeDirectory)
  vi.stubEnv('XDG_DATA_HOME', undefined)
  vi.stubEnv('PATH', runtimeBin)
  vi.stubEnv('npm_config_prefix', undefined)
  vi.stubEnv('npm_config_userconfig', undefined)

  const packageRoot = path.join(managedPrefix, 'lib', 'node_modules', '@openai', 'codex')
  function writePackage(prefix: string, version: string) {
    const directory = path.join(prefix, 'lib', 'node_modules', '@openai', 'codex')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: '@openai/codex', version }))
  }
  function writeInstalledVersion(version: string) {
    writePackage(managedPrefix, version)
  }
  function readInstalledVersion(): string | null {
    try {
      return (JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as { version: string }).version
    } catch {
      return null
    }
  }
  if (installedVersion) writeInstalledVersion(installedVersion)

  const integrity = `sha512-${Buffer.alloc(64, 0x33).toString('base64')}`
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('cloudflare.com/cdn-cgi/trace')) return new Response('ip=203.0.113.8\nloc=US\n', { status: 200 })
    const match = /codex\/([^/?]+)$/.exec(url)
    if (match) {
      const version = match[1] === 'latest' ? recommendedCodexVersion() : decodeURIComponent(match[1])
      return new Response(JSON.stringify({ name: '@openai/codex', version, dist: { integrity } }), { status: 200 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }))

  let pendingVersion: string | null = null
  const runCommand = vi.fn(async (
    spec: { executable: string; argv: readonly string[] },
    options: { cwd?: string } = {},
  ) => {
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
      pendingVersion = version
      fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        lockfileVersion: 3,
        packages: { '': { dependencies: manifest.dependencies }, [`node_modules/${packageName}`]: { version, integrity } },
      }))
    } else if (spec.argv[0] === 'install' && spec.argv.includes('--global') && pendingVersion) {
      const prefix = spec.argv.find((argument) => argument.startsWith('--prefix='))?.slice('--prefix='.length)
      if (!prefix) throw new Error('Managed install omitted --prefix')
      writePackage(prefix, pendingVersion)
    }
    return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout: '', stderr: '', outputBytes: 0, durationMs: 1 }
  })
  const resolveCliInstallation = vi.fn<typeof resolveCliInstallationForTest>(async () => {
    const version = readInstalledVersion()
    return version
      ? {
          commandPath: path.join(managedPrefix, 'bin', 'codex'),
          installDirectory: packageRoot,
          packageRoot,
          npmPrefix: managedPrefix,
          packageVersion: version,
          source: 'npm',
        }
      : null
  })
  const service = createSystemService(new AppSettingsStore(path.join(root, 'settings.json'), root), {
    platform: 'linux',
    runCommand: runCommand as unknown as SystemServiceOptions['runCommand'],
    resolveCliInstallation,
  })
  const target = { isDestroyed: () => false, send: vi.fn() }
  return { service, target, root, readInstalledVersion }
}

describe.runIf(process.platform === 'linux')('reverting a CLI update', () => {
  it('offers the version that was installed before an update', async () => {
    const fixture = createFixture('0.100.0')

    await fixture.service.installCli('codex', fixture.target)

    expect(fixture.readInstalledVersion()).toBe(recommendedCodexVersion())
    const status = await fixture.service.inspectCliUpdate('codex', true)
    expect(status.version).toBe(recommendedCodexVersion())
    expect(status.revertVersion).toBe('0.100.0')
  })

  it('does not offer a revert after a first install', async () => {
    const fixture = createFixture(null)

    await fixture.service.installCli('codex', fixture.target)

    expect((await fixture.service.inspectCliUpdate('codex', true)).revertVersion).toBeUndefined()
  })

  it('stops offering the revert once the old version is back', async () => {
    const fixture = createFixture('0.100.0')
    await fixture.service.installCli('codex', fixture.target)

    await fixture.service.installCli('codex', fixture.target, '0.100.0')

    expect(fixture.readInstalledVersion()).toBe('0.100.0')
    // 退回本身是点名安装，不能记成一次「从推荐版本更到 0.100.0」的更新，
    // 否则菜单会反过来劝他「退回」到刚出问题的那一版。
    const status = await fixture.service.inspectCliUpdate('codex', true)
    expect(status.revertVersion).toBeUndefined()
    const history = JSON.parse(fs.readFileSync(path.join(fixture.root, 'cli-update-history', 'cli-update-history.json'), 'utf8')) as {
      tools: Record<string, { from: string; to: string }>
    }
    expect(history.tools.codex).toMatchObject({ from: '0.100.0', to: recommendedCodexVersion() })
  })
})
