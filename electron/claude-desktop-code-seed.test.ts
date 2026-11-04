import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeCodeNpmPackageName,
  claudeCodeSeedPaths,
  claudeCodeSeedPercent,
  claudeCodeSeedPlatform,
  claudeCodeTarballUrl,
  claudeDesktopAsarPath,
  createClaudeCodeSeedProgressRelay,
  createClaudeDesktopCodeSeeder,
  decodeSingleQuotedLiteral,
  extractTarEntry,
  findClaudeCodeBuildPin,
  inspectClaudeCodeSeed,
  listAsarBuildScripts,
  parseAsarHeaderJson,
  parseAsarSizePrefix,
  parseClaudeCodeNpmRelease,
  parsePaxRecords,
  readClaudeCodeBuildPin,
  validateClaudeCodeTarballUrl,
  verifyAndExtractClaudeCodeTarball,
  type ClaudeCodeSeedProgressTarget,
  type ClaudeDesktopCodeSeederOptions,
} from './claude-desktop-code-seed'
import type { ExternalClientLaunchProgress } from './external-client-contract'
import { npmPackageVersionUrl } from './npm-registry'

// Real values from Claude Desktop 4.4212.0 (probe run 41623510171, 2026-11-03).
const x64Checksum = '9078b9c1d466965d3faee8d13128f03d79b61794fb2130255ca1f5eab84e602c'
const arm64Checksum = '1bfeb992f9659ef84307012c5da5735cdf05da6a81ced1bea60dbddae67ecdad'
const storeClaude = 'C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe'

function buildPinJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: '2.1.309',
    manifest: {
      version: '2.1.309',
      manifestSignatureEnforcement: 'flag',
      commit: '1ce7e4ff2da8d4b0f5c15b291e4a9b54716970c2',
      platforms: {
        'darwin-arm64': { binary: 'claude.zst', checksum: '6'.repeat(64), size: 93159896, bundle: { checksum: '5'.repeat(64), size: 93151388 } },
        'linux-x64': { binary: 'claude.zst', checksum: 'e52289b95def16148c8d0a48b1ccc0d357429e73473a9a20ac0638fb7460a59b', size: 103411745 },
        'win32-x64': { binary: 'claude.exe.zst', checksum: x64Checksum, size: 106715810 },
        'win32-arm64': { binary: 'claude.exe.zst', checksum: arm64Checksum, size: 101912543 },
      },
      sdkCompat: { testedWrapperVersions: ['0.3.276', '0.3.306'], harnessSchema: 1 },
    },
    baseUrl: 'https://downloads.claude.ai/claude-code-releases',
    sdkWrapperVersion: '0.3.309',
    ...overrides,
  })
}

// The shape of the minified chunk around the pin: a decoy JSON.parse (the VM helper's manifest) right after it.
function chunkText(pinJson = buildPinJson()): string {
  return 'Type:"prod",commitHash:"UNKNOWN",appVersion:"0.0.0"}}'
    + `function M_(){return JSON.parse('${pinJson}')}`
    + 'function HSt(){return JSON.parse(\'{"version":"be1c1ca50b7b27c5f9341e4cbabc2039588fe597","manifest":{"version":"be1c1ca50b7b27c5f9341e4cbabc2039588fe597","platforms":{"linux-amd64":{"checksum":"de868c3e08217de7edc4e0785f22a99e68e20d870ab56493cc0169493f9a2c25","size":2929890}}}}\')}'
}

function asarArchive(scripts: Record<string, Buffer>, extra: Record<string, unknown> = {}): Buffer {
  const files: Record<string, unknown> = {}
  const contents: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(scripts)) {
    files[name] = { size: content.length, offset: String(offset) }
    contents.push(content)
    offset += content.length
  }
  const json = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files: { ...files, ...extra } } } }, 'package.json': { size: 2, offset: String(offset) } } }))
  contents.push(Buffer.from('{}'))
  const padded = Math.ceil(json.length / 4) * 4
  const header = Buffer.alloc(8 + padded)
  header.writeUInt32LE(4 + padded, 0)
  header.writeUInt32LE(json.length, 4)
  json.copy(header, 8)
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(header.length, 4)
  return Buffer.concat([prefix, header, ...contents])
}

function tarHeader(name: string, size: number, type = '0', prefix = ''): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write('00000000000\0', 136)
  block.fill(0x20, 148, 156)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  if (prefix) block.write(prefix, 345, 155)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

function tarEntry(name: string, content: Buffer, type = '0', prefix = ''): Buffer {
  const padding = (512 - (content.length % 512)) % 512
  return Buffer.concat([tarHeader(name, content.length, type, prefix), content, Buffer.alloc(padding)])
}

