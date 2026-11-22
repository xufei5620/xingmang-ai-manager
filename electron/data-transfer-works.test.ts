import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'
import {
  MAX_TRANSFERRED_WORKS,
  WORKS_DATA_FILE_NAME,
  WORKS_FOLDER_NAME,
  WORKS_MANIFEST_FILE,
  buildWorksManifest,
  createAccountWorksTransfer,
  importAccountWorks,
  inspectWorksFolder,
  listAccountWorks,
  parseWorksManifest,
  summarizeAccountWorks,
  worksExportIncompleteMessage,
  worksExportNoSpaceMessage,
  writeWorksExport,
  type AccountWorksSummary,
  type WorksExportOptions,
} from './data-transfer-works'
import type { DiskSpaceReading } from './disk-space'

const roots: string[] = []
const userId = 7

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `xingmang-works-${prefix}-`))
  roots.push(root)
  return root
}

function idFor(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url')
}

const headers: Record<string, Buffer> = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  mp4: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii')]),
  mp3: Buffer.from('ID3', 'ascii'),
}

function mediaBytes(extension: string, filler: string): Buffer {
  return Buffer.concat([headers[extension], Buffer.from(filler, 'utf8')])
}

function writeWork(outputRoot: string, date: string, seed: string, extension: string, filler = seed): { id: string; filePath: string } {
  const id = idFor(seed)
  const directory = path.join(outputRoot, `user-${userId}`, date)
  fs.mkdirSync(directory, { recursive: true })
  const filePath = path.join(directory, `xingmang-${id}.${extension}`)
  fs.writeFileSync(filePath, mediaBytes(extension, filler))
  return { id, filePath }
}

function space(availableBytes: number): (target: string) => Promise<DiskSpaceReading> {
  return async (target) => ({ availableBytes, totalBytes: availableBytes * 2, measuredPath: target, deviceId: null })
}

const plenty = space(1024 ** 4)

