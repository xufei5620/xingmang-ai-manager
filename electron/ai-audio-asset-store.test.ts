import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAudioAssetStore, inspectAudio, inspectAudioMetadata } from './ai-audio-asset-store'
import { setRelocatedFolderPolicy } from './relocated-folders'

const roots: string[] = []

function mp3(): Buffer {
  return Buffer.concat([
    Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary'),
    Buffer.from('test audio fixture', 'ascii'),
  ])
}

function pcmWav(durationSeconds = 1): Buffer {
  const sampleRate = 8_000
  const blockAlign = 2
  const dataBytes = sampleRate * blockAlign * durationSeconds
  const bytes = Buffer.alloc(44 + dataBytes)
  bytes.write('RIFF', 0, 4, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 4, 'ascii')
  bytes.write('fmt ', 12, 4, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * blockAlign, 28)
  bytes.writeUInt16LE(blockAlign, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 4, 'ascii')
  bytes.writeUInt32LE(dataBytes, 40)
  return bytes
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(header.length + payload.length, 0)
  header.write(type, 4, 4, 'ascii')
  return Buffer.concat([header, payload])
}

function m4a(): Buffer {
  const movieHeader = Buffer.alloc(20)
  movieHeader.writeUInt32BE(1_000, 12)
  movieHeader.writeUInt32BE(2_500, 16)
  const mediaHeader = Buffer.from(movieHeader)
  const handler = Buffer.alloc(12)
  handler.write('soun', 8, 4, 'ascii')
  return Buffer.concat([
    box('ftyp', Buffer.from('M4A \0\0\0\0isom', 'binary')),
    box('moov', Buffer.concat([
      box('mvhd', movieHeader),
      box('trak', box('mdia', Buffer.concat([box('mdhd', mediaHeader), box('hdlr', handler)]))),
    ])),
    box('mdat', Buffer.from('audio')),
  ])
}

function audioFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-fixtures-'))
  roots.push(root)
  fs.writeFileSync(path.join(root, '音频素材.mp3'), mp3())
  fs.writeFileSync(path.join(root, '8月14日.wav'), pcmWav())
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('AiAudioAssetStore', () => {
  it('recognizes MP3 and WAV fixtures by content', () => {
    const fixtureRoot = audioFixtureRoot()
    expect(inspectAudio(fs.readFileSync(path.join(fixtureRoot, '音频素材.mp3')))).toEqual({ mimeType: 'audio/mpeg', extension: 'mp3' })
    expect(inspectAudio(fs.readFileSync(path.join(fixtureRoot, '8月14日.wav')))).toEqual({ mimeType: 'audio/wav', extension: 'wav' })
    expect(() => inspectAudio(Buffer.from('<html>not audio</html>'))).toThrow('音频内容无效')
    expect(inspectAudioMetadata(pcmWav())).toEqual({ durationSeconds: 1 })
    expect(inspectAudioMetadata(m4a())).toEqual({ durationSeconds: 2.5 })
    expect(inspectAudioMetadata(fs.readFileSync(path.join(fixtureRoot, '音频素材.mp3')))).toEqual({})
  })

  it('returns a provable WAV duration after import and restart', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-duration-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-duration-source-'))
    roots.push(outputRoot, sourceRoot)
    const sourcePath = path.join(sourceRoot, 'one-second.wav')
    fs.writeFileSync(sourcePath, pcmWav())
    const stored = await new AiAudioAssetStore({ outputRoot }).storeLocalFile(36, sourcePath)

    expect(stored.durationSeconds).toBe(1)
    await expect(new AiAudioAssetStore({ outputRoot }).readOwned(36, stored.assetId)).resolves.toMatchObject({
      asset: { durationSeconds: 1 },
    })
    await expect(new AiAudioAssetStore({ outputRoot }).listOwned(36)).resolves.toEqual([
      expect.objectContaining({ assetId: stored.assetId, durationSeconds: 1 }),
    ])
  })

  it.each([
    ['音频素材.mp3', 'audio/mpeg', '.mp3'],
    ['8月14日.wav', 'audio/wav', '.wav'],
  ])('imports %s as an owned copy and leaves the source unchanged', async (fileName, mimeType, extension) => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-assets-'))
    roots.push(outputRoot)
    const fixtureRoot = audioFixtureRoot()
    const sourcePath = path.join(fixtureRoot, fileName)
    const before = fs.readFileSync(sourcePath)
    const store = new AiAudioAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })
    const asset = await store.storeLocalFile(36, sourcePath)
    expect(asset).toMatchObject({ mimeType, localUrl: `xingmang-asset://audio/${asset.assetId}` })
    expect(asset.fileName).toMatch(new RegExp(`^xingmang-[A-Za-z0-9_-]{43}\\${extension}$`))
    const owned = await store.readOwned(36, asset.assetId)
    expect(owned.bytes).toEqual(before)
    expect(fs.readFileSync(sourcePath)).toEqual(before)
    await expect(store.readOwned(37, asset.assetId)).rejects.toThrow('不存在或无权访问')
    await expect(store.listOwned(36)).resolves.toEqual([expect.objectContaining({ assetId: asset.assetId, mediaType: 'audio' })])
  })

  it('reuses one asset and one list item for repeated local audio imports', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-dedupe-'))
    roots.push(outputRoot)
    const fixtureRoot = audioFixtureRoot()
    const sourcePath = path.join(fixtureRoot, '8月14日.wav')
    const store = new AiAudioAssetStore({ outputRoot, now: () => new Date('2026-08-14T12:00:00.000Z') })

    const first = await store.storeLocalFile(36, sourcePath)
    const second = await store.storeLocalFile(36, sourcePath)
    const assetDirectory = path.join(outputRoot, 'user-36', '2026-08-14')
    fs.copyFileSync(
      path.join(assetDirectory, first.fileName),
      path.join(assetDirectory, `xingmang-${'L'.repeat(43)}.wav`),
    )

    expect(second.assetId).toBe(first.assetId)
    await expect(store.listOwned(36)).resolves.toEqual([expect.objectContaining({ assetId: first.assetId })])
  })

  it('offers save and reveal commands for audio assets', async () => {
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-actions-'))
    roots.push(outputRoot)
    const fixtureRoot = audioFixtureRoot()
    const target = path.join(outputRoot, 'saved.wav')
    let menuItems: ReadonlyArray<{ id: string; label: string; run(): Promise<void> }> = []
    const revealInFolder = vi.fn()
    const store = new AiAudioAssetStore({ outputRoot, nativeOperations: {
      selectSavePath: async () => target, revealInFolder, showContextMenu: (items) => { menuItems = items },
    } })
    const asset = await store.storeLocalFile(36, path.join(fixtureRoot, '8月14日.wav'))
    await store.contextMenu(36, asset.assetId)
    expect(menuItems.map(({ id }) => id)).toEqual(['save-as', 'reveal-in-folder'])
    await menuItems[0].run()
    await menuItems[1].run()
    expect(fs.readFileSync(target)).toEqual(fs.readFileSync(path.join(fixtureRoot, '8月14日.wav')))
    expect(revealInFolder).toHaveBeenCalledOnce()
  })
})