function paxEntry(records: Record<string, string>): Buffer {
  const body = Object.entries(records).map(([key, value]) => {
    const tail = ` ${key}=${value}\n`
    let length = tail.length + 1
    while (String(length).length + tail.length !== length) length += 1
    return `${length}${tail}`
  }).join('')
  return tarEntry('PaxHeader/x', Buffer.from(body), 'x')
}

function tarArchive(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)])
}

async function* chunked(buffer: Buffer, size = 700): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size)
}

async function extract(buffer: Buffer, name = 'package/claude.exe', maximum = 10 * 1024 * 1024) {
  const parts: Buffer[] = []
  const result = await extractTarEntry(chunked(buffer), name, async (chunk) => { parts.push(chunk) }, maximum)
  return { ...result, content: Buffer.concat(parts) }
}

function fakeExecutable(bytes = 1536 * 1024): Buffer {
  return Buffer.concat([Buffer.from('MZ'), randomBytes(bytes - 2)])
}

function npmTarball(executable: Buffer): Buffer {
  return zlib.gzipSync(tarArchive([
    tarEntry('package/LICENSE.md', Buffer.from('license')),
    tarEntry('package/package.json', Buffer.from('{"name":"@anthropic-ai/claude-code-win32-x64"}')),
    tarEntry('package/claude.exe', executable),
  ]))
}

function integrityOf(buffer: Buffer): string {
  return `sha512-${createHash('sha512').update(buffer).digest('base64')}`
}