function exportOptions(parentDirectory: string, overrides: Partial<WorksExportOptions> = {}): WorksExportOptions {
  return {
    parentDirectory,
    folderName: '星芒数据导出-2026-11-22',
    works: [],
    metadata: [],
    dataContent: (exported: AccountWorksSummary) => JSON.stringify({ works: exported }),
    readDiskSpace: plenty,
    ...overrides,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('listAccountWorks', () => {
  it('lists the plain works of one account, newest date first, and nothing else in the folder', async () => {
    const outputRoot = temporaryRoot('list')
    const older = writeWork(outputRoot, '2026-11-01', 'older', 'png')
    const newer = writeWork(outputRoot, '2026-11-20', 'newer', 'mp4')
    const song = writeWork(outputRoot, '2026-11-20', 'song', 'mp3')
    const accountRoot = path.join(outputRoot, `user-${userId}`)
    fs.writeFileSync(path.join(accountRoot, '2026-11-20', 'notes.txt'), 'not a work')
    fs.writeFileSync(path.join(accountRoot, '2026-11-20', `xingmang-${idFor('empty')}.png`), '')
    fs.mkdirSync(path.join(accountRoot, 'asset-metadata'))
    fs.mkdirSync(path.join(accountRoot, 'not-a-date'))
    fs.writeFileSync(path.join(accountRoot, 'not-a-date', `xingmang-${idFor('stray')}.png`), headers.png)

    const works = await listAccountWorks(outputRoot, userId)
    expect(works.map((work) => work.assetId).sort()).toEqual([newer.id, song.id, older.id].sort())
    expect(works.at(-1)).toEqual({ assetId: older.id, mediaType: 'image', relativePath: `2026-11-01/xingmang-${older.id}.png`, bytes: fs.statSync(older.filePath).size, filePath: older.filePath })
    expect(summarizeAccountWorks(works)).toEqual({ images: 1, videos: 1, audios: 1, bytes: works.reduce((total, work) => total + work.bytes, 0) })
  })

  it('leaves out excluded works, hard-linked files and the older copy of a work saved under two dates', async () => {
    const outputRoot = temporaryRoot('list-skip')
    const trashed = writeWork(outputRoot, '2026-11-02', 'trashed', 'png')
    const linked = writeWork(outputRoot, '2026-11-02', 'linked', 'png')
    fs.linkSync(linked.filePath, path.join(temporaryRoot('elsewhere'), 'second-name.png'))
    const twice = writeWork(outputRoot, '2026-11-03', 'twice', 'jpg')
    writeWork(outputRoot, '2026-11-01', 'twice', 'jpg')

    const works = await listAccountWorks(outputRoot, userId, { excluded: new Set([trashed.id]) })
    expect(works.map((work) => [work.assetId, work.relativePath])).toEqual([[twice.id, `2026-11-03/xingmang-${twice.id}.jpg`]])
  })

  it('finds nothing for an account that has never saved a work', async () => {
    await expect(listAccountWorks(temporaryRoot('empty'), userId)).resolves.toEqual([])
    await expect(listAccountWorks(temporaryRoot('bad-user'), 0)).rejects.toThrow('AI 作品账号标识无效')
  })
})

describe('writeWorksExport', () => {
  it('writes the works in the library layout, the manifest and the chat file last', async () => {
    const outputRoot = temporaryRoot('export-source')
    const parent = temporaryRoot('export-target')
    const image = writeWork(outputRoot, '2026-11-20', 'image', 'png')
    const clip = writeWork(outputRoot, '2026-11-21', 'clip', 'mp4')
    const works = await listAccountWorks(outputRoot, userId)
    const result = await writeWorksExport(exportOptions(parent, {
      works,
      metadata: [
        { assetId: image.id, displayName: '海报', updatedAt: '2026-11-20T00:00:00.000Z' },
        { assetId: idFor('not-exported'), displayName: '别的', updatedAt: '2026-11-20T00:00:00.000Z' },
      ],
    }))

    expect(result).toEqual({
      folderPath: path.join(parent, '星芒数据导出-2026-11-22'),
      dataFilePath: path.join(parent, '星芒数据导出-2026-11-22', WORKS_DATA_FILE_NAME),
      works: 2,
      skipped: 0,
    })
    const worksFolder = path.join(result.folderPath, WORKS_FOLDER_NAME)
    expect(fs.readFileSync(path.join(worksFolder, '2026-11-20', `xingmang-${image.id}.png`))).toEqual(fs.readFileSync(image.filePath))
    expect(fs.readFileSync(path.join(worksFolder, '2026-11-21', `xingmang-${clip.id}.mp4`))).toEqual(fs.readFileSync(clip.filePath))
    expect(JSON.parse(fs.readFileSync(result.dataFilePath, 'utf8'))).toEqual({ works: summarizeAccountWorks(works) })
    const manifest = parseWorksManifest(fs.readFileSync(path.join(worksFolder, WORKS_MANIFEST_FILE), 'utf8'))
    expect(manifest.files.map((file) => file.assetId).sort()).toEqual([image.id, clip.id].sort())
    expect(manifest.metadata).toEqual([{ assetId: image.id, displayName: '海报', updatedAt: '2026-11-20T00:00:00.000Z' }])
  })

  it('never reuses a folder that is already there', async () => {
    const parent = temporaryRoot('export-taken')
    fs.mkdirSync(path.join(parent, '星芒数据导出-2026-11-22'))
    fs.writeFileSync(path.join(parent, '星芒数据导出-2026-11-22', 'mine.txt'), 'keep')
    const result = await writeWorksExport(exportOptions(parent))
    expect(result.folderPath).toBe(path.join(parent, '星芒数据导出-2026-11-22 (2)'))
    expect(fs.readdirSync(path.join(parent, '星芒数据导出-2026-11-22'))).toEqual(['mine.txt'])
  })

  it('stops before writing anything when the chosen place is too small', async () => {
    const outputRoot = temporaryRoot('export-space-source')
    const parent = temporaryRoot('export-space-target')
    writeWork(outputRoot, '2026-11-20', 'big', 'png', 'x'.repeat(1024))
    const works = await listAccountWorks(outputRoot, userId)
    await expect(writeWorksExport(exportOptions(parent, { works, readDiskSpace: space(1024) })))
      .rejects.toThrow(worksExportNoSpaceMessage(works[0].bytes, 1024))
    expect(fs.readdirSync(parent)).toEqual([])
  })

  it('removes every file it wrote when the export cannot be finished', async () => {
    const outputRoot = temporaryRoot('export-fail-source')
    const parent = temporaryRoot('export-fail-target')
    fs.writeFileSync(path.join(parent, 'already-here.txt'), 'keep')
    writeWork(outputRoot, '2026-11-20', 'one', 'png')
    writeWork(outputRoot, '2026-11-21', 'two', 'mp3')
    const works = await listAccountWorks(outputRoot, userId)
    let calls = 0
    const failing = exportOptions(parent, {
      works,
      dataContent: () => {
        calls += 1
        if (calls > 1) throw new Error('disk went away')
        return '{}'
      },
    })
    await expect(writeWorksExport(failing)).rejects.toThrow(worksExportIncompleteMessage)
    expect(fs.readdirSync(parent)).toEqual(['already-here.txt'])
    for (const work of works) expect(fs.existsSync(work.filePath)).toBe(true)
  })

  it('leaves out a work that disappeared after it was counted', async () => {
    const outputRoot = temporaryRoot('export-gone-source')
    const parent = temporaryRoot('export-gone-target')
    const kept = writeWork(outputRoot, '2026-11-20', 'kept', 'png')
    const gone = writeWork(outputRoot, '2026-11-20', 'gone', 'png')
    const works = await listAccountWorks(outputRoot, userId)
    fs.rmSync(gone.filePath)
    const result = await writeWorksExport(exportOptions(parent, { works }))
    expect(result).toMatchObject({ works: 1, skipped: 1 })
    expect(JSON.parse(fs.readFileSync(result.dataFilePath, 'utf8'))).toMatchObject({ works: { images: 1 } })
    expect(fs.readdirSync(path.join(result.folderPath, WORKS_FOLDER_NAME, '2026-11-20'))).toEqual([`xingmang-${kept.id}.png`])
  })
})

describe('buildWorksManifest', () => {
  it('carries the names of the exported works only and nothing from the recycle bin', () => {
    const id = idFor('manifest')
    const trashed = idFor('manifest-trashed')
    const manifest = JSON.parse(buildWorksManifest(
      [
        { assetId: id, mediaType: 'image', relativePath: `2026-11-20/xingmang-${id}.png`, bytes: 10 },
        { assetId: trashed, mediaType: 'image', relativePath: `2026-11-20/xingmang-${trashed}.png`, bytes: 10 },
      ],
      [
        { assetId: id, displayName: '海报', updatedAt: '2026-11-20T00:00:00.000Z' },
        { assetId: trashed, displayName: '删了', deletedAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z' },
      ],
    ))
    expect(manifest.metadata).toEqual([{ assetId: id, displayName: '海报', updatedAt: '2026-11-20T00:00:00.000Z' }])
  })
})

describe('parseWorksManifest', () => {
  const id = idFor('parse')
  function manifest(files: unknown, metadata: unknown = []): string {
    return JSON.stringify({ format: 'xingmang-works', version: 1, files, metadata })
  }

  it('reads a manifest the export wrote', () => {
    expect(parseWorksManifest(manifest([{ path: `2026-11-20/xingmang-${id}.mp4`, bytes: 42 }], [
      { assetId: id, displayName: '片段', updatedAt: '2026-11-20T00:00:00.000Z' },
      { assetId: idFor('unlisted'), displayName: '不在清单里', updatedAt: '2026-11-20T00:00:00.000Z' },
    ]))).toEqual({
      files: [{ assetId: id, mediaType: 'video', relativePath: `2026-11-20/xingmang-${id}.mp4`, bytes: 42, date: '2026-11-20', fileName: `xingmang-${id}.mp4` }],
      metadata: [{ assetId: id, displayName: '片段', updatedAt: '2026-11-20T00:00:00.000Z' }],
    })
  })

  it.each([
    ['a path that climbs out', [{ path: `../xingmang-${id}.png`, bytes: 1 }]],
    ['a nested path', [{ path: `2026-11-20/sub/xingmang-${id}.png`, bytes: 1 }]],
    ['a Windows separator', [{ path: `2026-11-20\\xingmang-${id}.png`, bytes: 1 }]],
    ['a name the stores never write', [{ path: '2026-11-20/evil.exe', bytes: 1 }]],
    ['an extension the stores never write', [{ path: `2026-11-20/xingmang-${id}.exe`, bytes: 1 }]],
    ['the same work twice', [{ path: `2026-11-20/xingmang-${id}.png`, bytes: 1 }, { path: `2026-11-21/xingmang-${id}.png`, bytes: 1 }]],
    ['an empty file', [{ path: `2026-11-20/xingmang-${id}.png`, bytes: 0 }]],
    ['a size over the ceiling', [{ path: `2026-11-20/xingmang-${id}.png`, bytes: 1024 ** 4 }]],
    ['a fractional size', [{ path: `2026-11-20/xingmang-${id}.png`, bytes: 1.5 }]],
    ['too many files', Array.from({ length: MAX_TRANSFERRED_WORKS + 1 }, () => ({}))],
  ])('refuses %s', (_name, files) => {
    expect(() => parseWorksManifest(manifest(files))).toThrow('AI 作品清单无效')
  })

  it('refuses another format, a broken file and a metadata record the store would not accept', () => {
    expect(() => parseWorksManifest('{')).toThrow('AI 作品清单无效')
    expect(() => parseWorksManifest(JSON.stringify({ format: 'other', version: 1, files: [] }))).toThrow('AI 作品清单无效')
    expect(() => parseWorksManifest(manifest([], [{ assetId: id, displayName: 5 }]))).toThrow('AI 作品清单无效')
  })
})

describe('inspectWorksFolder', () => {
  it('looks only at the works folder beside the chosen file', async () => {
    const folder = temporaryRoot('inspect')
    const dataFile = path.join(folder, WORKS_DATA_FILE_NAME)
    await expect(inspectWorksFolder(dataFile)).resolves.toEqual({ state: 'missing' })
    fs.mkdirSync(path.join(folder, WORKS_FOLDER_NAME))
    await expect(inspectWorksFolder(dataFile)).resolves.toEqual({ state: 'unreadable' })
    fs.writeFileSync(path.join(folder, WORKS_FOLDER_NAME, WORKS_MANIFEST_FILE), 'not json')
    await expect(inspectWorksFolder(dataFile)).resolves.toEqual({ state: 'unreadable' })
    fs.writeFileSync(path.join(folder, WORKS_FOLDER_NAME, WORKS_MANIFEST_FILE), `﻿${JSON.stringify({ format: 'xingmang-works', version: 1, files: [], metadata: [] })}`)
    await expect(inspectWorksFolder(dataFile)).resolves.toEqual({ state: 'ready', folder: path.join(folder, WORKS_FOLDER_NAME), manifest: { files: [], metadata: [] } })
  })
})

describe('importAccountWorks', () => {
  async function exported(seeds: Array<[string, string, string]>, metadata: Parameters<typeof buildWorksManifest>[1] = []) {
    const source = temporaryRoot('import-source')
    const parent = temporaryRoot('import-folder')
    for (const [date, seed, extension] of seeds) writeWork(source, date, seed, extension)
    const result = await writeWorksExport(exportOptions(parent, { works: await listAccountWorks(source, userId), metadata }))
    const inspection = await inspectWorksFolder(result.dataFilePath)
    if (inspection.state !== 'ready') throw new Error('export folder unreadable')
    return inspection
  }

  function metadataStore(outputRoot: string): AiAssetMetadataStore {
    return new AiAssetMetadataStore({ outputRoot, now: () => new Date('2026-11-22T00:00:00.000Z'), randomUUID: () => 'backup-id' })
  }

  it('puts every work back at the same place under the same name, and a second import adds nothing', async () => {
    const { folder, manifest } = await exported([['2026-11-20', 'image', 'png'], ['2026-11-21', 'clip', 'mp4']])
    const outputRoot = temporaryRoot('import-target')
    const metadata = metadataStore(outputRoot)
    const options = { folder, manifest, outputRoot, userId, metadata, readDiskSpace: plenty }
    await expect(importAccountWorks(options)).resolves.toEqual({ status: 'done', added: 2, existing: 0, failed: 0 })
    for (const entry of manifest.files) {
      expect(fs.readFileSync(path.join(outputRoot, `user-${userId}`, entry.date, entry.fileName))).toEqual(fs.readFileSync(path.join(folder, entry.date, entry.fileName)))
    }
    await expect(importAccountWorks(options)).resolves.toEqual({ status: 'done', added: 0, existing: 2, failed: 0 })
    for (const date of ['2026-11-20', '2026-11-21']) {
      expect(fs.readdirSync(path.join(outputRoot, `user-${userId}`, date)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    }
  })

  it('never replaces a work this computer already has, under any date, nor its name and tags', async () => {
    const image = idFor('image')
    const { folder, manifest } = await exported([['2026-11-20', 'image', 'png']], [{ assetId: image, displayName: '另一台电脑的名字', updatedAt: '2026-11-20T00:00:00.000Z' }])
    const outputRoot = temporaryRoot('import-existing')
    const local = writeWork(outputRoot, '2026-10-01', 'image', 'png', 'local bytes')
    const metadata = metadataStore(outputRoot)
    await metadata.rename(userId, image, '本机的名字')
    await expect(importAccountWorks({ folder, manifest, outputRoot, userId, metadata, readDiskSpace: plenty }))
      .resolves.toEqual({ status: 'done', added: 0, existing: 1, failed: 0 })
    expect(fs.readFileSync(local.filePath)).toEqual(mediaBytes('png', 'local bytes'))
    expect(fs.existsSync(path.join(outputRoot, `user-${userId}`, '2026-11-20'))).toBe(false)
    expect((await metadata.getMany(userId, [image]))[image]).toMatchObject({ displayName: '本机的名字' })
  })

  it('brings the names and tags of works it added', async () => {
    const image = idFor('named')
    const { folder, manifest } = await exported([['2026-11-20', 'named', 'png']], [{ assetId: image, displayName: '海报', tags: ['产品'], updatedAt: '2026-11-20T00:00:00.000Z' }])
    const outputRoot = temporaryRoot('import-named')
    const metadata = metadataStore(outputRoot)
    await importAccountWorks({ folder, manifest, outputRoot, userId, metadata, readDiskSpace: plenty })
    expect((await metadata.getMany(userId, [image]))[image]).toMatchObject({ displayName: '海报', tags: ['产品'] })
  })

  it('refuses a file that does not start like its kind or is not the size the manifest says', async () => {
    const { folder, manifest } = await exported([['2026-11-20', 'fake', 'png'], ['2026-11-20', 'resized', 'mp3'], ['2026-11-20', 'fine', 'jpg']])
    const fake = manifest.files.find((entry) => entry.assetId === idFor('fake'))!
    const resized = manifest.files.find((entry) => entry.assetId === idFor('resized'))!
    const fakePath = path.join(folder, fake.date, fake.fileName)
    fs.writeFileSync(fakePath, Buffer.alloc(fs.statSync(fakePath).size, 0x41))
    fs.appendFileSync(path.join(folder, resized.date, resized.fileName), 'longer')
    const outputRoot = temporaryRoot('import-refuse')
    await expect(importAccountWorks({ folder, manifest, outputRoot, userId, metadata: metadataStore(outputRoot), readDiskSpace: plenty }))
      .resolves.toEqual({ status: 'done', added: 1, existing: 0, failed: 2 })
    expect(fs.readdirSync(path.join(outputRoot, `user-${userId}`, '2026-11-20'))).toEqual([`xingmang-${idFor('fine')}.jpg`])
  })

  it('refuses a source file with a second hard link', async () => {
    const { folder, manifest } = await exported([['2026-11-20', 'linked', 'png']])
    const entry = manifest.files[0]
    fs.linkSync(path.join(folder, entry.date, entry.fileName), path.join(temporaryRoot('second-link'), 'other.png'))
    const outputRoot = temporaryRoot('import-linked')
    await expect(importAccountWorks({ folder, manifest, outputRoot, userId, metadata: metadataStore(outputRoot), readDiskSpace: plenty }))
      .resolves.toEqual({ status: 'done', added: 0, existing: 0, failed: 1 })
  })

  it('copies nothing when this computer does not have the room', async () => {
    const { folder, manifest } = await exported([['2026-11-20', 'image', 'png']])
    const outputRoot = temporaryRoot('import-space')
    await expect(importAccountWorks({ folder, manifest, outputRoot, userId, metadata: metadataStore(outputRoot), readDiskSpace: space(1024) }))
      .resolves.toEqual({ status: 'no-space', neededBytes: manifest.files[0].bytes, availableBytes: 1024 })
    expect(fs.existsSync(path.join(outputRoot, `user-${userId}`))).toBe(false)
  })

  it('does not check the space when every work is already here', async () => {
    const { folder, manifest } = await exported([['2026-11-20', 'image', 'png']])
    const outputRoot = temporaryRoot('import-present')
    writeWork(outputRoot, '2026-11-20', 'image', 'png')
    await expect(importAccountWorks({ folder, manifest, outputRoot, userId, metadata: metadataStore(outputRoot), readDiskSpace: space(0) }))
      .resolves.toEqual({ status: 'done', added: 0, existing: 1, failed: 0 })
  })

  it('still counts the works as imported when their names cannot be saved', async () => {
    const image = idFor('image')
    const { folder, manifest } = await exported([['2026-11-20', 'image', 'png']], [{ assetId: image, displayName: '海报', updatedAt: '2026-11-20T00:00:00.000Z' }])
    const outputRoot = temporaryRoot('import-metadata-fails')
    const metadata = { importMissing: async () => { throw new Error('shard locked') } }
    await expect(importAccountWorks({ folder, manifest, outputRoot, userId, metadata, readDiskSpace: plenty }))
      .resolves.toEqual({ status: 'done', added: 1, existing: 0, failed: 0, metadataFailed: true })
  })
})

describe('createAccountWorksTransfer', () => {
  it('leaves the recycle bin out of what it counts and exports', async () => {
    const outputRoot = temporaryRoot('transfer')
    const kept = writeWork(outputRoot, '2026-11-20', 'kept', 'png')
    const trashed = writeWork(outputRoot, '2026-11-20', 'trashed', 'png')
    const metadata = new AiAssetMetadataStore({ outputRoot, now: () => new Date('2026-11-22T00:00:00.000Z'), randomUUID: () => 'backup-id' })
    await metadata.rename(userId, trashed.id, '删了')
    await metadata.softDelete(userId, trashed.id)
    const transfer = createAccountWorksTransfer({ outputRoot, metadata, readDiskSpace: plenty })
    await expect(transfer.summarize(userId)).resolves.toEqual({ images: 1, videos: 0, audios: 0, bytes: fs.statSync(kept.filePath).size })
    const parent = temporaryRoot('transfer-target')
    const result = await transfer.exportTo(userId, { parentDirectory: parent, folderName: '导出', dataContent: () => '{}' })
    expect(result).toMatchObject({ works: 1, skipped: 0 })
    expect(fs.readdirSync(path.join(result.folderPath, WORKS_FOLDER_NAME, '2026-11-20'))).toEqual([`xingmang-${kept.id}.png`])
  })
})
