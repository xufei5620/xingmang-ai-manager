import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AI_IMAGE_KEPT_UNSAVED_ERROR_CODE, AiAssetStore, type AiStoredAsset } from './ai-asset-store'
import {
  AiUnsavedImageStash,
  stashedImageFileName,
  unsavedImageLogEntry,
  type AiUnsavedImageEvent,
  type AiUnsavedImageTarget,
} from './ai-unsaved-image-stash'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-unsaved-images-'))
  temporaryDirectories.push(directory)
  return directory
}

function png(width = 2, height = 3): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function diskFull(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
}

/** Makes every temporary-file write of an AiAssetStore fail the way a full disk does. */
function failTemporaryFileWrites(): void {
  const open = fs.promises.open
  vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof open>) => {
    const handle = await open(...args)
    if (String(args[0]).endsWith('.tmp')) {
      handle.writeFile = async () => {
        throw diskFull()
      }
    }
    return handle
  })
}

function libraryFiles(outputRoot: string, userId: number): string[] {
  const accountRoot = path.join(outputRoot, `user-${userId}`)
  if (!fs.existsSync(accountRoot)) return []
  return fs.readdirSync(accountRoot).flatMap((date) => fs.readdirSync(path.join(accountRoot, date))
    .filter((name) => !name.startsWith('.')))
}

