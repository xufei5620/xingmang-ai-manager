import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeDesktopComponentManifest } from './claude-desktop-component-manifest'
import {
  claudeCodeMacObjectKey,
  claudeCodeMacSeedPaths,
  createClaudeDesktopMacCodeSeeder,
  extractClaudeAppBundle,
  inspectClaudeCodeMacSeed,
  inspectMachOHeader,
  parseClaudeAppBundleEntryPath,
  resolveClaudeCodeMacPin,
  type ClaudeDesktopMacCodeSeederOptions,
} from './claude-desktop-mac-code-seed'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'

const temporaryRoots: string[] = []
function temporaryDirectory(): string {
  // realpath: macOS hands out /var/... which is a link to /private/var, and the safe writers refuse links.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-mac-seed-')))
  temporaryRoots.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

interface TarEntry {
  name: string
  type?: string
  mode?: number
  content?: Buffer
  linkName?: string
}

function tarHeader(entry: TarEntry, size: number): Buffer {
  const header = Buffer.alloc(512)
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0'
  header.write(entry.name, 0, 100, 'utf8')
  header.write(octal(entry.mode ?? 0o644, 8), 100, 'latin1')
  header.write(octal(501, 8), 108, 'latin1')
  header.write(octal(20, 8), 116, 'latin1')
  header.write(octal(size, 12), 124, 'latin1')
  header.write(octal(1_792_000_000, 12), 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.write(entry.type ?? '0', 156, 'latin1')
  if (entry.linkName) header.write(entry.linkName, 157, 100, 'utf8')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  header.write('runner', 265, 'latin1')
  header.write('staff', 297, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return header
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = body.length + 1
  while (`${length}${body}`.length !== length) length += 1
  return `${length}${body}`
}

function tarArchive(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0)
    parts.push(tarHeader(entry, content.length), content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function machO(architecture: 'arm64' | 'x64', size = 1_200_000): Buffer {
  const binary = Buffer.alloc(size)
  binary.writeUInt32LE(0xfeedfacf, 0)
  binary.writeUInt32LE(architecture === 'arm64' ? 0x0100000c : 0x01000007, 4)
  binary.write('claude code', 64, 'latin1')
  return binary
}

// The layout of the real 2.1.309 darwin-arm64 claude.app.tar.zst (probe run 41624912418): four folders, four files.
function bundleEntries(binary: Buffer = machO('arm64')): TarEntry[] {
  return [
    { name: 'claude.app/', type: '5', mode: 0o755 },
    { name: 'claude.app/Contents/', type: '5', mode: 0o755 },
    { name: 'claude.app/Contents/CodeResources', content: Buffer.from('<plist>resources</plist>') },
    { name: 'claude.app/Contents/_CodeSignature/', type: '5', mode: 0o755 },
    { name: 'claude.app/Contents/MacOS/', type: '5', mode: 0o755 },
    { name: 'claude.app/Contents/Info.plist', content: Buffer.from('<plist>info</plist>') },
    { name: 'claude.app/Contents/MacOS/claude', mode: 0o755, content: binary },
    { name: 'claude.app/Contents/_CodeSignature/CodeResources', content: Buffer.from('<plist>signature</plist>') },
  ]
}

function bundleArchive(entries: TarEntry[] = bundleEntries()): Buffer {
  return zlib.zstdCompressSync(tarArchive(entries))
}

async function* chunks(buffer: Buffer, size = 700): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size)
}

interface FixtureOptions {
  archive?: Buffer
  served?: Buffer
  architecture?: 'arm64' | 'x64'
  overrides?: Partial<ClaudeDesktopMacCodeSeederOptions>
}

function macFixture(fixtureOptions: FixtureOptions = {}) {
  const root = temporaryDirectory()
  const profile = path.join(root, 'Library', 'Application Support', 'Claude-3p')
  fs.mkdirSync(profile, { recursive: true })
  const asar = path.join(root, 'app.asar')
  fs.writeFileSync(asar, 'asar')
  const archive = fixtureOptions.archive ?? bundleArchive()
  const architecture = fixtureOptions.architecture ?? 'arm64'
  const manifest: ClaudeDesktopComponentManifest = {
    code: {
      version: '2.1.309',
      macBundles: { 'darwin-arm64': { checksum: sha256(archive), size: archive.length }, 'darwin-x64': { checksum: 'c'.repeat(64), size: 98585917 } },
      linux: {},
    },
    vm: null,
  }
  const pin = resolveClaudeCodeMacPin(manifest, 'arm64')
  if (!pin) throw new Error('fixture pin')
  const url = `${desktopPackageBucketOrigin}/${claudeCodeMacObjectKey(pin)}`
  const served = fixtureOptions.served ?? archive
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    if (String(input) !== url) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(served), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(served.length) } })
  })
  const log = vi.fn<NonNullable<ClaudeDesktopMacCodeSeederOptions['log']>>()
  const readManifest = vi.fn(async () => manifest)
  const seeder = createClaudeDesktopMacCodeSeeder({
    platform: 'darwin',
    fetch: fetchMock as unknown as typeof fetch,
    resolveTarget: async () => ({ profileDirectory: profile, asarPath: asar, architecture }),
    userHome: root,
    readManifest,
    readDiskSpace: async () => null,
    resumeDelaysMs: [0],
    log,
    ...fixtureOptions.overrides,
  })
  const seedPaths = claudeCodeMacSeedPaths(profile, pin)
  return { root, profile, asar, archive, pin, url, seeder, fetchMock, log, readManifest, seedPaths }
}

