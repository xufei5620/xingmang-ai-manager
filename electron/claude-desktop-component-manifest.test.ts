import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  claudeDesktopMacAsarPath,
  findClaudeCodeComponentPins,
  findClaudeDesktopVmBundle,
  parseClaudeCodeComponentPins,
  parseClaudeDesktopVmVersion,
  parseJsLiteral,
  readClaudeDesktopComponentManifest,
} from './claude-desktop-component-manifest'

// Real values from Claude Desktop 4.4212.0 (probe run 41623510171, 2026-11-03).
const currentSha = '072b6cbfe74f428a98bd86035f83b322b369d1f1'
const previousSha = '6db63bc6b9dd16e8f0354c0a9510c4be711ec6ad'
const winRootfs = { name: 'rootfs.vhdx', checksum: 'c480f8a62d0d9be20e1a1ee31b9f25c73097f793127dcefa90b0c59ada0e12ad', size: 1309889215, rawChecksum: 'bd0ffa54047270b34fa740b1518dc8591853338d1808848e5fd11b23fe9f3f46', rawSize: 7826571264 }
const winInitrd = { name: 'initrd', checksum: 'e3c5ce2b8e9e9adf67de7ec83cafa4a0c65fab8a22036a6b53f03c9765b3342a', size: 28024101, rawChecksum: 'e44ac25a25e1a849275d4447764bed765ba4e3aad9cd965704aa960556a443dd', rawSize: 28375606 }
const macRootfs = { name: 'rootfs.img', checksum: '40818968b6929fcb32ab01f45116cf9fa7eebf5b078c1603b44a6da0eb262d69', size: 1246877094, rawChecksum: '7e94ba2d3952af47dfb7bdeb7ace4e911b9b661df3ef7c19341a4c3bc719ce93', rawSize: 10737418240 }

function fileLiteral(file: { name: string; checksum: string; size: number; rawChecksum?: string; rawSize?: number }, withDelta = false): string {
  const raw = file.rawChecksum ? `,rawChecksum:"${file.rawChecksum}",rawSize:${file.rawSize}` : ''
  const delta = withDelta ? `,deltas:[{fromSha:"${previousSha}",checksum:"${'a'.repeat(64)}",size:12345}]` : ''
  return `{name:"${file.name}",checksum:"${file.checksum}",size:${file.size},progressStart:0,progressEnd:80${raw}${delta}}`
}

function vmChunk(): string {
  const current = `{sha:"${currentSha}",publishedAt:"2026-10-22",files:{unix:{arm64:[${fileLiteral(macRootfs, true)}],x64:[${fileLiteral(macRootfs)}]},`
    + `win32:{arm64:[${fileLiteral(winRootfs)}],x64:[${fileLiteral(winRootfs, true)},${fileLiteral(winInitrd)}]}}}`
  const previous = `{sha:"${previousSha}",publishedAt:"2026-10-21",files:{win32:{x64:[${fileLiteral({ ...winRootfs, checksum: '9'.repeat(64) })}]}}}`
  return 'var Kli="2768844978";var VG={_comment:"Previous versions are kept so the publish workflow can generate binary deltas from them. Written by the update-manifest step - do not hand-edit.",'
    + `versions:[${current},${previous}]};function _Z(){return RG.files[e][t]??[]}`
}

function codeJson(): string {
  return JSON.stringify({
    version: '2.1.309',
    manifest: {
      version: '2.1.309',
      platforms: {
        'darwin-arm64': { binary: 'claude.zst', checksum: '614eb35bb650dee9cfa4a7821a60d5eab75fbcabe2c1b8aa408d2e93f06c1370', size: 93159896, bundle: { checksum: '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba', size: 93151388 } },
        'darwin-x64': { binary: 'claude.zst', checksum: '7426a8b80fe213e90b8e58682a54668aa7efe838939c9b2cab8d6089ab13befb', size: 98568120, bundle: { checksum: '300ae7409767b5bf31c77b466987278ee4493cfc82099ef4ad89841f7bfc71d4', size: 98585917 } },
        'linux-x64': { binary: 'claude.zst', checksum: 'e52289b95def16148c8d0a48b1ccc0d357429e73473a9a20ac0638fb7460a59b', size: 103411745 },
        'linux-arm64': { binary: 'claude.zst', checksum: 'b'.repeat(64), size: 99000000 },
        'win32-x64': { binary: 'claude.exe.zst', checksum: '9078b9c1d466965d3faee8d13128f03d79b61794fb2130255ca1f5eab84e602c', size: 106715810 },
      },
    },
  })
}