const temporaryRoots: string[] = []
function temporaryDirectory(): string {
  // realpath: macOS hands out /var/... which is a link to /private/var, and the safe writers refuse links.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-code-seed-')))
  temporaryRoots.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('claude desktop code seed: reading what Claude wants', () => {
  it('takes the architecture from the store package and falls back to the host', () => {
    expect(claudeCodeSeedPlatform(storeClaude, 'arm64')).toBe('win32-x64')
    expect(claudeCodeSeedPlatform(storeClaude.replace('_x64__', '_arm64__'), 'x64')).toBe('win32-arm64')
    expect(claudeCodeSeedPlatform(storeClaude.replace('_x64__', '_neutral__'), 'arm64')).toBe('win32-arm64')
    expect(claudeCodeSeedPlatform('C:\\Users\\Tester\\AppData\\Local\\AnthropicClaude\\app-1.0.0\\Claude.exe', 'x64')).toBe('win32-x64')
    expect(claudeCodeSeedPlatform('C:\\Users\\Tester\\AppData\\Local\\AnthropicClaude\\Claude.exe', 'ia32')).toBeNull()
    expect(claudeDesktopAsarPath(storeClaude)).toBe('C:\\Program Files\\WindowsApps\\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\\app\\resources\\app.asar')
  })

  it('decodes JavaScript single-quoted literals and refuses what it cannot read exactly', () => {
    const text = 'x(\'a\\\'b\\\\c\\x41\\u0042\\u{1F600}\\n\\\r\nd\')'
    expect(decodeSingleQuotedLiteral(text, 3)).toBe('a\'b\\cAB\u{1F600}\nd')
    expect(decodeSingleQuotedLiteral('\'abc', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'a\nb\'', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'\\012\'', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'\\xZ1\'', 1)).toBeNull()
    expect(decodeSingleQuotedLiteral('\'abcdef\'', 1, 3)).toBeNull()
  })

  it('finds the pinned Claude Code build for the right platform past a decoy JSON.parse', () => {
    const pin = { version: '2.1.309', checksum: x64Checksum, binary: 'claude.exe.zst', size: 106715810 }
    expect(findClaudeCodeBuildPin(chunkText(), 'win32-x64')).toEqual({ ...pin, platform: 'win32-x64' })
    expect(findClaudeCodeBuildPin(chunkText(), 'win32-arm64')).toMatchObject({ checksum: arm64Checksum, platform: 'win32-arm64' })
    // Only the VM manifest left: its version is a commit, not a release.
    expect(findClaudeCodeBuildPin(chunkText().replace(/function M_\(\)[^}]*\}/, ''), 'win32-x64')).toBeNull()
    // A quote escaped inside the literal does not end it early.
    const quoted = buildPinJson({ note: 'it\'s' }).replace('it\'s', 'it\\\'s')
    expect(findClaudeCodeBuildPin(chunkText(quoted), 'win32-x64')).toMatchObject({ checksum: x64Checksum })
  })

  it('refuses a pin whose shape changed instead of guessing', () => {
    function withWindows(entry: Record<string, unknown>): string {
      const parsed = JSON.parse(buildPinJson()) as { manifest: { platforms: Record<string, unknown> } }
      parsed.manifest.platforms['win32-x64'] = entry
      return JSON.stringify(parsed)
    }
    const base = { binary: 'claude.exe.zst', checksum: x64Checksum, size: 106715810 }
    expect(findClaudeCodeBuildPin(chunkText(withWindows({ ...base, bundle: { checksum: x64Checksum, size: 1 } })), 'win32-x64')).toBeNull()
    expect(findClaudeCodeBuildPin(chunkText(withWindows({ ...base, checksum: x64Checksum.toUpperCase() })), 'win32-x64')).toBeNull()
    expect(findClaudeCodeBuildPin(chunkText(withWindows({ ...base, binary: 'claude.tar.zst' })), 'win32-x64')).toBeNull()
    expect(findClaudeCodeBuildPin(chunkText(withWindows({ ...base, size: -1 })), 'win32-x64')).toBeNull()
    expect(findClaudeCodeBuildPin(chunkText(buildPinJson({ version: '../2.1.309' })), 'win32-x64')).toBeNull()
    expect(findClaudeCodeBuildPin(chunkText(withWindows({ ...base, binary: 'claude.exe' })), 'win32-x64')).toMatchObject({ binary: 'claude.exe' })
  })

  it('reads the pin out of app.asar, largest build script first, skipping unpacked and nested entries', async () => {
    const directory = temporaryDirectory()
    const asar = path.join(directory, 'app.asar')
    fs.writeFileSync(asar, asarArchive({
      'index.pre.js': Buffer.from('console.log(1)'),
      'index.chunk-2SHPxESV.js': Buffer.from(`${'/*pad*/'.repeat(200)}${chunkText()}`),
    }, { 'mainView.js': { size: 10, offset: '0', unpacked: true }, nested: { files: {} } }))
    expect(await readClaudeCodeBuildPin(asar, 'win32-x64')).toMatchObject({ version: '2.1.309', checksum: x64Checksum })
    fs.writeFileSync(asar, asarArchive({ 'index.pre.js': Buffer.from('console.log(1)') }))
    expect(await readClaudeCodeBuildPin(asar, 'win32-x64')).toBeNull()
    fs.writeFileSync(asar, Buffer.from('not an asar at all'))
    await expect(readClaudeCodeBuildPin(asar, 'win32-x64')).rejects.toThrow()
  })

  it('bounds the asar header and the script table', () => {
    const prefix = Buffer.alloc(8)
    prefix.writeUInt32LE(4, 0)
    prefix.writeUInt32LE(64 * 1024 * 1024, 4)
    expect(() => parseAsarSizePrefix(prefix, 1024 * 1024 * 1024)).toThrow()
    prefix.writeUInt32LE(100, 4)
    expect(() => parseAsarSizePrefix(prefix, 50)).toThrow()
    expect(parseAsarSizePrefix(prefix, 1000)).toBe(100)
    const header = Buffer.alloc(16)
    header.writeUInt32LE(100, 0)
    expect(() => parseAsarHeaderJson(header)).toThrow()
    const index = { files: { '.vite': { files: { build: { files: {
      'big.js': { size: 64 * 1024 * 1024, offset: '0' },
      'past-end.js': { size: 10, offset: '995' },
      'odd-offset.js': { size: 10, offset: '-1' },
      '../escape.js': { size: 10, offset: '0' },
      'ok.js': { size: 10, offset: '0' },
      'style.css': { size: 10, offset: '0' },
    } } } } } }
    expect(listAsarBuildScripts(index, 1000)).toEqual([{ name: 'ok.js', offset: 0, size: 10 }])
    expect(listAsarBuildScripts(null, 1000)).toEqual([])
  })
})

