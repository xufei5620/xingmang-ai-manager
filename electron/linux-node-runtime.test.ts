import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CommandResult } from './command-runner'
import { managedNodeRuntimeRoot } from './managed-cli-paths'
import {
  buildLinuxNodeExtractPlan,
  installLinuxNodeRuntime,
  isTrustedLinuxSystemExecutable,
  linuxExtractPath,
  linuxNodeArchiveTopDirectory,
  linuxNodeRuntimeArchitecture,
  linuxNodeRuntimeFailureMessage,
  linuxNodeRuntimePinnedRelease,
  linuxNodeRuntimeVersion,
  resolveLinuxTarExecutable,
  type LinuxNodeRuntimeProcess,
} from './linux-node-runtime'
import { nodeVersionStatus } from './versions'

const archiveBytes = Buffer.alloc(2 * 1024 * 1024, 7)
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
const pinned = { version: linuxNodeRuntimeVersion, sha256: archiveSha256 }

function result(plan: LinuxNodeRuntimeProcess, stdout = ''): CommandResult {
  return { executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: 0, durationMs: 1 }
}

interface FakeOptions {
  failHosts?: string[]
  reportedVersion?: string
}

function fakeNetwork(options: FakeOptions = {}, body: Buffer = archiveBytes) {
  const requested: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (options.failHosts?.some((host) => url.includes(host))) throw new TypeError('fetch failed')
    if (url.endsWith('.tar.gz')) {
      return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.byteLength) } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requested }
}

