import { describe, expect, it, vi } from 'vitest'
import {
  textImageInputLimits,
  textImageInputModelSupported,
  validateTextImageInputConfiguration,
} from '../canvas-v2/src/runtime/text-image-input'
import type { AiOwnedAssetRead } from './ai-asset-store'
import {
  assertCanvasTextImageInput,
  canvasTextImageInputLimits,
  canvasTextImageInputModelSupported,
  readCanvasTextImages,
} from './canvas-text-image-input'

function pngHeader(width: number, height: number, size = 33): Buffer {
  const bytes = Buffer.alloc(size)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function owned(bytes: Buffer): AiOwnedAssetRead {
  return { asset: { assetId: 'x'.repeat(43), localUrl: 'xingmang-asset://x', mimeType: 'image/png' } as AiOwnedAssetRead['asset'], bytes }
}

function errorOf(action: () => void): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

const first = 'a'.repeat(43)
const second = 'b'.repeat(43)

describe('canvas text image input', () => {
  it('allows pictures on exactly the models the kernel offers them for, with the same limits and words', () => {
    expect(canvasTextImageInputLimits).toEqual(textImageInputLimits)
    for (const model of ['gpt-4.1', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5.5', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.5-mini', 'gpt-4o', 'gemini-3.7-flash', 'claude-opus-4-1', '']) {
      expect(canvasTextImageInputModelSupported(model), model).toBe(textImageInputModelSupported(model))
      for (const count of [-1, 0, 1, 4, 5, 1.5]) {
        expect(errorOf(() => assertCanvasTextImageInput(model, count)), `${model} ${count}`).toBe(errorOf(() => validateTextImageInputConfiguration(model, count)))
      }
    }
  })

  it('reads each picture once for the account it is given and hands back data URIs', async () => {
    const read = vi.fn(async (_userId: number, assetId: string) => owned(pngHeader(assetId === first ? 64 : 32, 48)))
    const images = await readCanvasTextImages(read, 7, [first, second, first], 'project-1')
    expect(read.mock.calls).toEqual([[7, first, 'project-1'], [7, second, 'project-1']])
    expect([...images.keys()]).toEqual([first, second])
    expect(images.get(first)).toBe(`data:image/png;base64,${pngHeader(64, 48).toString('base64')}`)
  })

  it('refuses before any request a picture that is missing, too heavy, too big or not a picture', async () => {
    async function failure(read: (userId: number, assetId: string) => Promise<AiOwnedAssetRead>, ids: string[] = [first]): Promise<string> {
      return readCanvasTextImages(read, 7, ids).then(() => 'resolved', (error: Error) => error.message)
    }
    expect(await failure(async () => { throw new Error('ENOENT: C:\\Users\\someone\\secret.png') })).toBe('连接的视觉图片没有可读取结果，当前没有提交文字生成')
    expect(await failure(async () => owned(pngHeader(64, 48, 4 * 1024 * 1024 + 1)))).toBe('视觉图片单张不能超过 4 MB，当前没有提交文字生成；请换小一点的图再试')
    expect(await failure(async () => owned(pngHeader(8193, 10)))).toBe('视觉图片尺寸超过范围，当前没有提交文字生成；请换小一点的图再试')
    expect(await failure(async () => owned(pngHeader(4097, 4097)))).toBe('视觉图片尺寸超过范围，当前没有提交文字生成；请换小一点的图再试')
    expect(await failure(async () => owned(Buffer.from('not a picture')))).toBe('图片内容无效，仅支持 PNG、JPEG 或 WebP')
    expect(await failure(async () => owned(pngHeader(64, 48)), [first, first, first, first, first])).toBe('文字视觉输入最多支持 4 张图片，请减少图片或改用单图输出')
  })

  it('counts a picture used in two slots twice towards the totals, as it is sent twice', async () => {
    // 3 MB each: two different pictures fit, the same one in three slots does not.
    const read = vi.fn(async () => owned(pngHeader(64, 48, 3 * 1024 * 1024)))
    await expect(readCanvasTextImages(read, 7, [first, second])).resolves.toHaveLength(2)
    await expect(readCanvasTextImages(read, 7, [first, first, first])).rejects.toThrow('文字视觉图片总容量不能超过 8 MB，当前没有提交生成请求')
    // 4096 x 4096 is 16 777 216 pixels each; three slots exceed the 33 554 432 total.
    const large = vi.fn(async () => owned(pngHeader(4096, 4096)))
    await expect(readCanvasTextImages(large, 7, [first, first])).resolves.toHaveLength(1)
    await expect(readCanvasTextImages(large, 7, [first, first, first])).rejects.toThrow('视觉图片尺寸超过范围，当前没有提交文字生成；请换小一点的图再试')
  })

  it('stops reading once the run is stopped', async () => {
    const controller = new AbortController()
    const read = vi.fn(async () => {
      controller.abort(new Error('已取消'))
      return owned(pngHeader(64, 48))
    })
    await expect(readCanvasTextImages(read, 7, [first, second], undefined, controller.signal)).rejects.toThrow('已取消')
    expect(read).toHaveBeenCalledOnce()
  })
})