function codeChunk(json = codeJson()): string {
  // A decoy JSON.parse with the same opening sits next to the real one in the shipped chunk.
  return 'function HSt(){return JSON.parse(\'{"version":"be1c1ca50b7b27c5f9341e4cbabc2039588fe597","manifest":{"platforms":{}}}\')}'
    + `function M_(){return JSON.parse('${json}')}`
}

function asarArchive(scripts: Record<string, Buffer>): Buffer {
  const files: Record<string, unknown> = {}
  const contents: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(scripts)) {
    files[name] = { size: content.length, offset: String(offset) }
    contents.push(content)
    offset += content.length
  }
  const json = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files } } } } }))
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

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-claude-manifest-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('parseJsLiteral', () => {
  it('reads minified object and array literals with unquoted keys', () => {
    const text = 'x={a:[1,-2.5,"q\\"uote",!0,!1,null],"b c":{d:1e3}};'
    const parsed = parseJsLiteral(text, 2)
    expect(parsed?.value).toEqual({ a: [1, -2.5, 'q"uote', true, false, null], 'b c': { d: 1000 } })
    expect(text[parsed?.end ?? 0]).toBe(';')
  })

  it('refuses anything that is not plain data', () => {
    for (const text of ['{a:b}', '{a:f()}', '{a:`t`}', '{a:1', '{__proto__:1}', '{a:1,a:2}', '{a:"line\nbreak"}', '[1,]x', '{a:0x10}']) {
      expect(parseJsLiteral(text, 0), text).toBeNull()
    }
  })

  it('stops at the depth and length limits instead of reading on', () => {
    expect(parseJsLiteral(`${'['.repeat(20)}${']'.repeat(20)}`, 0)).toBeNull()
    expect(parseJsLiteral(`[${'1,'.repeat(100)}1]`, 0, 50)).toBeNull()
  })

  it('never puts parsed keys on the object prototype', () => {
    const parsed = parseJsLiteral('{toString:1,hasOwnProperty:2}', 0)
    expect(Object.getPrototypeOf(parsed?.value)).toBeNull()
  })
})

describe('findClaudeDesktopVmBundle', () => {
  it('takes the newest workspace version with every platform and architecture', () => {
    const bundle = findClaudeDesktopVmBundle(vmChunk())
    expect(bundle?.sha).toBe(currentSha)
    expect(bundle?.files.win32.x64?.map((file) => file.name)).toEqual(['rootfs.vhdx', 'initrd'])
    expect(bundle?.files.win32.x64?.[0]).toEqual(winRootfs)
    expect(bundle?.files.unix.arm64?.[0]).toEqual(macRootfs)
    expect(bundle?.files.win32.arm64).toHaveLength(1)
  })

  it('gives null when the literal is missing or malformed', () => {
    expect(findClaudeDesktopVmBundle('nothing here')).toBeNull()
    expect(findClaudeDesktopVmBundle(vmChunk().replace(currentSha, 'not-a-sha'))).toBeNull()
    expect(findClaudeDesktopVmBundle(vmChunk().replace('name:"rootfs.vhdx"', 'name:"../rootfs.vhdx"'))).toBeNull()
  })

  it('rejects file entries with unsafe names, bad checksums or impossible sizes', () => {
    const base = { sha: currentSha, files: { win32: { x64: [{ ...winRootfs }] } } }
    expect(parseClaudeDesktopVmVersion(base)?.files.win32.x64).toHaveLength(1)
    for (const file of [
      { ...winRootfs, name: 'a/b' },
      { ...winRootfs, name: '..' },
      { ...winRootfs, checksum: 'ABC' },
      { ...winRootfs, size: 0 },
      { ...winRootfs, size: 5 * 1024 * 1024 * 1024 },
      { ...winRootfs, rawChecksum: 'nope' },
    ]) {
      expect(parseClaudeDesktopVmVersion({ ...base, files: { win32: { x64: [file] } } })).toBeNull()
    }
    expect(parseClaudeDesktopVmVersion({ ...base, files: { win32: { x64: [winRootfs, winRootfs] } } })).toBeNull()
  })
})