function fakeProcesses(options: FakeOptions = {}) {
  const plans: LinuxNodeRuntimeProcess[] = []
  const runProcess = async (plan: LinuxNodeRuntimeProcess): Promise<CommandResult> => {
    plans.push(plan)
    if (plan.executable === '/usr/bin/tar') {
      const destination = plan.argv[plan.argv.indexOf('-C') + 1]
      const top = path.join(destination, linuxNodeArchiveTopDirectory(linuxNodeRuntimeVersion, 'x64'))
      fs.mkdirSync(path.join(top, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(top, 'bin', 'node'), 'node', { mode: 0o755 })
      fs.mkdirSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
      return result(plan)
    }
    return result(plan, `${options.reportedVersion ?? linuxNodeRuntimeVersion}\n`)
  }
  return { runProcess, plans }
}

const temporaryDirectories: string[] = []

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-linux-node-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('Linux managed Node.js runtime', () => {
  it('pins one supported release with a distinct SHA-256 per architecture', () => {
    expect(nodeVersionStatus(linuxNodeRuntimeVersion)).toBe('supported')
    const x64 = linuxNodeRuntimePinnedRelease('x64')
    const arm64 = linuxNodeRuntimePinnedRelease('arm64')
    expect(x64.version).toBe(linuxNodeRuntimeVersion)
    expect(arm64.version).toBe(linuxNodeRuntimeVersion)
    expect(x64.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(arm64.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(x64.sha256).not.toBe(arm64.sha256)
  })

  it('explains in plain words that only Intel/AMD and ARM machines are supported', () => {
    expect(linuxNodeRuntimeArchitecture('x64')).toBe('x64')
    expect(linuxNodeRuntimeArchitecture('arm64')).toBe('arm64')
    expect(() => linuxNodeRuntimeArchitecture('loong64')).toThrow(/芯片（loong64）用不了/)
    expect(() => linuxNodeRuntimeArchitecture('loong64')).not.toThrow(/Windows/)
  })

  it('extracts only with the root-owned system tar and never keeps archive ownership', () => {
    expect(buildLinuxNodeExtractPlan('/usr/bin/tar', '/h/a/node.tar.gz', '/h/a/extract')).toMatchObject({
      executable: '/usr/bin/tar',
      argv: ['-x', '-z', '--no-same-owner', '-f', '/h/a/node.tar.gz', '-C', '/h/a/extract'],
    })
    expect(buildLinuxNodeExtractPlan('/bin/tar', '/h/a/node.tar.gz', '/h/a/extract').executable).toBe('/bin/tar')
    expect(() => buildLinuxNodeExtractPlan('/home/a/bin/tar', '/h/a/node.tar.gz', '/h/a/extract')).toThrow()
    expect(() => buildLinuxNodeExtractPlan('/usr/bin/tar', 'node.tar.gz', '/h/a/extract')).toThrow()
    expect(linuxExtractPath).toBe('/usr/bin:/bin')
  })

  it('accepts a tar only when root owns it and nobody else can write it', () => {
    const file = { isFile: () => true }
    expect(isTrustedLinuxSystemExecutable({ ...file, uid: 0, mode: 0o100755 })).toBe(true)
    expect(isTrustedLinuxSystemExecutable({ ...file, uid: 1000, mode: 0o100755 })).toBe(false)
    expect(isTrustedLinuxSystemExecutable({ ...file, uid: 0, mode: 0o100775 })).toBe(false)
    expect(isTrustedLinuxSystemExecutable({ ...file, uid: 0, mode: 0o100757 })).toBe(false)
    expect(isTrustedLinuxSystemExecutable({ isFile: () => false, uid: 0, mode: 0o040755 })).toBe(false)
  })

  it('falls back to /bin/tar when /usr/bin/tar is missing and gives up when neither qualifies', () => {
    const rootFile = { isFile: () => true, uid: 0, mode: 0o100755 } as fs.Stats
    expect(resolveLinuxTarExecutable((candidate) => candidate === '/bin/tar' ? rootFile : null)).toBe('/bin/tar')
    expect(resolveLinuxTarExecutable(() => rootFile)).toBe('/usr/bin/tar')
    expect(resolveLinuxTarExecutable(() => ({ ...rootFile, uid: 1000 }) as fs.Stats)).toBeNull()
    expect(resolveLinuxTarExecutable(() => null)).toBeNull()
  })

  it('says the network is the likely cause only when every source failed before verification', () => {
    expect(linuxNodeRuntimeFailureMessage([{ stage: 'network', detail: '国内镜像：fetch failed' }]))
      .toMatch(/^Node\.js 没有下载成功，可能是网络不稳/)
    expect(linuxNodeRuntimeFailureMessage([
      { stage: 'network', detail: '国内镜像：fetch failed' },
      { stage: 'verify', detail: 'Node.js 官方源：校验值对不上' },
    ])).toMatch(/^Node\.js 没有准备好/)
  })

  it.skipIf(process.platform === 'win32')('downloads the pinned archive, verifies it and extracts into the product folder', async () => {
    const home = temporaryHome()
    const network = fakeNetwork()
    const processes = fakeProcesses()
    const progress: string[] = []
    const installed = await installLinuxNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'x64',
      environment: { HOME: home },
      dependencies: { fetch: network.fetch },
      linux: { runProcess: processes.runProcess, resolveTar: () => '/usr/bin/tar', pinnedRelease: () => pinned },
      onProgress: (entry) => progress.push(entry.message),
    })

    expect(installed).toMatchObject({
      installed: true,
      action: 'installed',
      method: 'archive',
      source: 'npmmirror',
      version: linuxNodeRuntimeVersion,
      architecture: 'x64',
      pathRefreshRequired: false,
      systemRestartRequired: false,
    })
    // No index.json or SHASUMS256.txt: the version and digest come from the app itself.
    expect(network.requested).toEqual([
      `https://npmmirror.com/mirrors/node/${linuxNodeRuntimeVersion}/node-${linuxNodeRuntimeVersion}-linux-x64.tar.gz`,
    ])
    const target = managedNodeRuntimeRoot({ HOME: home }, 'linux')
    expect(target).toBe(path.join(home, '.local', 'share', 'XingMangAI', 'Runtime', 'node'))
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('node')
    expect(processes.plans.map((plan) => plan.executable)[0]).toBe('/usr/bin/tar')
    // The version probe runs the extracted binary itself, before it is moved into place.
    expect(processes.plans[1].executable).toMatch(/\/npmmirror\/extract\/node-v[\d.]+-linux-x64\/bin\/node$/)
    expect(processes.plans[1].argv).toEqual(['--version'])
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
    expect(progress).toContain('正在核对文件')
    expect(progress).toContain('正在解压 Node.js')
  })

  it.skipIf(process.platform === 'win32')('follows XDG_DATA_HOME for the runtime location', async () => {
    const home = temporaryHome()
    const dataHome = path.join(home, 'data')
    await installLinuxNodeRuntime({
      networkRegion: 'outside-mainland-china',
      architecture: 'x64',
      environment: { HOME: home, XDG_DATA_HOME: dataHome },
      dependencies: { fetch: fakeNetwork().fetch },
      linux: { runProcess: fakeProcesses().runProcess, resolveTar: () => '/usr/bin/tar', pinnedRelease: () => pinned },
    })
    expect(fs.existsSync(path.join(dataHome, 'XingMangAI', 'Runtime', 'node', 'bin', 'node'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.local'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('replaces an earlier copy and falls back to the second source', async () => {
    const home = temporaryHome()
    const target = managedNodeRuntimeRoot({ HOME: home }, 'linux')
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(target, 'bin', 'node'), 'old')
    // A staging directory left behind by an interrupted run is cleaned up first.
    fs.mkdirSync(path.join(path.dirname(target), 'node-staging-stale'))

    const installed = await installLinuxNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'x64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork({ failHosts: ['npmmirror.com'] }).fetch },
      linux: { runProcess: fakeProcesses().runProcess, resolveTar: () => '/usr/bin/tar', pinnedRelease: () => pinned },
    })

    expect(installed.source).toBe('official')
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('node')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
  })

  it.skipIf(process.platform === 'win32')('refuses bytes whose digest is not the pinned one and keeps the old runtime', async () => {
    const home = temporaryHome()
    const target = managedNodeRuntimeRoot({ HOME: home }, 'linux')
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(target, 'bin', 'node'), 'old')
    const processes = fakeProcesses()

    await expect(installLinuxNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'x64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork({}, Buffer.alloc(2 * 1024 * 1024, 8)).fetch },
      linux: { runProcess: processes.runProcess, resolveTar: () => '/usr/bin/tar', pinnedRelease: () => pinned },
    })).rejects.toThrow(/^Node\.js 没有准备好.*和官方校验值对不上/)
    // Nothing is extracted from an archive that failed its digest.
    expect(processes.plans).toEqual([])
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('old')
  })

  it.skipIf(process.platform === 'win32')('refuses a binary that reports a different version than the pinned one', async () => {
    const home = temporaryHome()
    await expect(installLinuxNodeRuntime({
      networkRegion: 'outside-mainland-china',
      architecture: 'x64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork().fetch },
      linux: {
        runProcess: fakeProcesses({ reportedVersion: 'v18.19.1' }).runProcess,
        resolveTar: () => '/usr/bin/tar',
        pinnedRelease: () => pinned,
      },
    })).rejects.toThrow('版本和下载的不一致')
    expect(fs.existsSync(managedNodeRuntimeRoot({ HOME: home }, 'linux'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('stops before downloading anything when no trustworthy tar exists', async () => {
    const home = temporaryHome()
    const network = fakeNetwork()
    await expect(installLinuxNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'x64',
      environment: { HOME: home },
      dependencies: { fetch: network.fetch },
      linux: { runProcess: fakeProcesses().runProcess, resolveTar: () => null, pinnedRelease: () => pinned },
    })).rejects.toThrow('找不到系统自带的解压工具')
    expect(network.requested).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('refuses an unsupported chip before touching the disk or the network', async () => {
    const home = temporaryHome()
    const network = fakeNetwork()
    await expect(installLinuxNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'loong64' as NodeJS.Architecture,
      environment: { HOME: home },
      dependencies: { fetch: network.fetch },
      linux: { runProcess: fakeProcesses().runProcess, resolveTar: () => '/usr/bin/tar', pinnedRelease: () => pinned },
    })).rejects.toThrow(/loong64/)
    expect(network.requested).toEqual([])
    expect(fs.readdirSync(home)).toEqual([])
  })

  // The real extraction path: system tar under the fixed PATH, then the extracted binary's
  // own --version, on an archive shaped like the official one.
  it.runIf(process.platform === 'linux' && resolveLinuxTarExecutable() !== null)(
    'extracts a real archive with the system tar and runs the extracted binary',
    async () => {
      const home = temporaryHome()
      const build = path.join(home, 'build')
      const top = path.join(build, linuxNodeArchiveTopDirectory(linuxNodeRuntimeVersion, 'x64'))
      fs.mkdirSync(path.join(top, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(top, 'bin', 'node'), `#!/bin/sh\necho ${linuxNodeRuntimeVersion}\n`, { mode: 0o755 })
      fs.mkdirSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
      fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(top, 'bin', 'npm'))
      // Incompressible filler keeps the archive above the download's 1 MB floor.
      fs.writeFileSync(path.join(top, 'lib', 'filler.bin'), randomBytes(1536 * 1024))
      const archive = path.join(home, 'node.tar.gz')
      execFileSync(resolveLinuxTarExecutable()!, ['-c', '-z', '-f', archive, '-C', build, path.basename(top)], {
        env: { PATH: linuxExtractPath },
      })
      const bytes = fs.readFileSync(archive)
      const environment = { HOME: path.join(home, 'user') }

      await installLinuxNodeRuntime({
        networkRegion: 'mainland-china',
        architecture: 'x64',
        environment,
        dependencies: { fetch: fakeNetwork({}, bytes).fetch },
        linux: {
          pinnedRelease: () => ({
            version: linuxNodeRuntimeVersion,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }),
        },
      })

      const target = managedNodeRuntimeRoot(environment, 'linux')
      expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toContain(linuxNodeRuntimeVersion)
      expect(fs.readlinkSync(path.join(target, 'bin', 'npm'))).toBe('../lib/node_modules/npm/bin/npm-cli.js')
      expect(fs.statSync(path.join(target, 'bin', 'node')).uid).toBe(process.getuid?.())
    },
  )
})
