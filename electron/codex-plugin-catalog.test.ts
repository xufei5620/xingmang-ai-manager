import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CODEX_PLUGIN_CATALOG_URL,
  codexPluginCatalogBackupStuckMessage,
  codexPluginCatalogNetworkMessage,
  codexPluginCatalogPaths,
  ensureCodexPluginCatalog,
  inspectCodexPluginCatalog,
  parseCodexPluginCatalogTar,
} from './codex-plugin-catalog'
import { codexPluginCatalogBucketIndexUrl } from './codex-plugin-catalog-bucket'
import { desktopPackageBucketOrigin } from './desktop-package-bucket'

const temporaryDirectories: string[] = []
const commit = '1dc19589aa0d3f1c2b4e5f60718293a4b5c6d7e8'

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryCodexHome(): string {
  // macOS 的 os.tmpdir() 经过 /var → /private/var 这条系统链接，写入前的链接检查会拒绝它。
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codex-catalog-')))
  temporaryDirectories.push(directory)
  return path.join(directory, '.codex')
}

interface TarEntry {
  name: string
  type?: '0' | '2' | '5' | 'g' | 'x'
  mode?: number
  data?: string
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (`${length}`.length + Buffer.byteLength(body) !== length) length += 1
  return `${length}${body}`
}

/** 按 GitHub 打包的样子手搓一个 tar：pax 全局头带提交号，内容都在一个顶层目录下。 */
function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const header = Buffer.alloc(512)
    header.write(entry.name.slice(0, 100), 0, 'utf8')
    header.write(octal(entry.mode ?? 0o644, 8), 100, 'ascii')
    header.write(octal(0, 8), 108, 'ascii')
    header.write(octal(0, 8), 116, 'ascii')
    header.write(octal(data.length, 12), 124, 'ascii')
    header.write(octal(0, 12), 136, 'ascii')
    header.write('        ', 148, 'ascii')
    header.write(entry.type ?? '0', 156, 'ascii')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(octal(checksum, 7), 148, 'ascii')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function catalogEntries(extra: readonly TarEntry[] = []): TarEntry[] {
  return [
    { name: 'pax_global_header', type: 'g', data: paxRecord('comment', commit) },
    { name: 'openai-plugins-1dc1958/', type: '5', mode: 0o755 },
    { name: 'openai-plugins-1dc1958/.agents/plugins/marketplace.json', data: '{"name":"openai-curated","plugins":[]}' },
    { name: 'openai-plugins-1dc1958/.agents/plugins/api_marketplace.json', data: '{"name":"openai-api-curated","plugins":[]}' },
    { name: 'openai-plugins-1dc1958/plugins/demo/.codex-plugin/plugin.json', data: '{"name":"demo"}' },
    { name: 'openai-plugins-1dc1958/plugins/demo/scripts/run.sh', mode: 0o755, data: '#!/bin/sh\n' },
    ...extra,
  ]
}

function gzipCatalog(extra: readonly TarEntry[] = []): Buffer {
  return zlib.gzipSync(tar(catalogEntries(extra)))
}

function backupNames(parent: string): string[] {
  return fs.readdirSync(parent).filter((name) => name.startsWith('plugins-xingmang-backup-') && !name.endsWith('.sha')
    && name !== 'plugins-xingmang-backup-notes')
}

function servingFetch(body: Buffer, calls: string[] = []): typeof fetch {
  return async (input) => {
    calls.push(String(input))
    return new Response(new Uint8Array(body), { status: 200 })
  }
}