describe('claude desktop code seed: where it goes and where it comes from', () => {
  it('builds the folder Claude looks in and refuses anything that could walk out of it', () => {
    const paths = claudeCodeSeedPaths('C:\\Users\\Tester\\AppData\\Local\\Claude-3p', { version: '2.1.309', checksum: x64Checksum })
    expect(paths).toEqual({
      storageDirectory: 'C:\\Users\\Tester\\AppData\\Local\\Claude-3p\\claude-code',
      versionDirectory: 'C:\\Users\\Tester\\AppData\\Local\\Claude-3p\\claude-code\\2.1.309',
      installDirectory: 'C:\\Users\\Tester\\AppData\\Local\\Claude-3p\\claude-code\\2.1.309\\9078b9c1d466',
      binaryPath: 'C:\\Users\\Tester\\AppData\\Local\\Claude-3p\\claude-code\\2.1.309\\9078b9c1d466\\claude.exe',
      payloadPath: 'C:\\Users\\Tester\\AppData\\Local\\Claude-3p\\claude-code\\2.1.309\\9078b9c1d466\\.payload',
      verifiedPath: 'C:\\Users\\Tester\\AppData\\Local\\Claude-3p\\claude-code\\2.1.309\\9078b9c1d466\\.verified',
    })
    expect(() => claudeCodeSeedPaths('C:\\Claude-3p', { version: '..\\..', checksum: x64Checksum })).toThrow()
    expect(() => claudeCodeSeedPaths('C:\\Claude-3p', { version: '2.1.309', checksum: `..\\${'a'.repeat(61)}` })).toThrow()
  })

  it('downloads only that package and version from the two npm registries and the mirror CDN', () => {
    const name = claudeCodeNpmPackageName('win32-x64')
    expect(name).toBe('@anthropic-ai/claude-code-win32-x64')
    const mirror = claudeCodeTarballUrl('https://registry.npmmirror.com', name, '2.1.309')
    expect(mirror).toBe('https://registry.npmmirror.com/@anthropic-ai/claude-code-win32-x64/-/claude-code-win32-x64-2.1.309.tgz')
    expect(() => validateClaudeCodeTarballUrl(mirror, name, '2.1.309')).not.toThrow()
    expect(() => validateClaudeCodeTarballUrl(claudeCodeTarballUrl('https://registry.npmjs.org/', name, '2.1.309'), name, '2.1.309')).not.toThrow()
    expect(() => validateClaudeCodeTarballUrl('https://cdn.npmmirror.com/packages/@anthropic-ai/claude-code-win32-x64/2.1.309/claude-code-win32-x64-2.1.309.tgz', name, '2.1.309')).not.toThrow()
    expect(() => validateClaudeCodeTarballUrl('https://cdn.npmmirror.com/packages/%40anthropic-ai/claude-code-win32-x64/2.1.309/claude-code-win32-x64-2.1.309.tgz', name, '2.1.309')).not.toThrow()
    for (const refused of [
      mirror.replace('2.1.309.tgz', '2.1.310.tgz'),
      mirror.replace('https:', 'http:'),
      `${mirror}?x=1`,
      mirror.replace('registry.npmmirror.com', 'registry.npmmirror.com.evil.example'),
      mirror.replace('registry.npmmirror.com', 'registry.npmmirror.com:8443'),
      mirror.replace('claude-code-win32-x64/-', 'claude-code-win32-arm64/-'),
      'https://cdn.npmmirror.com/binaries/claude-code-win32-x64-2.1.309.tgz',
      'https://cdn.npmmirror.com/packages/%40anthropic-ai/claude-code-win32-x64/2.1.309/%2e%2e/claude-code-win32-x64-2.1.309.tgz',
      'https://cdn.npmmirror.com/packages/%E0%A4%A/claude-code-win32-x64-2.1.309.tgz',
      'not a url',
    ]) expect(() => validateClaudeCodeTarballUrl(refused, name, '2.1.309'), refused).toThrow()
  })

  it('reads the official SHA-512 and unpacked size from npm metadata', () => {
    const name = '@anthropic-ai/claude-code-win32-x64'
    const integrity = integrityOf(Buffer.from('package'))
    expect(parseClaudeCodeNpmRelease(JSON.stringify({ name, version: '2.1.309', dist: { integrity, unpackedSize: 298624578 } }), name, '2.1.309'))
      .toEqual({ sha512: createHash('sha512').update('package').digest(), unpackedSize: 298624578 })
    expect(parseClaudeCodeNpmRelease(JSON.stringify({ name, version: '2.1.309', dist: { integrity } }), name, '2.1.309')).toMatchObject({ unpackedSize: null })
    expect(parseClaudeCodeNpmRelease(JSON.stringify({ name, version: '2.1.310', dist: { integrity } }), name, '2.1.309')).toBeNull()
    expect(parseClaudeCodeNpmRelease(JSON.stringify({ name: 'other', version: '2.1.309', dist: { integrity } }), name, '2.1.309')).toBeNull()
    expect(parseClaudeCodeNpmRelease(JSON.stringify({ name, version: '2.1.309', dist: { integrity: 'sha1-abc' } }), name, '2.1.309')).toBeNull()
    expect(parseClaudeCodeNpmRelease('{', name, '2.1.309')).toBeNull()
  })
})

