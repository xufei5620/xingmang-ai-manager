import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnedAssetLocator } from './ai-asset-locator'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  // realpath so a symlinked temp directory (macOS /var -> /private/var) does
  // not trip the reparse check on the account folder.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-asset-locator-')))
  roots.push(root)
  return root
}

function assetId(seed: string): string {
  return seed.padEnd(43, 'z').slice(0, 43)
}

function writeAsset(root: string, userId: number, date: string, id: string, extension: string): string {
  const directory = path.join(root, `user-${userId}`, date)
  fs.mkdirSync(directory, { recursive: true })
  const filePath = path.join(directory, `xingmang-${id}.${extension}`)
  fs.writeFileSync(filePath, 'x')
  return filePath
}

function dateDirectory(index: number): string {
  return new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10)
}

function locator(root: string): OwnedAssetLocator {
  return new OwnedAssetLocator({ outputRoot: root, extensions: ['png', 'jpg', 'webp'], label: 'AI 图片资产' })
}

describe('OwnedAssetLocator', () => {
  it('finds an asset in any date folder and prefers the newest copy', async () => {
    const root = temporaryRoot()
    writeAsset(root, 7, '2026-08-10', assetId('dup'), 'png')
    const newest = writeAsset(root, 7, '2026-08-15', assetId('dup'), 'png')
    const webp = writeAsset(root, 7, '2026-08-12', assetId('web'), 'webp')

    await expect(locator(root).locate(7, assetId('dup'))).resolves.toBe(newest)
    await expect(locator(root).locate(7, assetId('web'))).resolves.toBe(webp)
    await expect(locator(root).locate(7, assetId('nope'))).resolves.toBeNull()
    await expect(locator(root).locate(8, assetId('dup'))).resolves.toBeNull()
  })

  it('keeps the synchronous reparse walk to the account folder however many date folders there are', async () => {
    const root = temporaryRoot()
    for (let day = 0; day < 60; day += 1) writeAsset(root, 7, dateDirectory(day), assetId(`d${day}`), 'png')
    const oneFolder = temporaryRoot()
    writeAsset(oneFolder, 7, dateDirectory(0), assetId('d0'), 'png')

    const lstatSync = vi.spyOn(fs, 'lstatSync')
    await expect(locator(oneFolder).locate(7, assetId('missing'))).resolves.toBeNull()
    const baseline = lstatSync.mock.calls.length
    lstatSync.mockClear()
    // A miss walks every folder and extension: 180 candidates. Each used to
    // cost a full synchronous walk of its path; now each costs one async lstat.
    await expect(locator(root).locate(7, assetId('missing'))).resolves.toBeNull()
    // The same synchronous cost as an account with a single date folder.
    expect(lstatSync.mock.calls.length).toBe(baseline)
  })

  it('answers from a remembered location without listing the account again', async () => {
    const root = temporaryRoot()
    const filePath = writeAsset(root, 7, '2026-08-14', assetId('kept'), 'jpg')
    const subject = locator(root)
    subject.remember(7, assetId('kept'), filePath)

    const readdir = vi.spyOn(fs.promises, 'readdir')
    await expect(subject.locate(7, assetId('kept'))).resolves.toBe(filePath)
    expect(readdir).not.toHaveBeenCalled()
  })

  it('looks again once a remembered file was removed outside the app', async () => {
    const root = temporaryRoot()
    const remembered = writeAsset(root, 7, '2026-08-15', assetId('moved'), 'png')
    const subject = locator(root)
    subject.remember(7, assetId('moved'), remembered)
    fs.rmSync(remembered)

    await expect(subject.locate(7, assetId('moved'))).resolves.toBeNull()
    const restored = writeAsset(root, 7, '2026-08-01', assetId('moved'), 'png')
    await expect(subject.locate(7, assetId('moved'))).resolves.toBe(restored)
  })

  it('never answers one account with a location remembered for another', async () => {
    const root = temporaryRoot()
    const other = writeAsset(root, 8, '2026-08-14', assetId('mine'), 'png')
    const subject = locator(root)
    subject.remember(8, assetId('mine'), other)

    await expect(subject.locate(7, assetId('mine'))).resolves.toBeNull()
    await expect(subject.locate(8, assetId('mine'))).resolves.toBe(other)
  })

  it('refuses to remember a location outside the account folder', async () => {
    const root = temporaryRoot()
    const outside = path.join(root, 'elsewhere', `xingmang-${assetId('out')}.png`)
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, 'x')
    const subject = locator(root)
    subject.remember(7, assetId('out'), outside)
    subject.remember(7, assetId('out'), path.join(root, 'user-8', '2026-08-14', `xingmang-${assetId('out')}.png`))

    await expect(subject.locate(7, assetId('out'))).resolves.toBeNull()
  })

  it.runIf(process.platform !== 'win32')('still refuses to search through a linked account folder', async () => {
    const root = temporaryRoot()
    const elsewhere = temporaryRoot()
    writeAsset(elsewhere, 7, '2026-08-14', assetId('link'), 'png')
    fs.symlinkSync(path.join(elsewhere, 'user-7'), path.join(root, 'user-7'))

    await expect(locator(root).locate(7, assetId('link'))).resolves.toBeNull()
  })
})