function client(extra: Partial<{ running: boolean; isRunning: () => Promise<boolean | null> }> = {}) {
  return { path: '/Applications/Claude.app', running: false, ...extra }
}

describe('claude desktop mac code seed: what Claude wants', () => {
  it('picks the bundle for this Mac and rejects malformed pins', () => {
    const manifest: ClaudeDesktopComponentManifest = {
      code: { version: '2.1.309', macBundles: { 'darwin-arm64': { checksum: 'a'.repeat(64), size: 93151388 } }, linux: {} },
      vm: null,
    }
    expect(resolveClaudeCodeMacPin(manifest, 'arm64')).toEqual({ version: '2.1.309', platform: 'darwin-arm64', checksum: 'a'.repeat(64), size: 93151388 })
    expect(resolveClaudeCodeMacPin(manifest, 'x64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ code: null, vm: null }, 'arm64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ ...manifest, code: { ...manifest.code!, version: 'latest' } }, 'arm64')).toBeNull()
    expect(resolveClaudeCodeMacPin({ ...manifest, code: { ...manifest.code!, macBundles: { 'darwin-arm64': { checksum: 'A'.repeat(64), size: 1 } } } }, 'arm64')).toBeNull()
  })

  it('names the bucket object and the install folder the way Claude does', () => {
    const pin = { version: '2.1.309', platform: 'darwin-arm64' as const, checksum: '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba' }
    expect(claudeCodeMacObjectKey(pin)).toBe(`xingmang/offline/claude-components/code/2.1.309/darwin-arm64/${pin.checksum}/claude.app.tar.zst`)
    expect(() => claudeCodeMacObjectKey({ ...pin, version: '../2' })).toThrow()
    expect(claudeCodeMacSeedPaths('/Users/a/Library/Application Support/Claude-3p', pin)).toEqual({
      versionDirectory: '/Users/a/Library/Application Support/Claude-3p/claude-code/2.1.309',
      installDirectory: '/Users/a/Library/Application Support/Claude-3p/claude-code/2.1.309/5af865b9901c',
      binaryPath: '/Users/a/Library/Application Support/Claude-3p/claude-code/2.1.309/5af865b9901c/claude.app/Contents/MacOS/claude',
      verifiedPath: '/Users/a/Library/Application Support/Claude-3p/claude-code/2.1.309/5af865b9901c/.verified',
    })
  })

  it('reads the Mach-O header the way Claude checks it at startup', async () => {
    const directory = temporaryDirectory()
    const write = (name: string, content: Buffer) => { const file = path.join(directory, name); fs.writeFileSync(file, content); return file }
    expect(await inspectMachOHeader(write('arm', machO('arm64', 64)), 'arm64')).toBe('ok')
    expect(await inspectMachOHeader(write('intel', machO('x64', 64)), 'arm64')).toBe('arch-mismatch')
    expect(await inspectMachOHeader(write('intel2', machO('x64', 64)), 'x64')).toBe('ok')
    const fat = Buffer.alloc(64)
    fat.writeUInt32BE(0xcafebabe, 0)
    expect(await inspectMachOHeader(write('fat', fat), 'x64')).toBe('ok')
    expect(await inspectMachOHeader(write('elf', Buffer.from('\x7fELF\x02\x01\x01\x00')), 'arm64')).toBe('not-macho')
    expect(await inspectMachOHeader(write('short', Buffer.from('abc')), 'arm64')).toBe('not-macho')
    expect(await inspectMachOHeader(path.join(directory, 'missing'), 'arm64')).toBe('not-macho')
  })

  it('accepts only plain paths under claude.app', () => {
    expect(parseClaudeAppBundleEntryPath('claude.app/')).toEqual(['claude.app'])
    expect(parseClaudeAppBundleEntryPath('claude.app/Contents/MacOS/claude')).toEqual(['claude.app', 'Contents', 'MacOS', 'claude'])
    for (const bad of ['', '/claude.app/x', 'other.app/x', 'claude.app/../x', 'claude.app/./x', 'claude.app//x', 'claude.app\\x', 'claude.app/a\0b', `claude.app/${'a/'.repeat(12)}x`]) {
      expect(parseClaudeAppBundleEntryPath(bad)).toBeNull()
    }
  })
})