describe('Codex plugin catalog archive', () => {
  it('strips the GitHub top-level folder, keeps the commit and the executable bit', () => {
    const archive = parseCodexPluginCatalogTar(tar(catalogEntries()))

    expect(archive.commit).toBe(commit)
    expect(archive.files.map((file) => file.path)).toEqual([
      '.agents/plugins/marketplace.json',
      '.agents/plugins/api_marketplace.json',
      'plugins/demo/.codex-plugin/plugin.json',
      'plugins/demo/scripts/run.sh',
    ])
    expect(archive.files.find((file) => file.path.endsWith('run.sh'))?.executable).toBe(true)
    expect(archive.files.find((file) => file.path.endsWith('plugin.json'))?.executable).toBe(false)
  })

  it('takes a long path from the pax extended header', () => {
    const longName = `openai-plugins-1dc1958/plugins/${'deep/'.repeat(30)}file.md`
    const archive = parseCodexPluginCatalogTar(tar(catalogEntries([
      { name: 'PaxHeader', type: 'x', data: paxRecord('path', longName) },
      { name: longName.slice(0, 100), data: 'long' },
    ])))

    expect(archive.files.some((file) => file.path === longName.split('/').slice(1).join('/'))).toBe(true)
  })

  it('skips links instead of recreating them in the user profile', () => {
    const archive = parseCodexPluginCatalogTar(tar(catalogEntries([
      { name: 'openai-plugins-1dc1958/plugins/demo/escape', type: '2' },
    ])))

    expect(archive.files.some((file) => file.path.includes('escape'))).toBe(false)
  })

  it.each([
    'openai-plugins-1dc1958/../outside.txt',
    'openai-plugins-1dc1958/plugins/demo/../../../outside.txt',
    '/etc/passwd',
    'openai-plugins-1dc1958/plugins\\demo\\x.txt',
    'openai-plugins-1dc1958/plugins/demo/file.txt:stream',
    'openai-plugins-1dc1958/plugins/CON',
    'openai-plugins-1dc1958/plugins/trailing./x.txt',
  ])('rejects the hostile entry path %s', (name) => {
    expect(() => parseCodexPluginCatalogTar(tar(catalogEntries([{ name, data: 'x' }]))))
      .toThrow('插件目录不完整')
  })

  it('rejects two entries that only differ by case', () => {
    expect(() => parseCodexPluginCatalogTar(tar(catalogEntries([
      { name: 'openai-plugins-1dc1958/plugins/demo/README.md', data: 'a' },
      { name: 'openai-plugins-1dc1958/plugins/demo/readme.md', data: 'b' },
    ])))).toThrow('插件目录不完整')
  })

  it('rejects an archive without both marketplace manifests', () => {
    const entries = catalogEntries().filter((entry) => !entry.name.endsWith('api_marketplace.json'))

    expect(() => parseCodexPluginCatalogTar(tar(entries))).toThrow('插件目录不完整')
  })

  it('rejects a truncated archive', () => {
    const complete = tar(catalogEntries())

    expect(() => parseCodexPluginCatalogTar(complete.subarray(0, complete.length - 1024 - 512)))
      .toThrow('插件目录不完整')
  })
})

