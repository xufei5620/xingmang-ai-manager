import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeDesktopComponentManifest, ClaudeDesktopVmFile } from './claude-desktop-component-manifest'
import {
  claudeDesktopVmPlatformKey,
  claudeDesktopWorkspaceFilePaths,
  claudeDesktopWorkspaceObjectKey,
  claudeDesktopWorkspacePaths,
  claudeDesktopWorkspaceRedeliverMs,
  claudeDesktopWorkspaceRetryCooldownMs,
  createClaudeDesktopWorkspaceSeeder,
  inspectClaudeDesktopWorkspaceFile,
  parseDeliveredState,
  type ClaudeDesktopWorkspaceSeederOptions,
} from './claude-desktop-workspace-seed'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'

// The VM version Claude Desktop 4.4212.0 pins (probe run 41623510171, 2026-11-03).
const sha = '072b6cbfe74f428a98bd86035f83b322b369d1f1'

const temporaryRoots: string[] = []
function temporaryDirectory(): string {
  // realpath: macOS hands out /var/... which is a link to /private/var, and the safe writers refuse links.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-workspace-seed-')))
  temporaryRoots.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function vmFile(name: string, content: Buffer, rawSize: number | null = null): ClaudeDesktopVmFile {
  return { name, checksum: sha256(content), size: content.length, rawChecksum: null, rawSize }
}

interface FixtureOptions {
  platform?: NodeJS.Platform
  adopted?: boolean
  overrides?: Partial<ClaudeDesktopWorkspaceSeederOptions>
  serve?: (url: string, files: Map<string, Buffer>) => Response | null
}

function workspaceFixture(fixtureOptions: FixtureOptions = {}) {
  const root = temporaryDirectory()
  const profile = path.join(root, 'Claude-3p')
  const asar = path.join(root, 'app.asar')
  fs.writeFileSync(asar, 'asar')
  const rootfs = randomBytes(64 * 1024)
  const kernel = randomBytes(4 * 1024)
  const files = [vmFile('rootfs.img', rootfs, 512 * 1024), vmFile('vmlinuz', kernel)]
  const contents = new Map([['rootfs.img', rootfs], ['vmlinuz', kernel]])
  const manifest: ClaudeDesktopComponentManifest = {
    code: null,
    vm: { sha, files: { unix: { arm64: files }, win32: { x64: files } } },
  }
  const { bundleDirectory, adoptedMarkerPath } = claudeDesktopWorkspacePaths(profile)
  if (fixtureOptions.adopted !== false) {
    fs.mkdirSync(bundleDirectory, { recursive: true })
    fs.writeFileSync(adoptedMarkerPath, '')
  }
  const platform = fixtureOptions.platform ?? 'darwin'
  const platformKey = platform === 'win32' ? 'win32' : 'unix'
  const architecture = platform === 'win32' ? 'x64' : 'arm64'
  const urls = new Map(files.map((file) => [`${desktopPackageBucketOrigin}/${claudeDesktopWorkspaceObjectKey(sha, platformKey, architecture, file)}`, file.name]))
  const served: Map<string, Buffer> = new Map([...urls].map(([url, name]) => [url, contents.get(name) ?? Buffer.alloc(0)]))
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input)
    const custom = fixtureOptions.serve?.(url, served)
    if (custom) return custom
    const body = served.get(url)
    if (!body) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } })
  })
  const log = vi.fn<NonNullable<ClaudeDesktopWorkspaceSeederOptions['log']>>()
  const readManifest = vi.fn(async () => manifest)
  const stateDirectory = path.join(root, 'manager', 'claude-desktop-components')
  let clock = 1_800_000_000_000
  const seeder = createClaudeDesktopWorkspaceSeeder({
    platform,
    executionMode: 'same-user',
    fetch: fetchMock as unknown as typeof fetch,
    resolveTarget: async () => ({ profileDirectory: profile, asarPath: asar, architecture }),
    stateDirectory,
    userHome: root,
    readManifest,
    readDiskSpace: async () => null,
    pathModule: path,
    resumeDelaysMs: [0],
    now: () => clock,
    log,
    ...fixtureOptions.overrides,
  })
  return {
    root, profile, asar, files, contents, manifest, bundleDirectory, adoptedMarkerPath, seeder, fetchMock, log, readManifest, stateDirectory, served,
    advance(milliseconds: number) { clock += milliseconds },
  }
}

