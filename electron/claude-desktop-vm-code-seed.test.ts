import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeCodeTarballUrl } from './claude-desktop-code-seed'
import type { ClaudeCodeComponentPins } from './claude-desktop-component-manifest'
import {
  claudeCodeVmNpmPackageName,
  claudeCodeVmSeedPaths,
  createClaudeDesktopVmCodeSeeder,
  isLinuxExecutableHeader,
  resolveClaudeCodeVmPin,
  type ClaudeDesktopVmCodeSeederOptions,
} from './claude-desktop-vm-code-seed'
import { npmPackageVersionUrl } from './npm-registry'

// Real 2.1.309 linux-x64 pin from Claude Desktop 4.4212.0 (probe run 41624912418).
const x64Checksum = 'e52289b95def16148c8d0a48b1ccc0d357429e73473a9a20ac0638fb7460a59b'

const temporaryRoots: string[] = []
function temporaryDirectory(): string {
  // realpath: macOS hands out /var/... which is a link to /private/var, and the safe writers refuse links.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-vm-code-seed-')))
  temporaryRoots.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000755\0', 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1')
  header.write('15000000000\0', 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.write('0', 156, 'latin1')
  header.write('ustar\0', 257, 'latin1')
  header.write('00', 263, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)])
}

function elf(machine: number, bytes = 1536 * 1024): Buffer {
  const binary = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), randomBytes(bytes - 8)])
  binary.writeUInt16LE(machine, 18)
  return binary
}

function npmTarball(executable: Buffer): Buffer {
  return zlib.gzipSync(Buffer.concat([
    tarEntry('package/LICENSE.md', Buffer.from('license')),
    tarEntry('package/package.json', Buffer.from('{"name":"@anthropic-ai/claude-code-linux-x64"}')),
    tarEntry('package/claude', executable),
    Buffer.alloc(1024),
  ]))
}

function integrityOf(buffer: Buffer): string {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}

function pins(overrides: Partial<ClaudeCodeComponentPins['linux']> = {}): ClaudeCodeComponentPins {
  return {
    version: '2.1.309',
    macBundles: {},
    linux: { 'linux-x64': { binary: 'claude.zst', checksum: x64Checksum, size: 103411745 }, 'linux-arm64': { binary: 'claude.zst', checksum: 'b'.repeat(64), size: 99000000 }, ...overrides },
  }
}

interface FixtureOptions {
  executable?: Buffer
  mirrorTarball?: Buffer
  officialIntegrity?: string | null
  overrides?: Partial<ClaudeDesktopVmCodeSeederOptions>
}

function vmFixture(fixtureOptions: FixtureOptions = {}) {
  const root = temporaryDirectory()
  const profile = path.join(root, 'Claude-3p')
  const executable = fixtureOptions.executable ?? elf(62)
  const tarball = npmTarball(executable)
  const name = claudeCodeVmNpmPackageName('linux-x64')
  const metadataUrl = new URL(npmPackageVersionUrl('https://registry.npmjs.org', name, '2.1.309')).href
  const mirrorUrl = claudeCodeTarballUrl('https://registry.npmmirror.com', name, '2.1.309')
  const cdnUrl = `https://cdn.npmmirror.com/packages/${name}/2.1.309/claude-code-linux-x64-2.1.309.tgz`
  const officialUrl = claudeCodeTarballUrl('https://registry.npmjs.org', name, '2.1.309')
  function binary(body: Buffer): Response {
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } })
  }
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === metadataUrl) {
      if (fixtureOptions.officialIntegrity === null) return new Response('down', { status: 503 })
      return new Response(JSON.stringify({ name, version: '2.1.309', dist: { integrity: fixtureOptions.officialIntegrity ?? integrityOf(tarball), unpackedSize: executable.length + 400 } }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === mirrorUrl) return new Response(null, { status: 302, headers: { location: cdnUrl.replace('/@anthropic-ai/', '/%40anthropic-ai/') } })
    if (url === cdnUrl || url === cdnUrl.replace('/@anthropic-ai/', '/%40anthropic-ai/')) return binary(fixtureOptions.mirrorTarball ?? tarball)
    if (url === officialUrl) return binary(tarball)
    return new Response('not found', { status: 404 })
  })
  const log = vi.fn<NonNullable<ClaudeDesktopVmCodeSeederOptions['log']>>()
  const seeder = createClaudeDesktopVmCodeSeeder({
    fetch: fetchMock as unknown as typeof fetch,
    userHome: root,
    platform: 'win32',
    pathModule: path,
    readDiskSpace: async () => null,
    resumeDelaysMs: [0],
    log,
    ...fixtureOptions.overrides,
  })
  const seedPaths = claudeCodeVmSeedPaths(profile, { version: '2.1.309', checksum: x64Checksum })
  return { root, profile, executable, tarball, seeder, fetchMock, log, seedPaths, metadataUrl, mirrorUrl, officialUrl }
}