describe('ensureCodexPluginCatalog', () => {
  it('puts the snapshot where Codex reads it, with the commit beside it', async () => {
    const codexHome = temporaryCodexHome()
    const calls: string[] = []

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog(), calls) }))
      .resolves.toBe('downloaded')

    const paths = codexPluginCatalogPaths(codexHome)
    expect(calls).toEqual([CODEX_PLUGIN_CATALOG_URL])
    expect(fs.readFileSync(paths.shaFile, 'utf8')).toBe(`${commit}\n`)
    expect(fs.readFileSync(path.join(paths.directory, 'plugins/demo/.codex-plugin/plugin.json'), 'utf8'))
      .toBe('{"name":"demo"}')
    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
    expect(fs.readdirSync(path.dirname(paths.directory)).sort()).toEqual(['plugins', 'plugins.sha'])
  })

  it('never downloads again over a complete snapshot', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const calls: string[] = []

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog(), calls) }))
      .resolves.toBe('present')
    expect(calls).toEqual([])
  })

  it.each([
    '',
    '{broken-json',
    '{}',
    '{"name":"wrong-market","plugins":[]}',
    '{"name":"openai-api-curated","plugins":{}}',
    '{"name":"openai-api-curated","plugins":[null]}',
    '{"name":"openai-api-curated","plugins":[{}]}',
    '{"name":"openai-api-curated","plugins":[{"name":"demo"}]}',
    '{"name":"openai-api-curated","plugins":[{"name":"demo","source":{"source":"local"}}]}',
  ])('does not call a damaged marketplace manifest complete: %s', async (content) => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), content)

    expect(inspectCodexPluginCatalog(codexHome).present).toBe(false)
  })

  it('accepts the official local-plugin source shape without restricting optional metadata', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    fs.writeFileSync(path.join(codexPluginCatalogPaths(codexHome).directory, '.agents/plugins/api_marketplace.json'), JSON.stringify({
      name: 'openai-api-curated',
      interface: { displayName: 'Codex official' },
      plugins: [{ name: 'demo', source: { source: 'local', path: './plugins/demo' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Developer Tools' }],
    }))

    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
  })

  it.each(['', 'not-a-commit', 'x'.repeat(129)])('rejects an invalid bounded catalog version: %s', async (version) => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    fs.writeFileSync(codexPluginCatalogPaths(codexHome).shaFile, version)

    expect(inspectCodexPluginCatalog(codexHome).present).toBe(false)
  })

  it('bounds the existing manifest before declaring the catalog ready', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), JSON.stringify({
      name: 'openai-api-curated', plugins: [], padding: 'x'.repeat(4 * 1024 * 1024),
    }))

    expect(inspectCodexPluginCatalog(codexHome).present).toBe(false)
  })

  it('repairs a corrupt catalog while retaining its original files and version for recovery', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), '{broken-json')
    fs.writeFileSync(path.join(paths.directory, 'user-note.txt'), 'keep my local changes')
    const calls: string[] = []

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog(), calls) }))
      .resolves.toBe('downloaded')

    expect(calls).toEqual([CODEX_PLUGIN_CATALOG_URL])
    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
    const parent = path.dirname(paths.directory)
    const retained = fs.readdirSync(parent, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('plugins-xingmang-backup-'))
    expect(retained).toBeDefined()
    const backup = path.join(parent, retained!.name)
    expect(fs.readFileSync(path.join(backup, '.agents/plugins/api_marketplace.json'), 'utf8')).toBe('{broken-json')
    expect(fs.readFileSync(path.join(backup, 'user-note.txt'), 'utf8')).toBe('keep my local changes')
    expect(fs.readFileSync(`${backup}.sha`, 'utf8')).toBe(`${commit}\n`)
  })

  it('rejects an invalid downloaded manifest without moving the existing catalog', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    const manifest = path.join(paths.directory, '.agents/plugins/api_marketplace.json')
    fs.writeFileSync(manifest, '{old-broken-json')
    const entries = catalogEntries().map((entry) => entry.name.endsWith('api_marketplace.json')
      ? { ...entry, data: '{new-broken-json' } : entry)

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(zlib.gzipSync(tar(entries))) }))
      .rejects.toThrow('插件目录不完整')

    expect(fs.readFileSync(manifest, 'utf8')).toBe('{old-broken-json')
    expect(fs.readFileSync(paths.shaFile, 'utf8')).toBe(`${commit}\n`)
    expect(fs.readdirSync(path.dirname(paths.directory)).sort()).toEqual(['plugins', 'plugins.sha'])
  })

  it('keeps only the latest repair backup so repeated repairs never get stuck', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    const manifest = path.join(paths.directory, '.agents/plugins/api_marketplace.json')
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(manifest, `{broken-${index}`)
      await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
        .resolves.toBe('downloaded')
    }

    const parent = path.dirname(paths.directory)
    const backups = backupNames(parent)
    expect(backups).toHaveLength(1)
    const backup = path.join(parent, backups[0])
    expect(fs.readFileSync(path.join(backup, '.agents/plugins/api_marketplace.json'), 'utf8')).toBe('{broken-4')
    expect(fs.readFileSync(`${backup}.sha`, 'utf8')).toBe(`${commit}\n`)
    expect(fs.readdirSync(parent).filter((name) => name.endsWith('.sha')).sort())
      .toEqual([`${backups[0]}.sha`, 'plugins.sha'].sort())
  })

  it('clears backups left by older versions before repairing, keeping the newest one', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    const parent = path.dirname(paths.directory)
    const legacy = [1, 2, 3].map((index) => {
      const name = `plugins-xingmang-backup-0000000${index}-0000-4000-8000-000000000000`
      fs.mkdirSync(path.join(parent, name))
      fs.writeFileSync(path.join(parent, name, 'marker.txt'), `${index}`)
      fs.writeFileSync(path.join(parent, `${name}.sha`), `${commit}\n`)
      return name
    })
    const unrelated = path.join(parent, 'plugins-xingmang-backup-notes')
    fs.mkdirSync(unrelated)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), '{fourth-broken-catalog')
    const calls: string[] = []

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog(), calls) }))
      .resolves.toBe('downloaded')

    expect(calls).toEqual([CODEX_PLUGIN_CATALOG_URL])
    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
    const remaining = backupNames(parent)
    expect(remaining).toHaveLength(1)
    expect(legacy).not.toContain(remaining[0])
    expect(fs.existsSync(unrelated)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('never deletes a linked backup and stops without downloading when too many cannot be cleared', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    const parent = path.dirname(paths.directory)
    const outside = path.join(path.dirname(codexHome), 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep')
    for (const index of [1, 2, 3]) {
      fs.symlinkSync(outside, path.join(parent, `plugins-xingmang-backup-0000000${index}-0000-4000-8000-000000000000`))
    }
    const manifest = path.join(paths.directory, '.agents/plugins/api_marketplace.json')
    fs.writeFileSync(manifest, '{broken-catalog')
    const calls: string[] = []

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog(), calls) }))
      .rejects.toThrow(codexPluginCatalogBackupStuckMessage)

    expect(calls).toEqual([])
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{broken-catalog')
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep')
    expect(backupNames(parent)).toHaveLength(3)
  })

  it('restores the original catalog if publishing its new version file fails', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    const manifest = path.join(paths.directory, '.agents/plugins/api_marketplace.json')
    fs.writeFileSync(manifest, '{old-broken-json')
    fs.writeFileSync(path.join(paths.directory, 'user-note.txt'), 'keep my local changes')
    const originalDirectory = fs.statSync(paths.directory, { bigint: true })
    const rename = fs.promises.rename
    const link = fs.promises.link
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === paths.shaFile && path.basename(String(source)).startsWith('plugins-xingmang-stage-')) {
        throw new Error('模拟目录版本写入失败')
      }
      return rename(source, target)
    })
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      if (String(target) === paths.shaFile && path.basename(String(source)).startsWith('plugins-xingmang-stage-')) {
        throw new Error('模拟目录版本写入失败')
      }
      return link(source, target)
    })

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
      .rejects.toThrow('模拟目录版本写入失败')

    expect(fs.statSync(paths.directory, { bigint: true }).ino).toBe(originalDirectory.ino)
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{old-broken-json')
    expect(fs.readFileSync(path.join(paths.directory, 'user-note.txt'), 'utf8')).toBe('keep my local changes')
    expect(fs.readFileSync(paths.shaFile, 'utf8')).toBe(`${commit}\n`)
  })

  it('never replaces a version file created after its absence was checked', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), '{old-broken-json')
    const concurrentVersion = `${'2'.repeat(40)}\n`
    const rename = fs.promises.rename
    const link = fs.promises.link
    const plantConcurrentVersion = (source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === paths.shaFile && path.basename(String(source)).startsWith('plugins-xingmang-stage-')) {
        fs.writeFileSync(paths.shaFile, concurrentVersion, { flag: 'wx' })
      }
    }
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      plantConcurrentVersion(source, target)
      return rename(source, target)
    })
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      plantConcurrentVersion(source, target)
      return link(source, target)
    })

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
      .rejects.toThrow('原文件已保留')

    expect(fs.readFileSync(paths.shaFile, 'utf8')).toBe(concurrentVersion)
    const parent = path.dirname(paths.directory)
    const retainedVersion = fs.readdirSync(parent)
      .find((name) => name.startsWith('plugins-xingmang-backup-') && name.endsWith('.sha'))
    expect(retainedVersion).toBeDefined()
    expect(fs.readFileSync(path.join(parent, retainedVersion!), 'utf8')).toBe(`${commit}\n`)
  })

  it('rechecks the catalog identity after publishing the version file', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), '{old-broken-json')
    fs.writeFileSync(path.join(paths.directory, 'user-note.txt'), 'original local edit')
    const rename = fs.promises.rename
    const link = fs.promises.link
    const replaceDirectory = (source: fs.PathLike, target: fs.PathLike) => {
      if (String(target) === paths.shaFile && path.basename(String(source)).startsWith('plugins-xingmang-stage-')) {
        fs.renameSync(paths.directory, path.join(path.dirname(paths.directory), 'concurrent-moved-published'))
        fs.mkdirSync(paths.directory)
        fs.writeFileSync(path.join(paths.directory, 'concurrent.txt'), 'other process owns this')
      }
    }
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target)
      replaceDirectory(source, target)
    })
    vi.spyOn(fs.promises, 'link').mockImplementation(async (source, target) => {
      await link(source, target)
      replaceDirectory(source, target)
    })

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
      .rejects.toThrow('原文件已保留')

    expect(fs.readFileSync(path.join(paths.directory, 'concurrent.txt'), 'utf8')).toBe('other process owns this')
    const parent = path.dirname(paths.directory)
    const retained = fs.readdirSync(parent, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('plugins-xingmang-backup-'))
    expect(retained).toBeDefined()
    expect(fs.readFileSync(path.join(parent, retained!.name, 'user-note.txt'), 'utf8')).toBe('original local edit')
  })

  it('preserves both the original backup and a concurrent replacement during rollback', async () => {
    const codexHome = temporaryCodexHome()
    await ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) })
    const paths = codexPluginCatalogPaths(codexHome)
    fs.writeFileSync(path.join(paths.directory, '.agents/plugins/api_marketplace.json'), '{old-broken-json')
    fs.writeFileSync(path.join(paths.directory, 'user-note.txt'), 'original local edit')
    const rename = fs.promises.rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === paths.directory && path.basename(String(source)).startsWith('plugins-xingmang-stage-')) {
        fs.mkdirSync(paths.directory)
        fs.writeFileSync(path.join(paths.directory, 'concurrent.txt'), 'other process owns this')
        throw new Error('模拟另一进程刚写入目录')
      }
      return rename(source, target)
    })

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
      .rejects.toThrow('原文件已保留')

    expect(fs.readFileSync(path.join(paths.directory, 'concurrent.txt'), 'utf8')).toBe('other process owns this')
    const parent = path.dirname(paths.directory)
    const retained = fs.readdirSync(parent, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith('plugins-xingmang-backup-'))
    expect(retained).toBeDefined()
    expect(fs.readFileSync(path.join(parent, retained!.name, 'user-note.txt'), 'utf8')).toBe('original local edit')
    expect(fs.readFileSync(paths.shaFile, 'utf8')).toBe(`${commit}\n`)
  })

  it('replaces a folder Codex left behind without its commit file', async () => {
    const codexHome = temporaryCodexHome()
    const paths = codexPluginCatalogPaths(codexHome)
    fs.mkdirSync(path.join(paths.directory, 'leftover'), { recursive: true })

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
      .resolves.toBe('downloaded')
    expect(fs.existsSync(path.join(paths.directory, 'leftover'))).toBe(false)
    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
  })

  it('refuses to follow a redirect to another host', async () => {
    const codexHome = temporaryCodexHome()
    const calls: string[] = []
    const redirecting: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com.evil.test/x.tgz' } })
    }

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: redirecting }))
      .rejects.toThrow(codexPluginCatalogNetworkMessage)
    expect(calls).toEqual([CODEX_PLUGIN_CATALOG_URL])
    expect(fs.existsSync(codexPluginCatalogPaths(codexHome).directory)).toBe(false)
  })

  it('reports an unreachable network in plain words and leaves nothing behind', async () => {
    const codexHome = temporaryCodexHome()
    const failing: typeof fetch = async () => { throw new TypeError('fetch failed') }

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: failing }))
      .rejects.toThrow(codexPluginCatalogNetworkMessage)
    expect(fs.existsSync(path.join(codexHome, '.tmp'))).toBe(false)
  })

  it('reports a server error as a network failure', async () => {
    const codexHome = temporaryCodexHome()
    const failing: typeof fetch = async () => new Response('busy', { status: 503 })

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: failing }))
      .rejects.toThrow(codexPluginCatalogNetworkMessage)
  })

  it('rejects a body that is not a gzip archive', async () => {
    const codexHome = temporaryCodexHome()

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(Buffer.from('<html>login</html>')) }))
      .rejects.toThrow('插件目录不完整')
    expect(fs.existsSync(codexPluginCatalogPaths(codexHome).directory)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('refuses to write through a linked .tmp folder', async () => {
    const codexHome = temporaryCodexHome()
    const elsewhere = temporaryCodexHome()
    fs.mkdirSync(codexHome, { recursive: true })
    fs.mkdirSync(elsewhere, { recursive: true })
    fs.symlinkSync(elsewhere, path.join(codexHome, '.tmp'))

    await expect(ensureCodexPluginCatalog({ codexHome, fetch: servingFetch(gzipCatalog()) }))
      .rejects.toThrow('符号链接')
    expect(fs.readdirSync(elsewhere)).toEqual([])
  })
})

