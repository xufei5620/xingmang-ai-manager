import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRunnerError, type CommandResult } from './command-runner'
import { darwinCommandPathCandidates } from './macos-platform'
import { managedNodeRuntimeBinDirectory, managedNodeRuntimeRoot } from './managed-cli-paths'
import { linuxNodeRuntimeVersion } from './linux-node-runtime'
import {
  buildDarwinNodeExtractPlan,
  buildDarwinNodeSignaturePlan,
  darwinNodeArchiveTopDirectory,
  darwinNodeRuntimeFailureMessage,
  darwinNodeRuntimePinnedRelease,
  darwinNodeRuntimeVersion,
  installDarwinNodeRuntime,
  nodeRuntimeDarwinTeamIdentifier,
  resolveDarwinPreferredNodeDirectory,
  type DarwinNodeRuntimeProcess,
} from './macos-node-runtime'
import { nodeVersionStatus } from './versions'

const version = darwinNodeRuntimeVersion
const archiveBytes = Buffer.alloc(2 * 1024 * 1024, 7)
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')
const pinned = { version, sha256: archiveSha256 }
const archiveFile = `${version}/node-${version}-darwin-arm64.tar.gz`

function result(plan: DarwinNodeRuntimeProcess, stdout = ''): CommandResult {
  return { executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: 0, durationMs: 1 }
}

interface FakeOptions {
  failHosts?: string[]
  signatureExitCode?: number
  reportedVersion?: string
}