describe('Claude Code component pins', () => {
  it('reads the Mac app bundles and the Linux binaries the workspace runs', () => {
    const pins = parseClaudeCodeComponentPins(codeJson())
    expect(pins?.version).toBe('2.1.309')
    expect(pins?.macBundles['darwin-arm64']).toEqual({ checksum: '5af865b9901c3f7512d85aa78571966834c943e3143f1b82ef4d33ed89b7f0ba', size: 93151388 })
    expect(pins?.macBundles['darwin-x64']?.size).toBe(98585917)
    expect(pins?.linux['linux-x64']).toEqual({ binary: 'claude.zst', checksum: 'e52289b95def16148c8d0a48b1ccc0d357429e73473a9a20ac0638fb7460a59b', size: 103411745 })
  })

  it('skips the decoy JSON.parse that shares the opening and finds the real manifest', () => {
    expect(findClaudeCodeComponentPins(codeChunk())?.version).toBe('2.1.309')
    expect(findClaudeCodeComponentPins('JSON.parse(\'{"version":"1"}\')')).toBeNull()
  })

  it('drops a platform whose entry is malformed but keeps the rest', () => {
    const json = JSON.parse(codeJson()) as { manifest: { platforms: Record<string, Record<string, unknown>> } }
    json.manifest.platforms['darwin-x64'].bundle = { checksum: 'short', size: 1 }
    const pins = parseClaudeCodeComponentPins(JSON.stringify(json))
    expect(pins?.macBundles['darwin-x64']).toBeUndefined()
    expect(pins?.macBundles['darwin-arm64']).toBeDefined()
  })
})

describe('readClaudeDesktopComponentManifest', () => {
  it('finds both manifests across the scripts in one pass over the archive', async () => {
    const directory = temporaryDirectory()
    const asarPath = path.join(directory, 'app.asar')
    fs.writeFileSync(asarPath, asarArchive({
      'index.chunk-small.js': Buffer.from('console.log(1)'),
      'index.chunk-code.js': Buffer.from(`${'x'.repeat(4096)}${codeChunk()}`),
      'index.chunk-vm.js': Buffer.from(`${'y'.repeat(8192)}${vmChunk()}`),
    }))
    const manifest = await readClaudeDesktopComponentManifest(asarPath)
    expect(manifest.code?.version).toBe('2.1.309')
    expect(manifest.vm?.sha).toBe(currentSha)
  })

  it('returns nulls for an archive without either manifest and throws for a non-archive', async () => {
    const directory = temporaryDirectory()
    const asarPath = path.join(directory, 'app.asar')
    fs.writeFileSync(asarPath, asarArchive({ 'index.js': Buffer.from('void 0') }))
    expect(await readClaudeDesktopComponentManifest(asarPath)).toEqual({ code: null, vm: null })
    fs.writeFileSync(asarPath, 'not an asar')
    await expect(readClaudeDesktopComponentManifest(asarPath)).rejects.toThrow()
  })

  it('points at the archive inside the Mac application bundle', () => {
    expect(claudeDesktopMacAsarPath('/Applications/Claude.app')).toBe('/Applications/Claude.app/Contents/Resources/app.asar')
  })
})
