import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandRunnerError, type CommandResult } from './command-runner'
import { darwinCommandPathCandidates } from './macos-platform'
import { managedNodeRuntimeBinDirectory, managedNodeRuntimeRoot } from './managed-cli-paths'
import {
  buildDarwinNodeExtractPlan,
  buildDarwinNodeSignaturePlan,
  darwinNodeArchiveTopDirectory,
  darwinNodeRuntimeFailureMessage,
  installDarwinNodeRuntime,
  nodeRuntimeDarwinTeamIdentifier,
  type DarwinNodeRuntimeProcess,
} from './macos-node-runtime'
import { parseNodeReleaseIndex } from './node-runtime'

const version = 'v22.12.0'
const archiveBytes = Buffer.alloc(2 * 1024 * 1024, 7)
const archiveSha256 = createHash('sha256').update(archiveBytes).digest('hex')

const releaseIndex = JSON.stringify([
  { version: 'v23.3.0', lts: false, files: ['osx-arm64-tar', 'osx-x64-tar'] },
  { version, lts: 'Jod', files: ['osx-arm64-tar', 'osx-x64-tar', 'win-x64-msi'] },
  { version: 'v20.18.1', lts: 'Iron', files: ['osx-arm64-tar', 'osx-x64-tar'] },
])

function shasums(sha = archiveSha256): string {
  return [
    `${'a'.repeat(64)}  node-${version}-darwin-x64.tar.gz`,
    `${sha}  node-${version}-darwin-arm64.tar.gz`,
    `${'b'.repeat(64)}  node-${version}-arm64.msi`,
  ].join('\n')
}

function result(plan: DarwinNodeRuntimeProcess, stdout = ''): CommandResult {
  return { executable: plan.executable, argv: [...plan.argv], exitCode: 0, signal: null, stdout, stderr: '', outputBytes: 0, durationMs: 1 }
}

interface FakeOptions {
  failHosts?: string[]
  checksum?: string
  signatureExitCode?: number
  reportedVersion?: string
}

function fakeNetwork(options: FakeOptions = {}) {
  const requested: string[] = []
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    if (options.failHosts?.some((host) => url.includes(host))) throw new TypeError('fetch failed')
    if (url.endsWith('/index.json')) return new Response(releaseIndex)
    if (url.endsWith('/SHASUMS256.txt')) return new Response(shasums(options.checksum))
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
  it('selects the newest LTS release that ships a macOS archive', () => {
    expect(parseNodeReleaseIndex(releaseIndex, 'arm64', 'darwin-archive')).toEqual({
      version,
      lts: 'Jod',
      architecture: 'arm64',
      fileName: `node-${version}-darwin-arm64.tar.gz`,
    })
    // The Windows default keeps asking for the MSI, so the Windows path is untouched.
    expect(parseNodeReleaseIndex(releaseIndex, 'x64')?.fileName).toBe(`node-${version}-x64.msi`)
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
      darwin: { runProcess: processes.runProcess },
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
    expect(network.requested[0]).toBe('https://npmmirror.com/mirrors/node/index.json')
    const target = managedNodeRuntimeRoot({ HOME: home }, 'darwin')
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('node')
    expect(processes.plans.map((plan) => plan.executable).slice(0, 2)).toEqual(['/usr/bin/tar', '/usr/bin/codesign'])
    // The version probe runs the extracted binary itself, before it is moved into place.
    expect(processes.plans[2].executable).toMatch(/\/npmmirror\/extract\/node-v22\.12\.0-darwin-arm64\/bin\/node$/)
    expect(processes.plans[2].argv).toEqual(['--version'])
    // The staging directory is gone and only the finished runtime is left behind.
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
    expect(progress).toContain('正在核对文件')
    expect(progress).toContain('正在解压 Node.js')
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
      darwin: { runProcess: fakeProcesses().runProcess },
    })

    expect(installed.source).toBe('official')
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('node')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
  })

  it.skipIf(process.platform === 'win32')('refuses an archive whose digest does not match the checksum list', async () => {
    const home = temporaryHome()
    const processes = fakeProcesses()
    await expect(installDarwinNodeRuntime({
      networkRegion: 'mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork({ checksum: 'c'.repeat(64) }).fetch },
      darwin: { runProcess: processes.runProcess },
    })).rejects.toThrow('和官方校验值对不上')
    // Nothing is extracted from an archive that failed its digest.
    expect(processes.plans).toEqual([])
    expect(fs.existsSync(managedNodeRuntimeRoot({ HOME: home }, 'darwin'))).toBe(false)
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
      darwin: { runProcess: fakeProcesses({ signatureExitCode: 3 }).runProcess },
    })).rejects.toThrow(/^Node\.js 没有准备好.*没有通过官方签名核对/)
    expect(fs.readFileSync(path.join(target, 'bin', 'node'), 'utf8')).toBe('old')
    expect(fs.readdirSync(path.dirname(target))).toEqual(['node'])
  })

  it.skipIf(process.platform === 'win32')('refuses a binary that reports a different version than the one selected', async () => {
    const home = temporaryHome()
    await expect(installDarwinNodeRuntime({
      networkRegion: 'outside-mainland-china',
      architecture: 'arm64',
      environment: { HOME: home },
      dependencies: { fetch: fakeNetwork().fetch },
      darwin: { runProcess: fakeProcesses({ reportedVersion: 'v18.0.0' }).runProcess },
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