describe('ensureCodexPluginCatalog from the Xingmang bucket', () => {
  // The bucket copy is the archive GitHub serves for one commit; random padding keeps it above
  // the smallest size the bucket index may describe.
  const bucketCommit = commit
  const padding = { name: 'openai-plugins-1dc1958/plugins/demo/assets/noise.txt', data: randomBytes(80 * 1024).toString('base64') }

  function bucketFetch(archive: Buffer, options: { indexStatus?: number; commit?: string } = {}): { fetch: typeof fetch; calls: string[] } {
    const calls: string[] = []
    const sha = createHash('sha256').update(archive).digest('hex')
    const indexCommit = options.commit ?? bucketCommit
    const key = `xingmang/offline/codex-plugins/sha256-${sha}/openai-plugins-${indexCommit}.tar.gz`
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url === codexPluginCatalogBucketIndexUrl()) {
        if (options.indexStatus) return new Response('<Error/>', { status: options.indexStatus })
        return new Response(JSON.stringify({
          schemaVersion: 1,
          product: 'codex-plugin-catalog',
          generatedAt: '2026-10-13T16:00:00.000Z',
          source: { repository: 'openai/plugins', ref: 'main', commit: indexCommit, url: `https://codeload.github.com/openai/plugins/tar.gz/${indexCommit}` },
          artifact: { key, url: `${desktopPackageBucketOrigin}/${key}`, bytes: archive.length, sha256: sha, contentType: 'application/gzip',
            verification: 'github-commit-archive-manifests', cosEtag: '"etag"' },
        }), { status: 200 })
      }
      if (url === `${desktopPackageBucketOrigin}/${key}`) {
        return new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/gzip', 'content-length': String(archive.length) } })
      }
      if (url === CODEX_PLUGIN_CATALOG_URL) return new Response(new Uint8Array(gzipCatalog()), { status: 200 })
      throw new Error(`unexpected request ${url}`)
    }
    return { fetch, calls }
  }

  it('installs the bucket copy without going to GitHub or borrowing a download line', async () => {
    const codexHome = temporaryCodexHome()
    const { fetch, calls } = bucketFetch(gzipCatalog([padding]))
    const acquireGitHubRoute = vi.fn(async () => ({ release: async () => undefined }))
    const onFallback = vi.fn()

    await expect(ensureCodexPluginCatalog({ codexHome, fetch, bucket: { onFallback }, acquireGitHubRoute })).resolves.toBe('downloaded')

    expect(calls).toHaveLength(2)
    expect(calls).not.toContain(CODEX_PLUGIN_CATALOG_URL)
    expect(acquireGitHubRoute).not.toHaveBeenCalled()
    expect(onFallback).not.toHaveBeenCalled()
    expect(fs.readFileSync(codexPluginCatalogPaths(codexHome).shaFile, 'utf8')).toBe(`${bucketCommit}\n`)
    expect(fs.readFileSync(path.join(codexPluginCatalogPaths(codexHome).directory, 'plugins/demo/assets/noise.txt'), 'utf8')).toBe(padding.data)
    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
  })

  it.each([
    ['the bucket has no catalog yet', () => bucketFetch(gzipCatalog([padding]), { indexStatus: 404 }), /HTTP 404/],
    ['the archive carries another commit than the index', () => bucketFetch(gzipCatalog([padding]), { commit: '2ab19589aa0d3f1c2b4e5f60718293a4b5c6d7e9' }), /提交号对不上/],
    ['the archive breaks the catalog rules', () => bucketFetch(zlib.gzipSync(tar(catalogEntries([
      padding, { name: 'openai-plugins-1dc1958/../outside.txt', data: 'x' },
    ])))), /不完整/],
  ])('falls back to GitHub with a borrowed line when %s', async (_name, serve, detail) => {
    const codexHome = temporaryCodexHome()
    const { fetch, calls } = serve()
    const release = vi.fn(async () => undefined)
    const acquireGitHubRoute = vi.fn(async () => ({ release }))
    const onFallback = vi.fn()

    await expect(ensureCodexPluginCatalog({ codexHome, fetch, bucket: { onFallback }, acquireGitHubRoute })).resolves.toBe('downloaded')

    expect(calls[0]).toBe(codexPluginCatalogBucketIndexUrl())
    expect(calls.at(-1)).toBe(CODEX_PLUGIN_CATALOG_URL)
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(onFallback.mock.calls[0][0]).toMatch(/^codex-plugin-catalog：/)
    expect(onFallback.mock.calls[0][0]).toMatch(detail)
    expect(acquireGitHubRoute).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(codexPluginCatalogPaths(codexHome).directory, 'outside.txt'))).toBe(false)
    expect(inspectCodexPluginCatalog(codexHome).present).toBe(true)
  })

  it('still downloads from GitHub when no line can be borrowed, and returns the line even when GitHub fails', async () => {
    const codexHome = temporaryCodexHome()
    const { fetch } = bucketFetch(gzipCatalog([padding]), { indexStatus: 404 })
    await expect(ensureCodexPluginCatalog({ codexHome, fetch, bucket: {}, acquireGitHubRoute: async () => { throw new Error('no line') } }))
      .resolves.toBe('downloaded')

    const offline = temporaryCodexHome()
    const release = vi.fn(async () => undefined)
    const failing: typeof globalThis.fetch = async () => { throw new TypeError('fetch failed') }
    await expect(ensureCodexPluginCatalog({ codexHome: offline, fetch: failing, bucket: {}, acquireGitHubRoute: async () => ({ release }) }))
      .rejects.toThrow(codexPluginCatalogNetworkMessage)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