describe('claude desktop mac code seed: unpacking the bundle', () => {
  it('unpacks folders and files with only the executable bit kept', async () => {
    const target = temporaryDirectory()
    const entries = bundleEntries()
    entries[6] = { ...entries[6], mode: 0o4777 }
    const result = await extractClaudeAppBundle(chunks(tarArchive(entries)), target)
    expect(result).toEqual({ files: 4, directories: 4, bytes: expect.any(Number) })
    const binary = path.join(target, 'claude.app', 'Contents', 'MacOS', 'claude')
    expect(fs.statSync(binary).mode & 0o7777).toBe(0o755)
    expect(fs.statSync(path.join(target, 'claude.app', 'Contents', 'Info.plist')).mode & 0o7777).toBe(0o644)
    expect(fs.readFileSync(path.join(target, 'claude.app', 'Contents', '_CodeSignature', 'CodeResources'), 'utf8')).toBe('<plist>signature</plist>')
  })

  it('follows pax headers for long names and ignores the rest of their records', async () => {
    const target = temporaryDirectory()
    const longName = `claude.app/Contents/Resources/${'r'.repeat(110)}.txt`
    const pax = Buffer.from(paxRecord('path', longName) + paxRecord('LIBARCHIVE.xattr.com.apple.provenance', 'AQAA'))
    const result = await extractClaudeAppBundle(chunks(tarArchive([
      { name: 'claude.app/', type: '5', mode: 0o755 },
      { name: 'PaxHeader/x', type: 'x', content: pax },
      { name: 'claude.app/Contents/Resources/short', content: Buffer.from('long') },
    ])), target)
    expect(result.files).toBe(1)
    expect(fs.readFileSync(path.join(target, ...longName.split('/')), 'utf8')).toBe('long')
  })

  it.each([
    ['a symbolic link', [{ name: 'claude.app/Contents/MacOS/claude', type: '2', linkName: '/bin/sh' }]],
    ['a hard link', [{ name: 'claude.app/Contents/MacOS/claude', type: '1', linkName: 'claude.app/Contents/Info.plist' }]],
    ['a path outside claude.app', [{ name: 'evil.txt', content: Buffer.from('x') }]],
    ['a parent-directory hop', [{ name: 'claude.app/../../evil', content: Buffer.from('x') }]],
    ['the same file twice', [{ name: 'claude.app/a', content: Buffer.from('1') }, { name: 'claude.app/a', content: Buffer.from('2') }]],
    ['a device file', [{ name: 'claude.app/dev', type: '3' }]],
  ] as [string, TarEntry[]][])('refuses %s', async (_label, entries) => {
    const target = temporaryDirectory()
    const outside = path.join(path.dirname(target), 'evil')
    await expect(extractClaudeAppBundle(chunks(tarArchive([{ name: 'claude.app/', type: '5' }, ...entries])), target)).rejects.toThrow()
    expect(fs.existsSync(outside)).toBe(false)
  })

  it('refuses a corrupted header, a truncated archive and more than the size limit', async () => {
    const valid = tarArchive(bundleEntries())
    const corrupted = Buffer.from(valid)
    corrupted[0] ^= 0x01
    await expect(extractClaudeAppBundle(chunks(corrupted), temporaryDirectory())).rejects.toThrow('校验不对')
    await expect(extractClaudeAppBundle(chunks(valid.subarray(0, 4096)), temporaryDirectory())).rejects.toThrow()
    await expect(extractClaudeAppBundle(chunks(valid), temporaryDirectory(), 1024)).rejects.toThrow('安全上限')
  })
})