describe('claude desktop vm code seed: what Cowork wants', () => {
  it('follows the machine architecture into the VM', () => {
    expect(resolveClaudeCodeVmPin(pins(), 'x64')).toEqual({ version: '2.1.309', platform: 'linux-x64', binary: 'claude.zst', checksum: x64Checksum, size: 103411745 })
    expect(resolveClaudeCodeVmPin(pins(), 'arm64')?.platform).toBe('linux-arm64')
    expect(resolveClaudeCodeVmPin(pins({ 'linux-arm64': undefined }), 'arm64')).toBeNull()
    expect(resolveClaudeCodeVmPin(null, 'x64')).toBeNull()
    expect(resolveClaudeCodeVmPin({ ...pins(), version: 'next' }, 'x64')).toBeNull()
  })

  it('uses the folder Claude keeps the VM copy in', () => {
    expect(claudeCodeVmSeedPaths('/p/Claude-3p', { version: '2.1.309', checksum: x64Checksum }, path.posix)).toEqual({
      installDirectory: '/p/Claude-3p/claude-code-vm/2.1.309/e52289b95def',
      binaryPath: '/p/Claude-3p/claude-code-vm/2.1.309/e52289b95def/claude',
      payloadPath: '/p/Claude-3p/claude-code-vm/2.1.309/e52289b95def/.payload',
      verifiedPath: '/p/Claude-3p/claude-code-vm/2.1.309/e52289b95def/.verified',
    })
    expect(() => claudeCodeVmSeedPaths('/p', { version: '../../x', checksum: x64Checksum })).toThrow()
  })

  it('recognises a 64-bit Linux program for the right architecture', () => {
    expect(isLinuxExecutableHeader(elf(62, 64), 'linux-x64')).toBe(true)
    expect(isLinuxExecutableHeader(elf(183, 64), 'linux-arm64')).toBe(true)
    expect(isLinuxExecutableHeader(elf(183, 64), 'linux-x64')).toBe(false)
    expect(isLinuxExecutableHeader(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(30)]), 'linux-x64')).toBe(false)
    expect(isLinuxExecutableHeader(Buffer.from([0x7f, 0x45, 0x4c, 0x46]), 'linux-x64')).toBe(false)
  })
})

describe('claude desktop vm code seed: putting it in place', () => {
  it('downloads the npm package from the mirror, checks it against the official SHA-512 and places it like Claude does', async () => {
    const f = vmFixture()
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: pins() })).toEqual({ status: 'placed', version: '2.1.309' })
    expect(fs.readFileSync(f.seedPaths.binaryPath).equals(f.executable)).toBe(true)
    expect(fs.statSync(f.seedPaths.binaryPath).mode & 0o777).toBe(0o755)
    expect(JSON.parse(fs.readFileSync(f.seedPaths.payloadPath, 'utf8'))).toEqual({ sha256: createHash('sha256').update(f.executable).digest('hex'), size: f.executable.length })
    expect(fs.readFileSync(f.seedPaths.verifiedPath, 'utf8')).toBe(x64Checksum)
    expect(fs.readdirSync(f.seedPaths.installDirectory).sort()).toEqual(['.payload', '.verified', 'claude'])
    const urls = f.fetchMock.mock.calls.map((call) => String(call[0]))
    expect(urls[0]).toBe(f.metadataUrl)
    expect(urls).toContain(f.mirrorUrl)
    expect(urls).not.toContain(f.officialUrl)
    expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.vm-code-seed.placed', expect.any(String), expect.objectContaining({ source: 'npm-mirror', platform: 'linux-x64' }))

    const calls = f.fetchMock.mock.calls.length
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: pins() })).toEqual({ status: 'present', version: '2.1.309' })
    expect(f.fetchMock.mock.calls.length).toBe(calls)
  })

  it('falls back to the official registry when the mirror copy does not match', async () => {
    const f = vmFixture({ mirrorTarball: npmTarball(elf(62)) })
    expect((await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: pins() })).status).toBe('placed')
    expect(f.fetchMock.mock.calls.map((call) => String(call[0]))).toContain(f.officialUrl)
    expect(fs.readFileSync(f.seedPaths.binaryPath).equals(f.executable)).toBe(true)
  })

  it('places nothing when neither source matches the official SHA-512', async () => {
    const f = vmFixture({ officialIntegrity: integrityOf(Buffer.from('something else')) })
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: pins() })).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(fs.readdirSync(f.seedPaths.installDirectory)).toEqual([])
  })

  it('does not download without the official checksum', async () => {
    const f = vmFixture({ officialIntegrity: null })
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: pins() })).toEqual({ status: 'skipped', reason: 'metadata-failed' })
    expect(f.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a program built for the other architecture', async () => {
    const f = vmFixture({ executable: elf(183) })
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: pins() })).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(fs.existsSync(f.seedPaths.binaryPath)).toBe(false)
  })

  it('checks the program itself when Claude pins the raw binary', async () => {
    const f = vmFixture()
    const raw = pins({ 'linux-x64': { binary: 'claude', checksum: 'd'.repeat(64), size: 1 } })
    const seedPaths = claudeCodeVmSeedPaths(f.profile, { version: '2.1.309', checksum: 'd'.repeat(64) })
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: raw })).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(fs.existsSync(seedPaths.binaryPath)).toBe(false)
  })

  it('skips when Claude has no pin for the VM or the disk is nearly full', async () => {
    const f = vmFixture()
    expect(await f.seeder.seed({ profileDirectory: f.profile, architecture: 'x64', pins: null })).toEqual({ status: 'skipped', reason: 'pin-not-found' })
    const full = vmFixture({ overrides: { readDiskSpace: async (target) => ({ availableBytes: 1024, totalBytes: 1e12, measuredPath: target, deviceId: null }) } })
    expect(await full.seeder.seed({ profileDirectory: full.profile, architecture: 'x64', pins: pins() })).toEqual({ status: 'skipped', reason: 'disk-space' })
    expect(f.fetchMock).not.toHaveBeenCalled()
    expect(full.fetchMock).not.toHaveBeenCalled()
  })
})