function listBundle(directory: string): string[] {
  return fs.readdirSync(directory).sort()
}

describe('claude desktop workspace seed: names and places', () => {
  it('maps the platforms Claude ships a workspace for', () => {
    expect(claudeDesktopVmPlatformKey('win32')).toBe('win32')
    expect(claudeDesktopVmPlatformKey('darwin')).toBe('unix')
    expect(claudeDesktopVmPlatformKey('linux')).toBeNull()
  })

  it('puts the version, platform and checksum in the bucket key so a key never changes content', () => {
    const file = { name: 'rootfs.vhdx', checksum: 'a'.repeat(64) }
    expect(claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', file))
      .toBe(`xingmang/offline/claude-components/vm/${sha}/win32-x64/${'a'.repeat(64)}/rootfs.vhdx.zst`)
    expect(() => claudeDesktopWorkspaceObjectKey('main', 'win32', 'x64', file)).toThrow()
    expect(() => claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', { ...file, checksum: 'A'.repeat(64) })).toThrow()
    expect(() => claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', { ...file, name: '../rootfs' })).toThrow()
    expect(() => claudeDesktopWorkspaceObjectKey(sha, 'win32', 'x64', { ...file, name: 'a/b' })).toThrow()
  })

  it('uses the same file names Claude reads its cache from', () => {
    const { bundleDirectory, adoptedMarkerPath } = claudeDesktopWorkspacePaths('/p/Claude-3p', path.posix)
    expect(bundleDirectory).toBe('/p/Claude-3p/vm_bundles/claudevm.bundle')
    expect(adoptedMarkerPath).toBe('/p/Claude-3p/vm_bundles/claudevm.bundle/.cowork-adopted')
    expect(claudeDesktopWorkspaceFilePaths(bundleDirectory, 'rootfs.img', path.posix)).toEqual({
      raw: '/p/Claude-3p/vm_bundles/claudevm.bundle/rootfs.img',
      rawOrigin: '/p/Claude-3p/vm_bundles/claudevm.bundle/.rootfs.img.origin',
      cache: '/p/Claude-3p/vm_bundles/claudevm.bundle/rootfs.img.zst',
      cacheOrigin: '/p/Claude-3p/vm_bundles/claudevm.bundle/.rootfs.img.zst.origin',
    })
    expect(() => claudeDesktopWorkspaceFilePaths(bundleDirectory, '..', path.posix)).toThrow()
  })

  it('reads a file as ready, cached or missing the way Claude does', async () => {
    const directory = temporaryDirectory()
    const file = { name: 'vmlinuz', size: 3 }
    expect(await inspectClaudeDesktopWorkspaceFile(directory, file, sha)).toBe('missing')
    fs.writeFileSync(path.join(directory, 'vmlinuz.zst'), 'abc')
    fs.writeFileSync(path.join(directory, '.vmlinuz.zst.origin'), `${sha}\n`)
    // Claude compares the origin byte for byte, so a trailing newline is not its version.
    expect(await inspectClaudeDesktopWorkspaceFile(directory, file, sha)).toBe('missing')
    fs.writeFileSync(path.join(directory, '.vmlinuz.zst.origin'), sha)
    expect(await inspectClaudeDesktopWorkspaceFile(directory, file, sha)).toBe('cached')
    expect(await inspectClaudeDesktopWorkspaceFile(directory, { ...file, size: 4 }, sha)).toBe('missing')
    fs.writeFileSync(path.join(directory, 'vmlinuz'), 'kernel')
    fs.writeFileSync(path.join(directory, '.vmlinuz.origin'), sha)
    expect(await inspectClaudeDesktopWorkspaceFile(directory, { ...file, size: 4 }, sha)).toBe('ready')
    expect(await inspectClaudeDesktopWorkspaceFile(directory, file, 'b'.repeat(40))).toBe('missing')
  })

  it('keeps only well-formed delivery records', () => {
    expect(parseDeliveredState(null)).toEqual([])
    expect(parseDeliveredState('{')).toEqual([])
    expect(parseDeliveredState(JSON.stringify({ version: 2, delivered: [] }))).toEqual([])
    expect(parseDeliveredState(JSON.stringify({ version: 1, delivered: [{ key: 'workspace:a', at: 5 }, { key: 'bad key', at: 1 }, { key: 'x', at: 'y' }, null] })))
      .toEqual([{ key: 'workspace:a', at: 5 }])
  })
})

describe('claude desktop workspace seed: putting it in place', () => {
  it('downloads the official files from the bucket and leaves them where Claude reads its cache', async () => {
    const f = workspaceFixture()
    const placed = vi.fn()
    const progress: number[] = []
    const seeder = createClaudeDesktopWorkspaceSeeder({
      platform: 'darwin', executionMode: 'same-user', fetch: f.fetchMock as unknown as typeof fetch,
      resolveTarget: async () => ({ profileDirectory: f.profile, asarPath: f.asar, architecture: 'arm64' }),
      stateDirectory: f.stateDirectory, userHome: f.root, readManifest: f.readManifest, readDiskSpace: async () => null,
      resumeDelaysMs: [0], onPlaced: placed, onProgress: (event) => progress.push(event.transferred), log: f.log,
    })
    const total = f.files.reduce((sum, file) => sum + file.size, 0)
    expect(await seeder.seed('/Applications/Claude.app')).toEqual({ status: 'placed', sha, files: 2, bytes: total })
    expect(listBundle(f.bundleDirectory)).toEqual(['.cowork-adopted', '.rootfs.img.zst.origin', '.vmlinuz.zst.origin', 'rootfs.img.zst', 'vmlinuz.zst'])
    for (const [name, content] of f.contents) {
      expect(fs.readFileSync(path.join(f.bundleDirectory, `${name}.zst`)).equals(content)).toBe(true)
      expect(fs.readFileSync(path.join(f.bundleDirectory, `.${name}.zst.origin`), 'utf8')).toBe(sha)
    }
    expect(placed).toHaveBeenCalledWith({ sha, files: 2, bytes: total })
    expect(progress.at(-1)).toBe(total)
    expect(f.fetchMock).toHaveBeenCalledTimes(2)
    for (const call of f.fetchMock.mock.calls) {
      expect(String(call[0]).startsWith(`${desktopPackageBucketOrigin}/xingmang/offline/claude-components/vm/${sha}/unix-arm64/`)).toBe(true)
    }
    const state = JSON.parse(fs.readFileSync(path.join(f.stateDirectory, 'delivered.json'), 'utf8')) as { delivered: { key: string }[] }
    expect(state.delivered).toHaveLength(1)
    expect(state.delivered[0].key).toMatch(new RegExp(`^workspace:${sha}:unix-arm64:[0-9a-f]{16}$`))
    expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.workspace-seed.placed', expect.any(String), expect.objectContaining({ sha: sha.slice(0, 12), files: 2 }))

    // Second look: it is all there now, so nothing is downloaded again.
    expect(await seeder.seed('/Applications/Claude.app')).toEqual({ status: 'ready', sha })
    expect(f.fetchMock).toHaveBeenCalledTimes(2)
  })

  it('downloads only what is missing and never touches what Claude already unpacked', async () => {
    const f = workspaceFixture({ platform: 'win32' })
    fs.writeFileSync(path.join(f.bundleDirectory, 'vmlinuz'), 'unpacked by claude')
    fs.writeFileSync(path.join(f.bundleDirectory, '.vmlinuz.origin'), sha)
    const outcome = await f.seeder.seed('C:\\Program Files\\Claude\\Claude.exe')
    expect(outcome).toEqual({ status: 'placed', sha, files: 1, bytes: f.files[0].size })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(String(f.fetchMock.mock.calls[0][0])).toContain(`/vm/${sha}/win32-x64/${f.files[0].checksum}/rootfs.img.zst`)
    expect(fs.readFileSync(path.join(f.bundleDirectory, 'vmlinuz'), 'utf8')).toBe('unpacked by claude')
    expect(fs.existsSync(path.join(f.bundleDirectory, 'vmlinuz.zst'))).toBe(false)
  })

  it('does not download a byte until Claude has asked for the workspace itself', async () => {
    const f = workspaceFixture({ adopted: false })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'not-adopted' })
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(fs.existsSync(f.bundleDirectory)).toBe(false)
    expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.workspace-seed.skipped', expect.any(String), expect.objectContaining({ reason: 'not-adopted' }))
  })

  it('throws away a bucket file that does not match the checksum in Claude itself', async () => {
    const f = workspaceFixture({
      serve: (url, served) => {
        const body = served.get(url)
        if (!body || !url.includes('rootfs.img')) return null
        const tampered = Buffer.from(body)
        tampered[0] ^= 0xff
        return new Response(new Uint8Array(tampered), { status: 200, headers: { 'content-length': String(tampered.length) } })
      },
    })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(listBundle(f.bundleDirectory)).toEqual(['.cowork-adopted'])
    expect(fs.existsSync(path.join(f.stateDirectory, 'delivered.json'))).toBe(false)
    expect(f.log).toHaveBeenCalledWith('warn', 'claude-desktop.workspace-seed.skipped', expect.any(String), expect.objectContaining({ reason: 'download-failed', file: 'rootfs.img' }))
  })

  it('refuses a bucket answer whose declared size differs from the manifest', async () => {
    const f = workspaceFixture({
      serve: (url, served) => {
        const body = served.get(url)
        if (!body) return null
        return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length + 1) } })
      },
    })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(listBundle(f.bundleDirectory)).toEqual(['.cowork-adopted'])
  })

  it('refuses a redirect out of the bucket', async () => {
    const f = workspaceFixture({ serve: () => new Response(null, { status: 302, headers: { location: 'https://example.com/rootfs.img.zst' } }) })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(f.fetchMock.mock.calls.every((call) => String(call[0]).startsWith(desktopPackageBucketOrigin))).toBe(true)
    expect(f.fetchMock.mock.calls.every((call) => (call[1] as RequestInit | undefined)?.redirect === 'manual')).toBe(true)
  })

  it('waits a while after a failed download instead of pulling the same files again on every recheck', async () => {
    let broken = true
    const f = workspaceFixture({ serve: () => (broken ? new Response('gone', { status: 503 }) : null) })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'download-failed' })
    const calls = f.fetchMock.mock.calls.length
    broken = false
    f.advance(10 * 60_000)
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'recently-failed' })
    expect(f.fetchMock.mock.calls.length).toBe(calls)
    f.advance(claudeDesktopWorkspaceRetryCooldownMs)
    expect((await f.seeder.seed('/Applications/Claude.app')).status).toBe('placed')
  })

  it('downloads the same version at most once a week per machine when Claude does not take it', async () => {
    const f = workspaceFixture()
    expect((await f.seeder.seed('/Applications/Claude.app')).status).toBe('placed')
    // Claude rejected the cache and deleted it.
    for (const name of ['rootfs.img.zst', '.rootfs.img.zst.origin', 'vmlinuz.zst', '.vmlinuz.zst.origin']) fs.rmSync(path.join(f.bundleDirectory, name))
    f.advance(24 * 60 * 60_000)
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'recently-delivered' })
    expect(f.fetchMock).toHaveBeenCalledTimes(2)
    f.advance(claudeDesktopWorkspaceRedeliverMs)
    expect((await f.seeder.seed('/Applications/Claude.app')).status).toBe('placed')
    expect(f.fetchMock).toHaveBeenCalledTimes(4)
  })

  it('skips without downloading when the disk cannot hold the archive and what Claude unpacks from it', async () => {
    const readDiskSpace = vi.fn(async (target: string) => ({ availableBytes: 1024 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 * 1024, measuredPath: target, deviceId: null }))
    const f = workspaceFixture({ overrides: { readDiskSpace } })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(readDiskSpace).toHaveBeenCalledWith(f.profile)
  })

  it('stays out when switched off remotely, elevated on Windows, or on a system without a workspace', async () => {
    const off = workspaceFixture({ overrides: { isOff: () => true } })
    expect(await off.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'remote-off' })
    const elevated = workspaceFixture({ platform: 'win32', overrides: { executionMode: 'trusted-only' } })
    expect(await elevated.seeder.seed('C:\\Claude.exe')).toEqual({ status: 'skipped', reason: 'not-same-user' })
    const linux = workspaceFixture({ overrides: { platform: 'linux' } })
    expect(await linux.seeder.seed('/opt/Claude')).toEqual({ status: 'skipped', reason: 'unsupported-platform' })
    for (const f of [off, elevated, linux]) {
      expect(f.fetchMock).not.toHaveBeenCalled()
      expect(f.readManifest).not.toHaveBeenCalled()
    }
  })

  it('skips when Claude changed its manifest or ships no workspace for this machine', async () => {
    const noVm = workspaceFixture({ overrides: { readManifest: async () => ({ code: null, vm: null }) } })
    expect(await noVm.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'manifest-not-found' })
    const x64 = workspaceFixture({ overrides: { resolveTarget: async () => null } })
    expect(await x64.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'target-unresolved' })
    const otherArch = workspaceFixture()
    const seeder = createClaudeDesktopWorkspaceSeeder({
      platform: 'darwin', executionMode: 'same-user', fetch: otherArch.fetchMock as unknown as typeof fetch,
      resolveTarget: async () => ({ profileDirectory: otherArch.profile, asarPath: otherArch.asar, architecture: 'x64' }),
      stateDirectory: otherArch.stateDirectory, userHome: otherArch.root, readManifest: otherArch.readManifest, readDiskSpace: async () => null,
    })
    expect(await seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'architecture-missing' })
    const unreadable = workspaceFixture({ overrides: { readManifest: async () => { throw new Error('bad asar') } } })
    expect(await unreadable.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'asar-unreadable' })
  })

  it('reads the manifest once per Claude build', async () => {
    const f = workspaceFixture()
    await f.seeder.seed('/Applications/Claude.app')
    await f.seeder.seed('/Applications/Claude.app')
    expect(f.readManifest).toHaveBeenCalledTimes(1)
    fs.writeFileSync(f.asar, 'asar, newer build')
    await f.seeder.seed('/Applications/Claude.app')
    expect(f.readManifest).toHaveBeenCalledTimes(2)
  })

  it('cleans up its own leftovers from an interrupted run and nothing else', async () => {
    const f = workspaceFixture()
    const ours = path.join(f.bundleDirectory, 'xingmang-0f8fad5b-d9cb-469f-a165-70867728950e-rootfs.img-zst')
    const claudes = path.join(f.bundleDirectory, 'rootfs.img.zst.tmp')
    fs.writeFileSync(ours, 'half')
    fs.writeFileSync(claudes, 'claude partial')
    expect((await f.seeder.seed('/Applications/Claude.app')).status).toBe('placed')
    expect(fs.existsSync(ours)).toBe(false)
    expect(fs.readFileSync(claudes, 'utf8')).toBe('claude partial')
    expect(fs.readdirSync(f.bundleDirectory).some((name) => name.startsWith('xingmang-'))).toBe(false)
  })

  it('refuses to write through a link planted as the cache file', async () => {
    const f = workspaceFixture()
    const elsewhere = path.join(f.root, 'elsewhere')
    fs.writeFileSync(elsewhere, 'keep')
    fs.symlinkSync(elsewhere, path.join(f.bundleDirectory, 'rootfs.img.zst'))
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'write-failed' })
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('keep')
    expect(fs.readdirSync(f.bundleDirectory).some((name) => name.startsWith('xingmang-'))).toBe(false)
  })

  it('runs the Linux Claude Code seeder for the VM before the workspace and survives its failure', async () => {
    const order: string[] = []
    const linuxCode = { seed: vi.fn(async () => { order.push('code'); throw new Error('mirror down') }) }
    const f = workspaceFixture({ overrides: { linuxCode } })
    f.fetchMock.mockImplementationOnce(async (input) => {
      order.push('workspace')
      const body = f.served.get(String(input)) ?? Buffer.alloc(0)
      return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } })
    })
    expect((await f.seeder.seed('/Applications/Claude.app')).status).toBe('placed')
    expect(order.slice(0, 2)).toEqual(['code', 'workspace'])
    expect(linuxCode.seed).toHaveBeenCalledWith({ profileDirectory: f.profile, architecture: 'arm64', pins: null })
  })

  it('shares one run between overlapping calls', async () => {
    const f = workspaceFixture()
    const [first, second] = await Promise.all([f.seeder.seed('/Applications/Claude.app'), f.seeder.seed('/Applications/Claude.app')])
    expect(first).toBe(second)
    expect(f.fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('claude desktop workspace seed: after launching Claude', () => {
  it('looks right away and again later, keeps only the latest round, and stops on dispose', async () => {
    const timers: { callback: () => void; milliseconds: number; cancelled: boolean }[] = []
    const setTimer = (callback: () => void, milliseconds: number) => {
      const timer = { callback, milliseconds, cancelled: false }
      timers.push(timer)
      return { cancel() { timer.cancelled = true } }
    }
    const f = workspaceFixture({ adopted: false, overrides: { setTimer, recheckDelaysMs: [180_000, 600_000] } })
    f.seeder.scheduleAfterLaunch('/Applications/Claude.app')
    f.seeder.scheduleAfterLaunch('/Applications/Claude.app')
    expect(timers.map((timer) => [timer.milliseconds, timer.cancelled])).toEqual([[180_000, true], [600_000, true], [180_000, false], [600_000, false]])
    await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.workspace-seed.skipped', expect.any(String), expect.objectContaining({ reason: 'not-adopted' })))
    expect(f.fetchMock).not.toHaveBeenCalled()

    // The customer opened Cowork in the meantime, so Claude wrote its marker.
    fs.mkdirSync(f.bundleDirectory, { recursive: true })
    fs.writeFileSync(f.adoptedMarkerPath, '')
    timers[2].callback()
    await vi.waitFor(() => expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.workspace-seed.placed', expect.any(String), expect.anything()))
    expect(f.fetchMock).toHaveBeenCalledTimes(2)

    f.seeder.dispose()
    expect(timers[3].cancelled).toBe(true)
    f.seeder.scheduleAfterLaunch('/Applications/Claude.app')
    expect(timers).toHaveLength(4)
  })

  it('schedules nothing where Claude has no workspace', () => {
    const setTimer = vi.fn(() => ({ cancel() {} }))
    const f = workspaceFixture({ overrides: { platform: 'linux', setTimer } })
    f.seeder.scheduleAfterLaunch('/opt/Claude')
    expect(setTimer).not.toHaveBeenCalled()
    expect(f.readManifest).not.toHaveBeenCalled()
  })
})

describe('claude desktop workspace seed: remote switch mid-way', () => {
  it('stops after the file in hand when switched off during the download', async () => {
    let off = false
    const f = workspaceFixture({ overrides: { isOff: () => off, onProgress: () => { off = true } } })
    expect(await f.seeder.seed('/Applications/Claude.app')).toEqual({ status: 'skipped', reason: 'remote-off' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(listBundle(f.bundleDirectory)).toEqual(['.cowork-adopted', '.rootfs.img.zst.origin', 'rootfs.img.zst'])
    expect(fs.existsSync(path.join(f.stateDirectory, 'delivered.json'))).toBe(false)
  })
})