describe('claude desktop mac code seed: putting it in place', () => {
  it('downloads the official bundle from the bucket and installs it exactly where Claude looks', async () => {
    const f = macFixture()
    expect(await f.seeder.prepare(client())).toEqual({ status: 'placed', version: '2.1.309' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
    expect(String(f.fetchMock.mock.calls[0][0])).toBe(f.url)
    expect(f.fetchMock.mock.calls[0][1]?.redirect).toBe('manual')
    expect(fs.readFileSync(f.seedPaths.verifiedPath, 'utf8')).toBe(f.pin.checksum)
    expect(fs.statSync(f.seedPaths.binaryPath).mode & 0o111).not.toBe(0)
    expect(fs.readdirSync(f.seedPaths.installDirectory).sort()).toEqual(['.verified', 'claude.app'])
    expect(fs.readdirSync(f.seedPaths.versionDirectory)).toEqual([f.pin.checksum.slice(0, 12)])
    expect(await inspectClaudeCodeMacSeed(f.seedPaths, f.pin.checksum, 'arm64')).toBe('present')
    expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.mac-code-seed.placed', expect.any(String), expect.objectContaining({ version: '2.1.309', platform: 'darwin-arm64', files: 4 }))

    expect(await f.seeder.prepare(client())).toEqual({ status: 'present', version: '2.1.309' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('replaces an install folder Claude left unfinished', async () => {
    const f = macFixture()
    fs.mkdirSync(path.join(f.seedPaths.installDirectory, 'claude.app', 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(f.seedPaths.installDirectory, 'claude.app', 'Contents', 'stale'), 'half')
    fs.writeFileSync(f.seedPaths.verifiedPath, 'b'.repeat(64))
    expect((await f.seeder.prepare(client())).status).toBe('placed')
    expect(fs.existsSync(path.join(f.seedPaths.installDirectory, 'claude.app', 'Contents', 'stale'))).toBe(false)
    expect(fs.readFileSync(f.seedPaths.verifiedPath, 'utf8')).toBe(f.pin.checksum)
  })

  it('throws away a bucket file that does not match the checksum in Claude itself', async () => {
    const archive = bundleArchive()
    // Same length as the pinned archive, different bytes.
    const served = Buffer.from(archive)
    served[served.length - 1] ^= 0xff
    const g = macFixture({ archive, served })
    expect(await g.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(fs.readdirSync(g.seedPaths.versionDirectory)).toEqual([])
    expect(fs.existsSync(g.seedPaths.installDirectory)).toBe(false)
  })

  it('refuses a bundle whose program is not for this Mac', async () => {
    const f = macFixture({ archive: bundleArchive(bundleEntries(machO('x64'))) })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'extract-failed' })
    expect(fs.readdirSync(f.seedPaths.versionDirectory)).toEqual([])
  })

  it('refuses a bundle that carries a link and leaves nothing behind', async () => {
    const entries = [...bundleEntries(), { name: 'claude.app/Contents/Frameworks', type: '2', linkName: '/Library' }]
    const f = macFixture({ archive: bundleArchive(entries) })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'extract-failed' })
    expect(fs.readdirSync(f.seedPaths.versionDirectory)).toEqual([])
  })

  it('leaves Claude alone while it runs, or when it was opened during the download', async () => {
    const running = macFixture()
    expect(await running.seeder.prepare(client({ running: true }))).toEqual({ status: 'skipped', reason: 'running' })
    expect(running.fetchMock).not.toHaveBeenCalled()
    const meanwhile = macFixture()
    expect(await meanwhile.seeder.prepare(client({ isRunning: async () => true }))).toEqual({ status: 'skipped', reason: 'started-meanwhile' })
    expect(fs.readdirSync(meanwhile.seedPaths.versionDirectory)).toEqual([])
  })

  it('refuses to delete through a link planted as the install folder', async () => {
    const f = macFixture()
    const elsewhere = path.join(f.root, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.writeFileSync(path.join(elsewhere, 'keep'), 'keep')
    fs.mkdirSync(f.seedPaths.versionDirectory, { recursive: true })
    fs.symlinkSync(elsewhere, f.seedPaths.installDirectory)
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'write-failed' })
    expect(fs.readFileSync(path.join(elsewhere, 'keep'), 'utf8')).toBe('keep')
    expect(fs.readdirSync(f.seedPaths.versionDirectory).filter((name) => name.startsWith('xingmang-'))).toEqual([])
  })

  it('cleans up its own leftovers from an interrupted run and nothing else', async () => {
    const f = macFixture()
    fs.mkdirSync(f.seedPaths.versionDirectory, { recursive: true })
    const oldArchive = path.join(f.seedPaths.versionDirectory, 'xingmang-0f8fad5b-d9cb-469f-a165-70867728950e.tar.zst')
    const oldStaging = path.join(f.seedPaths.versionDirectory, 'xingmang-extract-0f8fad5b-d9cb-469f-a165-70867728950e')
    const claudes = path.join(f.seedPaths.versionDirectory, 'download.5af865b9901c.zst.partial')
    fs.writeFileSync(oldArchive, 'half')
    fs.mkdirSync(path.join(oldStaging, 'claude.app'), { recursive: true })
    fs.writeFileSync(claudes, 'claude partial')
    expect((await f.seeder.prepare(client())).status).toBe('placed')
    expect(fs.existsSync(oldArchive)).toBe(false)
    expect(fs.existsSync(oldStaging)).toBe(false)
    expect(fs.readFileSync(claudes, 'utf8')).toBe('claude partial')
  })

  it('stays out when switched off, off the Mac, or when Claude ships no bundle pin', async () => {
    const off = macFixture({ overrides: { isOff: () => true } })
    expect(await off.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'remote-off' })
    const windows = macFixture({ overrides: { platform: 'win32' } })
    expect(await windows.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'unsupported-platform' })
    const intel = macFixture({ architecture: 'x64', overrides: { readManifest: async () => ({ code: null, vm: null }) } })
    expect(await intel.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'pin-not-found' })
    const lost = macFixture({ overrides: { resolveTarget: async () => null } })
    expect(await lost.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'target-unresolved' })
    for (const f of [off, windows, intel, lost]) expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('skips without downloading when the disk is nearly full', async () => {
    const f = macFixture({ overrides: { readDiskSpace: async (target) => ({ availableBytes: 512 * 1024 * 1024, totalBytes: 1e12, measuredPath: target, deviceId: null }) } })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('shares one run between overlapping calls', async () => {
    const f = macFixture()
    const [first, second] = await Promise.all([f.seeder.prepare(client()), f.seeder.prepare(client())])
    expect(first).toBe(second)
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })
})