describe('claude desktop code seed: unpacking the npm package', () => {
  it('streams out the one file it wants and skips the rest', async () => {
    const content = Buffer.from('MZ'.padEnd(2000, 'x'))
    const archive = tarArchive([tarEntry('package/README.md', Buffer.from('readme')), tarEntry('package/claude.exe', content), tarEntry('package/package.json', Buffer.from('{}'))])
    const result = await extract(archive)
    expect(result).toMatchObject({ found: true, size: 2000 })
    expect(result.content.equals(content)).toBe(true)
    expect(await extract(tarArchive([tarEntry('package/README.md', Buffer.from('readme'))]))).toMatchObject({ found: false })
  })

  it('follows ustar prefixes, pax paths and GNU long names to the real entry name', async () => {
    const content = Buffer.from('MZ-content')
    expect(await extract(tarArchive([tarEntry('claude.exe', content, '0', 'package')]))).toMatchObject({ found: true, size: content.length })
    expect(await extract(tarArchive([paxEntry({ path: 'package/claude.exe' }), tarEntry('PaxHeader-placeholder', content)]))).toMatchObject({ found: true })
    expect(await extract(tarArchive([tarEntry('././@LongLink', Buffer.from('package/claude.exe\0'), 'L'), tarEntry('truncated-name', content)]))).toMatchObject({ found: true })
    expect(parsePaxRecords(Buffer.from('30 path=package/claude.exe\n'))).toBeNull()
    expect(parsePaxRecords(Buffer.from('27 path=package/claude.exe\n'))).toEqual({ path: 'package/claude.exe' })
  })

  it('refuses duplicates, links, bad checksums, oversize and truncated archives', async () => {
    const content = Buffer.from('MZ-content')
    await expect(extract(tarArchive([tarEntry('package/claude.exe', content), tarEntry('package/claude.exe', content)]))).rejects.toThrow('两个同名')
    await expect(extract(tarArchive([tarEntry('package/claude.exe', Buffer.alloc(0), '2')]))).rejects.toThrow('不是普通文件')
    const corrupt = tarArchive([tarEntry('package/claude.exe', content)])
    corrupt[0] = 0x51
    await expect(extract(corrupt)).rejects.toThrow('校验不对')
    await expect(extract(tarArchive([tarEntry('package/claude.exe', Buffer.alloc(4096))]), 'package/claude.exe', 1024)).rejects.toThrow('安全上限')
    await expect(extract(tarArchive([tarEntry('package/claude.exe', Buffer.alloc(4096))]).subarray(0, 1500))).rejects.toThrow('不完整')
    const many = Array.from({ length: 70 }, (_, index) => tarEntry(`package/f${index}`, Buffer.from('x')))
    await expect(extract(tarArchive(many))).rejects.toThrow('太多')
  })

  it('checks the whole package against the official SHA-512 before handing the program over', async () => {
    const directory = temporaryDirectory()
    const executable = fakeExecutable()
    const tarball = npmTarball(executable)
    const tarballPath = path.join(directory, 'package.tgz')
    fs.writeFileSync(tarballPath, tarball)
    const release = { sha512: createHash('sha512').update(tarball).digest(), unpackedSize: null }
    const extracted = await verifyAndExtractClaudeCodeTarball(tarballPath, path.join(directory, 'claude.exe.tmp'), release)
    expect(extracted).toEqual({ sha256: createHash('sha256').update(executable).digest('hex'), size: executable.length })
    expect(fs.readFileSync(path.join(directory, 'claude.exe.tmp')).equals(executable)).toBe(true)
    await expect(verifyAndExtractClaudeCodeTarball(tarballPath, path.join(directory, 'other.tmp'), { sha512: Buffer.alloc(64), unpackedSize: null }))
      .rejects.toThrow('SHA-512')
    const notWindows = npmTarball(Buffer.concat([Buffer.from('\x7fELF'), randomBytes(1024 * 1024)]))
    fs.writeFileSync(tarballPath, notWindows)
    await expect(verifyAndExtractClaudeCodeTarball(tarballPath, path.join(directory, 'third.tmp'), { sha512: createHash('sha512').update(notWindows).digest(), unpackedSize: null }))
      .rejects.toThrow('不是 Windows 程序')
  })
})

interface SeedFixtureOptions {
  executable?: Buffer
  mirrorTarball?: Buffer
  officialTarball?: Buffer
  metadataStatus?: number
  overrides?: Partial<ClaudeDesktopCodeSeederOptions>
}

