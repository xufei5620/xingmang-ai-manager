import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRemoteImageStore, sniffRemoteImageType } from './codex-remote-images'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-remote-images-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])

describe('codex-remote-images', () => {
  it('recognises the four image formats by their first bytes only', () => {
    expect(sniffRemoteImageType(png)).toBe('png')
    expect(sniffRemoteImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe('jpeg')
    expect(sniffRemoteImageType(Buffer.from('GIF89a....'))).toBe('gif')
    expect(sniffRemoteImageType(Buffer.from('GIF87a'))).toBe('gif')
    expect(sniffRemoteImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp')
    expect(sniffRemoteImageType(Buffer.from('RIFF\0\0\0\0WAVEfmt '))).toBeNull()
    expect(sniffRemoteImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffRemoteImageType(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(sniffRemoteImageType(new Uint8Array())).toBeNull()
  })

  it('saves under a random name with its own extension, and removes only what it saved', async () => {
    const root = tempRoot()
    const directory = path.join(root, 'images')
    const store = createRemoteImageStore(directory)
    const saved = await store.save(png, 'png')
    expect(path.dirname(saved)).toBe(directory)
    expect(path.basename(saved)).toMatch(/^[0-9a-f]{32}\.png$/)
    expect(fs.readFileSync(saved)).toEqual(Buffer.from(png))
    const jpeg = await store.save(new Uint8Array([0xff, 0xd8, 0xff]), 'jpeg')
    expect(jpeg.endsWith('.jpg')).toBe(true)

    const outsider = path.join(root, `${'b'.repeat(32)}.png`)
    fs.writeFileSync(outsider, 'keep')
    const lookalike = path.join(directory, 'notes.txt')
    fs.writeFileSync(lookalike, 'keep')
    await store.remove([saved, outsider, lookalike, path.join(directory, '..', path.basename(outsider))])
    expect(fs.existsSync(saved)).toBe(false)
    expect(fs.existsSync(outsider)).toBe(true)
    expect(fs.existsSync(lookalike)).toBe(true)
    await store.remove([saved])

    await store.clear()
    expect(fs.readdirSync(directory)).toEqual(['notes.txt'])
  })

  it('clears without complaint when nothing was ever saved', async () => {
    await expect(createRemoteImageStore(path.join(tempRoot(), 'missing')).clear()).resolves.toBeUndefined()
  })
})
