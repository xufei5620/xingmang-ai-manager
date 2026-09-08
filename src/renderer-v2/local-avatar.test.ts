import { describe, expect, it, vi } from 'vitest'
import {
  avatarCropRectangle,
  avatarInitial,
  avatarStorageKey,
  detectAvatarMime,
  readSavedAvatar,
  validSavedAvatar,
  writeSavedAvatar,
} from './local-avatar'

function pngDataUrl(width = 256, height = 256) {
  const bytes = Buffer.alloc(28)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}
describe('local avatar storage and crop boundary', () => {
  it('isolates saved images by canonical HTTPS origin and user ID', () => {
    const first = avatarStorageKey({
      origin: 'https://xm.solov.cc/path',
      userId: 7,
    })
    expect(first).toBe(
      avatarStorageKey({ origin: 'https://xm.solov.cc', userId: 7 }),
    )
    expect(first).not.toBe(
      avatarStorageKey({ origin: 'https://xm.solov.cc', userId: 8 }),
    )
    expect(first).not.toBe(
      avatarStorageKey({ origin: 'https://other.invalid', userId: 7 }),
    )
    expect(() =>
      avatarStorageKey({ origin: 'http://xm.solov.cc', userId: 7 }),
    ).toThrow('账号信息')
    expect(() =>
      avatarStorageKey({
        origin: 'https://user:secret@xm.solov.cc',
        userId: 7,
      }),
    ).toThrow('账号信息')
  })
  it('uses the first visible Unicode character and preserves a square bounded crop', () => {
    expect(avatarInitial(' 神风呀 ')).toBe('神')
    expect(avatarInitial('')).toBe('星')
    expect(avatarInitial('alice')).toBe('A')
    expect(
      avatarCropRectangle(640, 320, { zoom: 1, horizontal: 100, vertical: 50 }),
    ).toEqual({ x: 320, y: 0, side: 320 })
    expect(
      avatarCropRectangle(640, 320, { zoom: 2, horizontal: 50, vertical: 50 }),
    ).toEqual({ x: 240, y: 80, side: 160 })
    expect(() =>
      avatarCropRectangle(0, 320, { zoom: 1, horizontal: 0, vertical: 0 }),
    ).toThrow('裁剪信息')
  })
  it('rejects non-PNG persisted URLs and images that were not re-encoded at 256 square', () => {
    expect(validSavedAvatar(pngDataUrl())).toBe(true)
    expect(validSavedAvatar(pngDataUrl(512, 256))).toBe(false)
    expect(validSavedAvatar('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(
      detectAvatarMime(
        new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      ),
    ).toBeNull()
    expect(() =>
      readSavedAvatar(
        {
          getItem: () => JSON.stringify({ version: 2, dataUrl: pngDataUrl() }),
        },
        'key',
      ),
    ).toThrow('无法读取')
  })
  it('keeps an existing avatar unchanged if saving hits the storage limit', () => {
    const storage = {
      setItem: vi.fn(() => {
        throw new Error('quota exceeded')
      }),
    }
    expect(() => writeSavedAvatar(storage, 'key', pngDataUrl())).toThrow(
      '预览已保留',
    )
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(() =>
      writeSavedAvatar(storage, 'key', 'https://remote.invalid/avatar.png'),
    ).toThrow('尚未准备好')
    expect(storage.setItem).toHaveBeenCalledOnce()
  })
})