function seedFixture(fixtureOptions: SeedFixtureOptions = {}) {
  const root = temporaryDirectory()
  const profile = path.join(root, 'Claude-3p')
  const asar = path.join(root, 'app.asar')
  fs.writeFileSync(asar, asarArchive({ 'index.chunk-2SHPxESV.js': Buffer.from(chunkText()) }))
  const executable = fixtureOptions.executable ?? fakeExecutable()
  const tarball = npmTarball(executable)
  const name = '@anthropic-ai/claude-code-win32-x64'
  const metadataUrl = new URL(npmPackageVersionUrl('https://registry.npmjs.org', name, '2.1.309')).href
  const mirrorUrl = claudeCodeTarballUrl('https://registry.npmmirror.com', name, '2.1.309')
  const cdnUrl = `https://cdn.npmmirror.com/packages/${name}/2.1.309/claude-code-win32-x64-2.1.309.tgz`
  const officialUrl = claudeCodeTarballUrl('https://registry.npmjs.org', name, '2.1.309')
  function binary(body: Buffer): Response {
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length) } })
  }
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === metadataUrl) {
      return new Response(JSON.stringify({ name, version: '2.1.309', dist: { integrity: integrityOf(tarball), unpackedSize: executable.length + 400 } }),
        { status: fixtureOptions.metadataStatus ?? 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === mirrorUrl) return new Response(null, { status: 302, headers: { location: cdnUrl } })
    if (url === cdnUrl) return binary(fixtureOptions.mirrorTarball ?? tarball)
    if (url === officialUrl) return binary(fixtureOptions.officialTarball ?? tarball)
    return new Response('not found', { status: 404 })
  })
  const log = vi.fn<NonNullable<ClaudeDesktopCodeSeederOptions['log']>>()
  const seeder = createClaudeDesktopCodeSeeder({
    platform: 'win32',
    architecture: 'x64',
    executionMode: 'same-user',
    fetch: fetchMock as unknown as typeof fetch,
    userHome: root,
    pathModule: path,
    resolveAsarPath: () => asar,
    resolveProfileDirectory: async () => profile,
    readDiskSpace: async () => null,
    resumeDelaysMs: [0],
    log,
    ...fixtureOptions.overrides,
  })
  const installDirectory = path.join(profile, 'claude-code', '2.1.309', x64Checksum.slice(0, 12))
  return { root, profile, asar, executable, tarball, seeder, fetchMock, log, installDirectory, metadataUrl, mirrorUrl, cdnUrl, officialUrl }
}

function client(extra: Partial<{ running: boolean; isRunning: () => Promise<boolean | null> }> = {}) {
  return { path: storeClaude, running: false, ...extra }
}

