import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiAudioAssetStore, inspectAudio, inspectAudioMetadata } from './ai-audio-asset-store'

const roots: string[] = []
const fixtureRoot = path.join(process.cwd(), 'output', 'user-36', '2026-08-14')

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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('AiAudioAssetStore', () => {
  it('recognizes the real MP3 and WAV fixtures by content', () => {
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
    const sourcePath = path.join(fixtureRoot, fileName)
    const before = fs.readFileSync(sourcePath)
    const store = new AiAudioAssetStore({ outputRoot, now: () => new Date('2026-08-14T00:00:00.000Z') })
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
    const sourcePath = path.join(fixtureRoot, '8月14日.wav')
    const store = new AiAudioAssetStore({ outputRoot, now: () => new Date('2026-08-14T00:00:00.000Z') })

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