/** A profile whose 文档 was moved to "another disk" and left a junction behind (「C 盘搬家」). */
function relocatedDocuments(root: string): { home: string; documents: string } {
  const home = path.join(root, 'Users', 'alice')
  const moved = path.join(root, 'D', 'Documents')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(moved, { recursive: true })
  const documents = path.join(home, 'Documents')
  // Junctions need no privilege on Windows; POSIX ignores the type argument.
  fs.symlinkSync(moved, documents, 'junction')
  return { home, documents }
}

describe('AiAudioAssetStore on a relocated documents folder', () => {
  afterEach(() => setRelocatedFolderPolicy(null))

  it('imports, reads back and removes audio after 文档 was moved to another disk', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-relocated-')))
    roots.push(root)
    const { home, documents } = relocatedDocuments(root)
    setRelocatedFolderPolicy({ homeDirectories: [home], acceptsTarget: () => true })
    const sourcePath = path.join(documents, '音频素材.mp3')
    fs.writeFileSync(sourcePath, mp3())
    const outputRoot = path.join(documents, 'XingmangAI')

    const stored = await new AiAudioAssetStore({ outputRoot }).storeLocalFile(36, sourcePath)
    const restarted = new AiAudioAssetStore({ outputRoot })

    await expect(restarted.readOwned(36, stored.assetId)).resolves.toMatchObject({ bytes: mp3() })
    await restarted.removeOwned(36, stored.assetId)
    await expect(restarted.readOwned(36, stored.assetId)).rejects.toThrow()
  })

  it('keeps refusing the relocated folder while no policy accepts it', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-relocated-')))
    roots.push(root)
    const { documents } = relocatedDocuments(root)
    const sourcePath = path.join(documents, '音频素材.mp3')
    fs.writeFileSync(sourcePath, mp3())
    const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-audio-output-'))
    roots.push(outputRoot)

    await expect(new AiAudioAssetStore({ outputRoot }).storeLocalFile(36, sourcePath)).rejects.toThrow()
  })
})