describe('claude desktop code seed: putting it in place', () => {
  it('places the program, .payload and .verified exactly the way Claude installs it, then leaves it alone', async () => {
    const f = seedFixture()
    expect(await f.seeder.prepare(client())).toEqual({ status: 'placed', version: '2.1.309' })
    expect(fs.readFileSync(path.join(f.installDirectory, 'claude.exe')).equals(f.executable)).toBe(true)
    expect(fs.readFileSync(path.join(f.installDirectory, '.verified'), 'utf8')).toBe(x64Checksum)
    expect(JSON.parse(fs.readFileSync(path.join(f.installDirectory, '.payload'), 'utf8'))).toEqual({
      sha256: createHash('sha256').update(f.executable).digest('hex'), size: f.executable.length,
    })
    // Nothing of ours is left beside it.
    expect(fs.readdirSync(f.installDirectory).sort()).toEqual(['.payload', '.verified', 'claude.exe'])
    expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toEqual([f.metadataUrl, f.mirrorUrl, f.cdnUrl])
    expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.code-seed.placed', expect.any(String), expect.objectContaining({ version: '2.1.309', build: '9078b9c1d466', source: 'npm-mirror' }))
    f.fetchMock.mockClear()
    expect(await f.seeder.prepare(client())).toEqual({ status: 'present', version: '2.1.309' })
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('treats a matching install Claude left at the version level as present', async () => {
    const f = seedFixture()
    const versionDirectory = path.dirname(f.installDirectory)
    fs.mkdirSync(versionDirectory, { recursive: true })
    fs.writeFileSync(path.join(versionDirectory, 'claude.exe'), 'MZ')
    fs.writeFileSync(path.join(versionDirectory, '.verified'), `${x64Checksum}\n`)
    expect(await f.seeder.prepare(client())).toEqual({ status: 'present', version: '2.1.309' })
    expect(f.fetchMock).not.toHaveBeenCalled()
  })

  it('replaces a half-finished download whose marker does not match', async () => {
    const f = seedFixture()
    fs.mkdirSync(f.installDirectory, { recursive: true })
    fs.writeFileSync(path.join(f.installDirectory, 'claude.exe'), 'partial')
    fs.writeFileSync(path.join(f.installDirectory, '.verified'), 'f'.repeat(64))
    fs.writeFileSync(path.join(f.installDirectory, `claude.exe.xingmang-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}.tgz`), 'stale')
    expect(await f.seeder.prepare(client())).toMatchObject({ status: 'placed' })
    expect(fs.readFileSync(path.join(f.installDirectory, 'claude.exe')).equals(f.executable)).toBe(true)
    expect(fs.readdirSync(f.installDirectory).sort()).toEqual(['.payload', '.verified', 'claude.exe'])
  })

  it('falls back to the official registry when the mirror hands over bytes that fail the official SHA-512', async () => {
    const f = seedFixture({ mirrorTarball: npmTarball(fakeExecutable()) })
    expect(await f.seeder.prepare(client())).toMatchObject({ status: 'placed' })
    expect(fs.readFileSync(path.join(f.installDirectory, 'claude.exe')).equals(f.executable)).toBe(true)
    expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toContain(f.officialUrl)
    expect(f.log).toHaveBeenCalledWith('info', 'claude-desktop.code-seed.placed', expect.any(String), expect.objectContaining({ source: 'npm-official' }))
  })

  it('writes nothing when no source passes the check, and says why in the log', async () => {
    const wrong = npmTarball(fakeExecutable())
    const f = seedFixture({ mirrorTarball: wrong, officialTarball: wrong })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'download-failed' })
    expect(fs.readdirSync(f.installDirectory)).toEqual([])
    const [, , , detail] = f.log.mock.calls.find(([, event]) => event === 'claude-desktop.code-seed.skipped') ?? []
    expect(JSON.stringify(detail)).toContain('SHA-512')
  })

  it('does not download at all without the official registry\'s SHA-512', async () => {
    const f = seedFixture({ metadataStatus: 503 })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'metadata-failed' })
    expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toEqual([f.metadataUrl])
    expect(fs.existsSync(f.profile)).toBe(false)
  })

  it('leaves Claude\'s folder alone when Claude is open, started meanwhile, switched off, or run elevated', async () => {
    const open = seedFixture()
    expect(await open.seeder.prepare(client({ running: true }))).toEqual({ status: 'skipped', reason: 'running' })
    expect(open.fetchMock).not.toHaveBeenCalled()

    const meanwhile = seedFixture()
    expect(await meanwhile.seeder.prepare(client({ isRunning: async () => true }))).toEqual({ status: 'skipped', reason: 'started-meanwhile' })
    expect(fs.readdirSync(meanwhile.installDirectory)).toEqual([])

    const off = seedFixture({ overrides: { isOff: () => true } })
    expect(await off.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'remote-off' })
    const elevated = seedFixture({ overrides: { executionMode: 'trusted-only' } })
    expect(await elevated.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'not-same-user' })
    const mac = seedFixture({ overrides: { platform: 'darwin' } })
    expect(await mac.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'unsupported-platform' })
    for (const fixture of [off, elevated, mac]) expect(fixture.fetchMock).not.toHaveBeenCalled()
  })

  it('skips when the pin cannot be read, the profile cannot be found, or the disk is nearly full', async () => {
    const missing = seedFixture({ overrides: { resolveAsarPath: () => path.join(os.tmpdir(), 'no-such-dir', 'app.asar') } })
    expect(await missing.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'asar-missing' })
    const changed = seedFixture()
    fs.writeFileSync(changed.asar, asarArchive({ 'index.pre.js': Buffer.from('nothing here') }))
    expect(await changed.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'pin-not-found' })
    const noProfile = seedFixture({ overrides: { resolveProfileDirectory: async () => { throw new Error('请先打开一次 Claude Desktop 完成配置迁移') } } })
    expect(await noProfile.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'profile-unresolved' })
    const full = seedFixture({ overrides: { readDiskSpace: async () => ({ availableBytes: 100 * 1024 * 1024, totalBytes: 1, measuredPath: '/', deviceId: null }) } })
    expect(await full.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'disk-space' })
    for (const fixture of [missing, changed, noProfile, full]) expect(fixture.fetchMock).not.toHaveBeenCalled()
  })

  it('gives up after its time budget and cleans up what it started', async () => {
    const f = seedFixture({ overrides: { timeoutMs: 50 } })
    f.fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === f.metadataUrl) return new Response(JSON.stringify({ name: '@anthropic-ai/claude-code-win32-x64', version: '2.1.309', dist: { integrity: integrityOf(f.tarball) } }), { status: 200 })
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'skipped', reason: 'timeout' })
    expect(fs.readdirSync(f.installDirectory)).toEqual([])
  })

  it('reads app.asar once per file stamp and shares one run between overlapping calls', async () => {
    const readBuildPin = vi.fn(async () => null)
    const f = seedFixture({ overrides: { readBuildPin } })
    const [first, second] = await Promise.all([f.seeder.prepare(client()), f.seeder.prepare(client())])
    expect(first).toBe(second)
    await f.seeder.prepare(client())
    expect(readBuildPin).toHaveBeenCalledTimes(1)
    fs.appendFileSync(f.asar, 'x')
    await f.seeder.prepare(client())
    expect(readBuildPin).toHaveBeenCalledTimes(2)
  })

  it('reports present only once per build in the log', async () => {
    const f = seedFixture()
    fs.mkdirSync(f.installDirectory, { recursive: true })
    fs.writeFileSync(path.join(f.installDirectory, 'claude.exe'), 'MZ')
    fs.writeFileSync(path.join(f.installDirectory, '.verified'), x64Checksum)
    await f.seeder.prepare(client())
    await f.seeder.prepare(client())
    expect(f.log.mock.calls.filter(([, event]) => event === 'claude-desktop.code-seed.present')).toHaveLength(1)
    expect(await inspectClaudeCodeSeed(claudeCodeSeedPaths(f.profile, { version: '2.1.309', checksum: x64Checksum }, path), x64Checksum, path)).toBe('present')
    expect(await inspectClaudeCodeSeed(claudeCodeSeedPaths(f.profile, { version: '2.1.309', checksum: arm64Checksum }, path), arm64Checksum, path)).toBe('missing')
  })
})