function fakeNetwork(options: FakeOptions = {}) {
  const requested: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (options.failHosts?.some((host) => url.includes(host))) throw new TypeError('fetch failed')
    if (url.endsWith('.tar.gz')) {
      return new Response(archiveBytes, { headers: { 'content-length': String(archiveBytes.byteLength) } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof globalThis.fetch
  return { fetch, requested }
}

function fakeProcesses(options: FakeOptions = {}) {
  const plans: DarwinNodeRuntimeProcess[] = []
  const runProcess = async (plan: DarwinNodeRuntimeProcess): Promise<CommandResult> => {
    plans.push(plan)
    if (plan.executable === '/usr/bin/tar') {
      const destination = plan.argv[3]
      const top = path.join(destination, darwinNodeArchiveTopDirectory(version, 'arm64'))
      fs.mkdirSync(path.join(top, 'bin'), { recursive: true })
      fs.writeFileSync(path.join(top, 'bin', 'node'), 'node', { mode: 0o755 })
      fs.mkdirSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(top, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
      return result(plan)
    }
    if (plan.executable === '/usr/bin/codesign') {
      if (options.signatureExitCode !== undefined) {
        throw new CommandRunnerError('codesign failed', {
          code: 'EXIT_NON_ZERO',
          executable: plan.executable,
          argv: [...plan.argv],
          exitCode: options.signatureExitCode,
          signal: null,
          stdout: '',
          stderr: '',
          outputBytes: 0,
          maxOutputBytes: 1,
          durationMs: 1,
        })
      }
      return result(plan)
    }
    return result(plan, `${options.reportedVersion ?? version}\n`)
  }
  return { runProcess, plans }
}

const temporaryDirectories: string[] = []

function temporaryHome(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-mac-node-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('macOS managed Node.js runtime', () => {
  it('pins one reviewed release with a digest for each Mac architecture', () => {
    expect(nodeVersionStatus(darwinNodeRuntimeVersion)).toBe('supported')
    const x64 = darwinNodeRuntimePinnedRelease('x64')
    const arm64 = darwinNodeRuntimePinnedRelease('arm64')
    expect(x64.version).toBe(darwinNodeRuntimeVersion)
    expect(arm64.version).toBe(darwinNodeRuntimeVersion)
    expect(x64.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(arm64.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(x64.sha256).not.toBe(arm64.sha256)
  })

  // 两份钉的是同一版：抬版本时一起改，免得只记得改一边。真要分开时再删掉这一条。
  it('pins the same Node.js release as the Linux build', () => {
    expect(darwinNodeRuntimeVersion).toBe(linuxNodeRuntimeVersion)
  })

  it('extracts with the SIP-protected tar and verifies the Node.js Developer ID', () => {
    expect(buildDarwinNodeExtractPlan('/tmp/a/node.tar.gz', '/tmp/a/extract')).toMatchObject({
      executable: '/usr/bin/tar',
      argv: ['-xzf', '/tmp/a/node.tar.gz', '-C', '/tmp/a/extract'],
    })
    expect(() => buildDarwinNodeExtractPlan('node.tar.gz', '/tmp/a/extract')).toThrow()
    const signature = buildDarwinNodeSignaturePlan('/tmp/a/bin/node')
    expect(signature.executable).toBe('/usr/bin/codesign')
    expect(signature.argv.join(' ')).toContain(`certificate leaf[subject.OU] = "${nodeRuntimeDarwinTeamIdentifier}"`)
    expect(signature.argv.at(-1)).toBe('/tmp/a/bin/node')
  })

  it('puts the app-downloaded Node.js after every runtime the user installed', () => {
    const env = { HOME: '/Users/alex', PATH: '/Users/alex/.nvm/versions/node/v22.0.0/bin' }
    const candidates = darwinCommandPathCandidates(env, [], '/Users/alex')
    const managed = managedNodeRuntimeBinDirectory(env, 'darwin')
    expect(managed).toBe('/Users/alex/Library/Application Support/XingMangAI/Runtime/node/bin')
    expect(candidates.at(-1)).toBe(managed)
    expect(candidates.indexOf('/opt/homebrew/bin')).toBeLessThan(candidates.indexOf(managed))
    expect(candidates.indexOf(env.PATH)).toBeLessThan(candidates.indexOf(managed))
  })

  it('says the network is the likely cause only when every source failed before the download finished', () => {
    expect(darwinNodeRuntimeFailureMessage([{ stage: 'network', detail: '国内镜像：fetch failed' }]))
      .toMatch(/^Node\.js 没有下载成功，可能是网络不稳/)
    expect(darwinNodeRuntimeFailureMessage([
      { stage: 'network', detail: '国内镜像：fetch failed' },
      { stage: 'verify', detail: 'Node.js 官方源：签名不对' },
    ])).toMatch(/^Node\.js 没有准备好/)
  })

  it.skipIf(process.platform === 'win32')('downloads, verifies and extracts into the product folder', async () => {
    const home = temporaryHome()
    const network = fakeNetwork()
    const processes = fakeProcesses()
    const progress: string[] = []
    const installed = await installDarwinNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: network.fetch },
      darwin: { runProcess: processes.runProcess, pinnedRelease: () => pinned },
      onProgress: (entry) => progress.push(entry.message),
    })

    expect(installed).toMatchObject({
      installed: true,
      action: 'installed',
      method: 'archive',
      source: 'npmmirror',
      version,
      architecture: 'arm64',
      pathRefreshRequired: false,
      systemRestartRequired: false,
    })
    // Only the archive itself is fetched: no release index, no checksum list from the mirror.
    expect(network.requested).toEqual([`https://npmmirror.com/mirrors/node/${archiveFile}`])
    expect(progress[0]).toBe(`正在下载 Node.js ${version}`)
    const target = managedNodeRuntimeRoot({ HOME: home }, 'darwin')
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('node')
    expect(processes.plans.map((plan) => plan.executable).slice(0, 2)).toEqual(['/usr/bin/tar', '/usr/bin/codesign'])
    // The version probe runs the extracted binary itself, before it is moved into place.
    expect(processes.plans[2].executable.endsWith(`/npmmirror/extract/node-${version}-darwin-arm64/bin/node`)).toBe(true)
    expect(processes.plans[2].argv).toEqual(['--version'])
    // The staging directory is gone and only the finished runtime is left behind.
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
    expect(progress).toContain('正在核对文件')
    expect(progress).toContain('正在解压 Node.js')
  })

  // 本软件把「先走哪个源」做成到要下载时才问：整段装在借到的下载线路里，问的时候线路已经在了。
  it.skipIf(process.platform === 'win32')('asks for the source order only once it is about to download', async () => {
    const home = temporaryHome()
    const network = fakeNetwork()
    let asked = 0
    const installed = await installDarwinNodeRuntime({
      networkRegion: async () => {
        asked += 1
        return 'outside-mainland-china'
      },
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: network.fetch },
      darwin: { runProcess: fakeProcesses().runProcess, pinnedRelease: () => pinned },
    })

    expect(installed.source).toBe('official')
    expect(network.requested).toEqual([`https://nodejs.org/dist/${archiveFile}`])
    expect(asked).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('replaces an earlier copy and falls back to the second source', async () => {
    const home = temporaryHome()
    const target = managedNodeRuntimeRoot({ HOME: home }, 'darwin')
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(target, 'bin', 'node'), 'old')
    // A staging directory left behind by an interrupted run is cleaned up first.
    fs.mkdirSync(path.join(path.dirname(target), 'node-staging-stale'))

    const installed = await installDarwinNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork({ failHosts: ['npmmirror.com'] }).fetch },
      darwin: { runProcess: fakeProcesses().runProcess, pinnedRelease: () => pinned },
    })

    expect(installed.source).toBe('official')
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('node')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
  })

  // S02: without the seam this is the production pin, and nothing a source serves can move it.
  it.skipIf(process.platform === 'win32')('refuses bytes whose digest is not the pinned one from either source', async () => {
    const home = temporaryHome()
    const target = managedNodeRuntimeRoot({ HOME: home }, 'darwin')
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(target, 'bin', 'node'), 'old')
    const network = fakeNetwork()
    const processes = fakeProcesses()
    await expect(installDarwinNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: network.fetch },
      darwin: { runProcess: processes.runProcess },
    })).rejects.toThrow(/^Node\.js 没有准备好.*和官方校验值对不上/)
    expect(network.requested).toEqual([
      `https://npmmirror.com/mirrors/node/${archiveFile}`,
      `https://nodejs.org/dist/${archiveFile}`,
    ])
    // Nothing is extracted from an archive that failed its digest, and the old runtime stays.
    expect(processes.plans).toEqual([])
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('old')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
  })

  it.skipIf(process.platform === 'win32')('keeps the old runtime when the signature check rejects the new binary', async () => {
    const home = temporaryHome()
    const target = managedNodeRuntimeRoot({ HOME: home }, 'darwin')
    fs.mkdirSync(path.join(target, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(target, 'bin', 'node'), 'old')

    await expect(installDarwinNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork().fetch },
      darwin: { runProcess: fakeProcesses({ signatureExitCode: 3 }).runProcess, pinnedRelease: () => pinned },
    })).rejects.toThrow(/^Node\.js 没有准备好.*没有通过官方签名核对/)
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('old')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
  })

  it.skipIf(process.platform === 'win32')('refuses a binary that reports a different version than the pinned one', async () => {
    const home = temporaryHome()
    await expect(installDarwinNodeRuntime({
      networkRegion: 'outside-mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork().fetch },
      darwin: { runProcess: fakeProcesses({ reportedVersion: 'v18.0.0' }).runProcess, pinnedRelease: () => pinned },
    })).rejects.toThrow('版本和下载的不一致')
    expect(fs.existsSync(managedNodeRuntimeRoot({ HOME: home }, 'darwin'))).toBe(false)
  })

  // Confirms the pinned team identifier against a real official build: setup-node on the
  // macOS runner installs Node.js from the official darwin archives.
  it.runIf(process.platform === 'darwin' && process.env.CI === 'true')(
    'accepts the official Node.js binary running this test under the pinned Developer ID',
    async () => {
      const { runCommand } = await import('./command-runner')
      const plan = buildDarwinNodeSignaturePlan(fs.realpathSync(process.execPath))
      await expect(runCommand({ executable: plan.executable, argv: [...plan.argv] }, { timeoutMs: plan.timeoutMs }))
        .resolves.toMatchObject({ exitCode: 0 })
    },
  )
})