function setup(options: { maximumMemoryBytes?: number; maximumDiskBytes?: number } = {}) {
  const parent = temporaryDirectory()
  const outputRoot = path.join(parent, 'output')
  const root = path.join(parent, 'data', 'ai-unsaved-images')
  const events: AiUnsavedImageEvent[] = []
  const library = new AiAssetStore({ outputRoot, now: () => new Date(2026, 10, 15, 12, 0, 0) })
  // Retries are driven by hand in the one test about them; no real timer outlives a test.
  const stash = new AiUnsavedImageStash({ root, target: library, log: (event) => events.push(event), scheduleRetry: () => undefined, ...options })
  return { parent, outputRoot, root, events, library, stash }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('AiUnsavedImageStash', () => {
  it('keeps a paid image on disk and stores it into the library once space is back', async () => {
    const { outputRoot, root, events, stash } = setup()
    const bytes = png(640, 480)

    await expect(stash.keep(42, bytes)).resolves.toBe('disk')
    const stashed = path.join(root, 'user-42', stashedImageFileName(bytes))
    expect(fs.readFileSync(stashed)).toEqual(bytes)
    expect(libraryFiles(outputRoot, 42)).toEqual([])

    await expect(stash.flush(42)).resolves.toBe(1)
    const stored = libraryFiles(outputRoot, 42)
    expect(stored).toHaveLength(1)
    expect(fs.readFileSync(path.join(outputRoot, 'user-42', '2026-11-15', stored[0]))).toEqual(bytes)
    // Removed only after the library holds it; nothing is left to store twice.
    expect(fs.existsSync(stashed)).toBe(false)
    await expect(stash.flush(42)).resolves.toBe(0)
    expect(events.map((event) => event.kind)).toEqual(['kept', 'restored'])
  })

  it('holds the same picture once however often it is kept', async () => {
    const { root, stash } = setup()

    await stash.keep(42, png())
    await stash.keep(42, png())

    expect(fs.readdirSync(path.join(root, 'user-42'))).toEqual([stashedImageFileName(png())])
  })

  it('stores a picture once even when the stashed copy could not be removed last time', async () => {
    const { outputRoot, root, stash } = setup()
    await stash.keep(42, png())
    const stashed = path.join(root, 'user-42', stashedImageFileName(png()))
    const kept = fs.readFileSync(stashed)

    await stash.flush(42)
    // As if the program quit between storing and removing: the same file is back.
    fs.writeFileSync(stashed, kept)
    await expect(stash.flush(42)).resolves.toBe(1)

    expect(libraryFiles(outputRoot, 42)).toHaveLength(1)
    expect(fs.existsSync(stashed)).toBe(false)
  })

  it('keeps the picture in memory when its own folder cannot be written either', async () => {
    const { parent, outputRoot, events, library } = setup()
    const blocked = path.join(parent, 'blocked')
    fs.writeFileSync(blocked, 'a file where the folder should be')
    const stash = new AiUnsavedImageStash({
      root: path.join(blocked, 'ai-unsaved-images'), target: library, log: (event) => events.push(event), scheduleRetry: () => undefined,
    })

    await expect(stash.keep(42, png())).resolves.toBe('memory')
    expect(events[0]).toMatchObject({ kind: 'kept', place: 'memory', userId: 42 })
    expect(events[0]).toHaveProperty('diskError')

    await expect(stash.flush(42)).resolves.toBe(1)
    expect(libraryFiles(outputRoot, 42)).toHaveLength(1)
    await expect(stash.flush(42)).resolves.toBe(0)
  })

  it('lets a picture go rather than outgrow the memory and disk limits', async () => {
    const { parent, events, library } = setup()
    const blocked = path.join(parent, 'blocked')
    fs.writeFileSync(blocked, 'a file where the folder should be')
    const stash = new AiUnsavedImageStash({
      root: path.join(blocked, 'ai-unsaved-images'), target: library, log: (event) => events.push(event), maximumMemoryBytes: 30,
      scheduleRetry: () => undefined,
    })

    await expect(stash.keep(42, png(1, 1))).resolves.toBe('memory')
    await expect(stash.keep(42, png(2, 2))).resolves.toBeNull()
    expect(events.map((event) => event.kind)).toEqual(['kept', 'dropped'])

    const small = setup({ maximumDiskBytes: 30, maximumMemoryBytes: 0 })
    await expect(small.stash.keep(42, png(1, 1))).resolves.toBe('disk')
    await expect(small.stash.keep(42, png(2, 2))).resolves.toBeNull()
  })

  it('stops a round on a full disk and stores everything on the next one', async () => {
    const { outputRoot, events, stash } = setup()
    await stash.keep(42, png(1, 1))
    await stash.keep(42, png(2, 2))

    failTemporaryFileWrites()
    await expect(stash.flush(42)).resolves.toBe(0)
    // One failure, not one per picture: the second would have failed the same way.
    expect(events.filter((event) => event.kind === 'restore-failed')).toHaveLength(1)

    vi.restoreAllMocks()
    await expect(stash.flush(42)).resolves.toBe(2)
    expect(libraryFiles(outputRoot, 42)).toHaveLength(2)
  })

  it('stores pictures only into the account they were paid by', async () => {
    const { outputRoot, stash } = setup()
    await stash.keep(42, png(1, 1))
    await stash.keep(7, png(2, 2))

    await expect(stash.flush(7)).resolves.toBe(1)

    expect(libraryFiles(outputRoot, 7)).toHaveLength(1)
    expect(libraryFiles(outputRoot, 42)).toEqual([])
  })

  it('never brings a second name for an outside file into the library', async () => {
    const { parent, outputRoot, root, stash } = setup()
    await stash.keep(42, png(1, 1))
    const outside = path.join(parent, 'outside.png')
    fs.writeFileSync(outside, png(9, 9))
    // A hard link planted in the stash folder is refused by the library's
    // single-link check and left where it is; the real picture still goes in.
    const hardLinked = path.join(root, 'user-42', `${'b'.repeat(64)}.png`)
    fs.linkSync(outside, hardLinked)

    await expect(stash.flush(42)).resolves.toBe(1)

    const stored = libraryFiles(outputRoot, 42)
    expect(stored).toHaveLength(1)
    expect(fs.readFileSync(path.join(outputRoot, 'user-42', '2026-11-15', stored[0]))).toEqual(png(1, 1))
    expect(fs.existsSync(hardLinked)).toBe(true)
    expect(fs.readFileSync(outside)).toEqual(png(9, 9))
  })

  it.runIf(process.platform !== 'win32')('never follows a symbolic link planted in the stash folder', async () => {
    const { parent, outputRoot, root, stash } = setup()
    await stash.keep(42, png(1, 1))
    const outside = path.join(parent, 'outside.png')
    fs.writeFileSync(outside, png(9, 9))
    fs.symlinkSync(outside, path.join(root, 'user-42', `${'a'.repeat(64)}.png`))

    await expect(stash.flush(42)).resolves.toBe(1)

    const stored = libraryFiles(outputRoot, 42)
    expect(stored).toHaveLength(1)
    expect(fs.readFileSync(path.join(outputRoot, 'user-42', '2026-11-15', stored[0]))).toEqual(png(1, 1))
  })

  it('tries again by itself while the program stays open, less often each time', async () => {
    let failing = true
    const stored: Buffer[] = []
    const scheduled: Array<{ run: () => Promise<void>; delayMs: number }> = []
    const target: AiUnsavedImageTarget = {
      storeLocalFile: async (_userId, filePath) => {
        if (failing) throw diskFull()
        stored.push(fs.readFileSync(filePath))
        return { assetId: 'a'.repeat(43) } as AiStoredAsset
      },
      storeLocalBytes: async () => { throw new Error('not used') },
    }
    const stash = new AiUnsavedImageStash({
      root: path.join(temporaryDirectory(), 'stash'),
      target,
      retryDelaysMs: [1_000, 5_000],
      scheduleRetry: (run, delayMs) => { scheduled.push({ run, delayMs }) },
    })

    await stash.keep(42, png())
    await stash.keep(42, png(4, 4))
    // One pending retry at a time, however many pictures were kept.
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([1_000])

    await scheduled.shift()?.run()
    expect(stored).toHaveLength(0)
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([5_000])

    failing = false
    await scheduled.shift()?.run()
    expect(stored).toHaveLength(2)
    // Everything is stored: no further retry, and the next keep starts from the shortest wait.
    expect(scheduled).toEqual([])
    await stash.keep(42, png(5, 5))
    expect(scheduled.map((entry) => entry.delayMs)).toEqual([1_000])
  })

  it('keeps trying after a sign-in that found the disk still full', async () => {
    const parent = temporaryDirectory()
    const root = path.join(parent, 'stash')
    const scheduled: number[] = []
    const library = new AiAssetStore({ outputRoot: path.join(parent, 'output') })
    // Left over from an earlier run of the program.
    await new AiUnsavedImageStash({ root, target: library, scheduleRetry: () => undefined }).keep(42, png())
    const stash = new AiUnsavedImageStash({ root, target: library, scheduleRetry: (_run, delayMs) => { scheduled.push(delayMs) } })

    failTemporaryFileWrites()
    await expect(stash.flush(42)).resolves.toBe(0)
    expect(scheduled).toEqual([60_000])

    vi.restoreAllMocks()
    const quiet: number[] = []
    const settled = new AiUnsavedImageStash({ root, target: library, scheduleRetry: (_run, delayMs) => { quiet.push(delayMs) } })
    await expect(settled.flush(42)).resolves.toBe(1)
    expect(quiet).toEqual([])
  })

  it('never throws while the store is already failing', async () => {
    const { stash } = setup()

    await expect(stash.keep(0, png())).resolves.toBeNull()
    await expect(stash.keep(42, Buffer.from('not a picture'))).resolves.toBeNull()
    await expect(stash.flush(-1)).resolves.toBe(0)
  })

  it('describes each step for the run log without the picture or its path', () => {
    const kept = unsavedImageLogEntry({ kind: 'kept', userId: 42, place: 'disk', bytes: 24 })
    expect(kept).toEqual({
      level: 'warn',
      event: 'asset.unsaved.kept',
      message: '付过费的图存不进作品库，已先暂存，腾出空间后自动补存',
      detail: { userId: 42, place: 'disk', bytes: 24 },
    })
    expect(unsavedImageLogEntry({ kind: 'restored', userId: 42, place: 'memory', assetId: 'x' })).toMatchObject({
      level: 'info', event: 'asset.unsaved.restored',
    })
    expect(unsavedImageLogEntry({ kind: 'dropped', userId: 42, bytes: 24 }).event).toBe('asset.unsaved.dropped')
    expect(unsavedImageLogEntry({ kind: 'restore-failed', userId: 42, place: 'disk', error: diskFull() }).level).toBe('warn')
  })
})

describe('AiAssetStore with an unsaved-image stash', () => {
  function storeWithStash() {
    const outputRoot = path.join(temporaryDirectory(), 'output')
    const keepUnsaved = vi.fn(async () => true)
    const store = new AiAssetStore({ outputRoot, keepUnsaved, now: () => new Date(2026, 10, 15, 12, 0, 0) })
    return { store, keepUnsaved }
  }

  it('hands the bytes of a paid image to the stash when they cannot be written', async () => {
    const { store, keepUnsaved } = storeWithStash()

    failTemporaryFileWrites()
    const error = await store.storeBase64(42, png(640, 480).toString('base64')).then(() => null, (reason: unknown) => reason)

    expect(keepUnsaved).toHaveBeenCalledWith(42, png(640, 480))
    // Marked as set aside, so the image service can say so instead of "try again".
    expect(error).toMatchObject({ message: '作品没能存进保存位置，请稍后重试；一直不行请联系客服', code: AI_IMAGE_KEPT_UNSAVED_ERROR_CODE })
    expect((error as Error).cause).toMatchObject({ code: 'ENOSPC' })
  })

  it('does not claim the image was set aside when the stash could not take it', async () => {
    const outputRoot = path.join(temporaryDirectory(), 'output')
    const store = new AiAssetStore({ outputRoot, keepUnsaved: async () => false })

    failTemporaryFileWrites()
    const error = await store.storeBase64(42, png().toString('base64')).then(() => null, (reason: unknown) => reason)

    expect((error as { code?: unknown }).code).not.toBe(AI_IMAGE_KEPT_UNSAVED_ERROR_CODE)
  })

  it('keeps the same error when the stash itself fails', async () => {
    const outputRoot = path.join(temporaryDirectory(), 'output')
    const store = new AiAssetStore({ outputRoot, keepUnsaved: async () => { throw new Error('stash broke') } })

    failTemporaryFileWrites()
    const error = await store.storeBase64(42, png().toString('base64')).then(() => null, (reason: unknown) => reason)
    expect((error as Error).message).toBe('作品没能存进保存位置，请稍后重试；一直不行请联系客服')
    expect((error as { code?: unknown }).code).not.toBe(AI_IMAGE_KEPT_UNSAVED_ERROR_CODE)
  })

  it('does not stash bytes that failed validation or that the person imported', async () => {
    const { store, keepUnsaved } = storeWithStash()

    await expect(store.storeBase64(42, Buffer.from('not a picture').toString('base64'))).rejects.toThrow()
    failTemporaryFileWrites()
    await expect(store.storeLocalBytes(42, png())).rejects.toThrow('作品没能存进保存位置')

    expect(keepUnsaved).not.toHaveBeenCalled()
  })
})