function progressTarget(sent: ExternalClientLaunchProgress[], state: { destroyed?: boolean; throws?: boolean } = {}): ClaudeCodeSeedProgressTarget {
  return {
    isDestroyed: () => state.destroyed === true,
    send: (channel, payload) => {
      if (state.throws) throw new Error('render frame disposed')
      expect(channel).toBe('external-clients:launch-progress')
      sent.push(payload)
    },
  }
}

describe('claude desktop code seed: telling the tool row how far it got', () => {
  it('turns bytes into a whole percent only while downloading a package of known size', () => {
    expect(claudeCodeSeedPercent({ phase: 'downloading', version: '2.1.309', transferred: 47_000_000, total: 136_346_595 })).toBe(34)
    expect(claudeCodeSeedPercent({ phase: 'downloading', version: '2.1.309', transferred: 136_346_595, total: 136_346_595 })).toBe(100)
    // A resumed download can briefly report more than the declared size; the row never shows past 100.
    expect(claudeCodeSeedPercent({ phase: 'downloading', version: '2.1.309', transferred: 2, total: 1 })).toBe(100)
    expect(claudeCodeSeedPercent({ phase: 'downloading', version: '2.1.309', transferred: 5, total: null })).toBeNull()
    expect(claudeCodeSeedPercent({ phase: 'downloading', version: '2.1.309', transferred: 5, total: 0 })).toBeNull()
    expect(claudeCodeSeedPercent({ phase: 'placing', version: '2.1.309', transferred: 0, total: null })).toBeNull()
  })

  it('sends a change only to the windows still waiting, and survives one that went away', () => {
    const relay = createClaudeCodeSeedProgressRelay()
    const first: ExternalClientLaunchProgress[] = []
    const second: ExternalClientLaunchProgress[] = []
    const gone = { destroyed: false }
    const unwatchFirst = relay.watch(progressTarget(first))
    relay.watch(progressTarget([], { throws: true }))
    relay.watch(progressTarget([], gone))
    const download = (transferred: number) => relay.report({ phase: 'downloading', version: '2.1.309', transferred, total: 1000 })
    download(0)
    download(4)
    download(9)
    download(12)
    gone.destroyed = true
    unwatchFirst()
    const unwatchSecond = relay.watch(progressTarget(second))
    download(13)
    relay.report({ phase: 'placing', version: '2.1.309', transferred: 0, total: null })
    unwatchSecond()
    relay.report({ phase: 'placing', version: '2.1.309', transferred: 0, total: null })
    // Thousands of chunk callbacks inside one percent collapse to one message.
    expect(first).toEqual([
      { tool: 'claudeDesktop', phase: 'downloading', percent: 0 },
      { tool: 'claudeDesktop', phase: 'downloading', percent: 1 },
    ])
    // A window that starts waiting mid-download hears the current percent right away.
    expect(second).toEqual([
      { tool: 'claudeDesktop', phase: 'downloading', percent: 1 },
      { tool: 'claudeDesktop', phase: 'placing', percent: null },
    ])
  })

  it('reports the download and then the unpacking of a real placement', async () => {
    const relay = createClaudeCodeSeedProgressRelay()
    const sent: ExternalClientLaunchProgress[] = []
    relay.watch(progressTarget(sent))
    const f = seedFixture({ overrides: { onProgress: (event) => relay.report(event) } })
    expect(await f.seeder.prepare(client())).toEqual({ status: 'placed', version: '2.1.309' })
    expect(sent[0]).toEqual({ tool: 'claudeDesktop', phase: 'downloading', percent: expect.any(Number) })
    expect(sent.at(-2)).toEqual({ tool: 'claudeDesktop', phase: 'downloading', percent: 100 })
    expect(sent.at(-1)).toEqual({ tool: 'claudeDesktop', phase: 'placing', percent: null })
  })
})