// 第三十四批 A：客户自己那份太旧时，本软件自己干活改用代下的那份。
describe('macOS Node.js the app runs its own work with', () => {
  const customerNode = '/usr/local/bin/node'

  function managedCopy(home: string, options: { symlink?: boolean } = {}): string {
    const directory = managedNodeRuntimeBinDirectory({ HOME: home }, 'darwin')
    fs.mkdirSync(directory, { recursive: true })
    const node = path.join(directory, 'node')
    if (options.symlink) fs.symlinkSync(customerNode, node)
    else fs.writeFileSync(node, 'node', { mode: 0o755 })
    return directory
  }

  function fakeProbe(home: string, found: string | null, versions: Record<string, string | null>) {
    const asked: string[] = []
    const searches: string[] = []
    return {
      asked,
      searches,
      probe: {
        environment: { HOME: home },
        async findNode() {
          searches.push('node')
          return found
        },
        async readVersion(executable: string) {
          asked.push(executable)
          const version = versions[executable]
          if (version === undefined) throw new Error(`unexpected version probe: ${executable}`)
          return version
        },
      },
    }
  }

  it.skipIf(process.platform === 'win32')('switches to the downloaded copy when the customer\'s own Node.js is too old', async () => {
    const home = temporaryHome()
    const directory = managedCopy(home)
    const managedNode = path.join(directory, 'node')
    const { probe, asked } = fakeProbe(home, customerNode, { [customerNode]: 'v18.19.0', [managedNode]: 'v22.12.0' })

    await expect(resolveDarwinPreferredNodeDirectory(probe)).resolves.toBe(directory)
    expect(directory).toBe(path.join(home, 'Library', 'Application Support', 'XingMangAI', 'Runtime', 'node', 'bin'))
    expect(asked).toEqual([customerNode, managedNode])
  })

  it.skipIf(process.platform === 'win32')('treats a customer version it cannot read like one that is too old', async () => {
    const home = temporaryHome()
    const directory = managedCopy(home)
    const managedNode = path.join(directory, 'node')

    for (const reported of [null, 'node-custom-build']) {
      const { probe } = fakeProbe(home, customerNode, { [customerNode]: reported, [managedNode]: 'v22.12.0' })
      await expect(resolveDarwinPreferredNodeDirectory(probe)).resolves.toBe(directory)
    }
    // A probe that fails outright counts the same: nothing usable was read.
    const failing = fakeProbe(home, customerNode, { [managedNode]: 'v22.12.0' })
    await expect(resolveDarwinPreferredNodeDirectory(failing.probe)).resolves.toBe(directory)
  })

  it.skipIf(process.platform === 'win32')('leaves the order alone when the customer\'s own Node.js is new enough', async () => {
    const home = temporaryHome()
    managedCopy(home)
    const { probe, asked } = fakeProbe(home, customerNode, { [customerNode]: 'v20.0.0' })

    await expect(resolveDarwinPreferredNodeDirectory(probe)).resolves.toBeNull()
    // The downloaded copy is not even asked once the customer's own is usable.
    expect(asked).toEqual([customerNode])
  })

  it.skipIf(process.platform === 'win32')('starts no process on a Mac without a downloaded copy', async () => {
    const home = temporaryHome()
    const missing = fakeProbe(home, customerNode, { [customerNode]: 'v16.20.2' })
    await expect(resolveDarwinPreferredNodeDirectory(missing.probe)).resolves.toBeNull()
    expect(missing.searches).toEqual([])
    expect(missing.asked).toEqual([])

    // The installer only ever leaves a regular file there; anything else is not the downloaded copy.
    managedCopy(home, { symlink: true })
    const linked = fakeProbe(home, customerNode, { [customerNode]: 'v16.20.2' })
    await expect(resolveDarwinPreferredNodeDirectory(linked.probe)).resolves.toBeNull()
    expect(linked.searches).toEqual([])
    expect(linked.asked).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('keeps the customer\'s copy first when the downloaded one is not usable either', async () => {
    const home = temporaryHome()
    const managedNode = path.join(managedCopy(home), 'node')

    for (const reported of ['v18.20.4', null]) {
      const { probe, asked } = fakeProbe(home, customerNode, { [customerNode]: 'v16.20.2', [managedNode]: reported })
      await expect(resolveDarwinPreferredNodeDirectory(probe)).resolves.toBeNull()
      expect(asked).toEqual([customerNode, managedNode])
    }
  })

  it.skipIf(process.platform === 'win32')('has nothing to reorder when the downloaded copy is already found first', async () => {
    const home = temporaryHome()
    const managedNode = path.join(managedCopy(home), 'node')

    for (const found of [managedNode, null]) {
      const { probe, asked } = fakeProbe(home, found, {})
      await expect(resolveDarwinPreferredNodeDirectory(probe)).resolves.toBeNull()
      expect(asked).toEqual([])
    }
  })
})
