import { describe, expect, it, vi } from 'vitest'
import {
  announcementImageMaxBytes,
  createAnnouncementImageReader,
  inspectAnnouncementImage,
  resolveAnnouncementImageUrl,
} from './announcement-image'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

function jpeg(width: number, height: number): Buffer {
  // SOI, then a baseline SOF0 segment (length 17: precision, height, width, 3 components), then EOI.
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
  ])
}

function webp(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUInt32LE(10, 16)
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

function pngSized(width: number, height: number): Buffer {
  const copy = Buffer.from(png)
  copy.writeUInt32BE(width, 16)
  copy.writeUInt32BE(height, 20)
  return copy
}

function imageResponse(bytes: Buffer, init: ResponseInit = {}): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/png' }, ...init })
}

function heldFetch() {
  const pending: Array<{ url: string; resolve: (response: Response) => void }> = []
  const fetchImpl = vi.fn<typeof fetch>((input) => new Promise<Response>((resolve) => {
    pending.push({ url: String(input), resolve })
  }))
  return { fetchImpl, pending }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('announcement image url', () => {
  it('accepts only https images on the signed-in account official site', () => {
    expect(resolveAnnouncementImageUrl('solov', 'https://xm.solov.cc/uploads/qr.png#top').href).toBe('https://xm.solov.cc/uploads/qr.png')
    expect(resolveAnnouncementImageUrl('solov-api', 'https://api.solov.cc/qr.png').href).toBe('https://api.solov.cc/qr.png')
    for (const value of [
      'https://api.solov.cc/qr.png',
      'https://xm.solov.cc.evil.example/qr.png',
      'https://cdn.example.test/qr.png',
      'http://xm.solov.cc/qr.png',
      'https://user:pass@xm.solov.cc/qr.png',
      'https://xm.solov.cc:8443/qr.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(() => resolveAnnouncementImageUrl('solov', value), value).toThrow('公告图片不在当前账号的官网上，不下载')
    }
    for (const value of [undefined, null, 42, '', '   ', 'not a url', `https://xm.solov.cc/${'a'.repeat(2_048)}`]) {
      expect(() => resolveAnnouncementImageUrl('solov', value), String(value)).toThrow('公告图片地址无效')
    }
  })
})

describe('announcement image inspection', () => {
  it('recognises the four raster formats by their bytes, whatever the server claims', () => {
    expect(inspectAnnouncementImage(png)).toEqual({ mimeType: 'image/png', width: 1, height: 1 })
    expect(inspectAnnouncementImage(gif)).toEqual({ mimeType: 'image/gif', width: 1, height: 1 })
    expect(inspectAnnouncementImage(jpeg(640, 480))).toEqual({ mimeType: 'image/jpeg', width: 640, height: 480 })
    expect(inspectAnnouncementImage(webp(1080, 4000))).toEqual({ mimeType: 'image/webp', width: 1080, height: 4000 })
  })

  it('rejects svg, web pages, empty bytes and images too large to decode safely', () => {
    expect(inspectAnnouncementImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull()
    expect(inspectAnnouncementImage(Buffer.from('<!doctype html><html></html>'))).toBeNull()
    expect(inspectAnnouncementImage(Buffer.alloc(0))).toBeNull()
    expect(inspectAnnouncementImage(pngSized(10_000, 10))).toBeNull()
    expect(inspectAnnouncementImage(pngSized(5_000, 5_000))).toBeNull()
    expect(inspectAnnouncementImage(pngSized(0, 10))).toBeNull()
    expect(inspectAnnouncementImage(jpeg(9_000, 100))).toBeNull()
  })

  it('keeps the largest image within the renderer data URL cap', () => {
    // safeAnnouncementImage in the renderer accepts data: images up to 2,000,000 characters.
    expect('data:image/jpeg;base64,'.length + Math.ceil(announcementImageMaxBytes / 3) * 4).toBeLessThan(2_000_000)
  })
})

describe('announcement image reader', () => {
  it('downloads an official image without credentials or redirects and hands back a data URL', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(png, { headers: { 'content-type': 'application/octet-stream' } }))
    const reader = createAnnouncementImageReader({ fetch: fetchImpl })

    await expect(reader.read('solov', 'https://xm.solov.cc/qr.png')).resolves.toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(fetchImpl).toHaveBeenCalledOnce()
    const [input, init] = fetchImpl.mock.calls[0]
    expect(input).toBe('https://xm.solov.cc/qr.png')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|cookie/i)
  })

  it('never fetches an address outside the official site', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const reader = createAnnouncementImageReader({ fetch: fetchImpl })

    await expect(reader.read('solov', 'https://attacker.example/qr.png')).rejects.toThrow('公告图片不在当前账号的官网上，不下载')
    await expect(reader.read('solov-api', 'https://xm.solov.cc/qr.png')).rejects.toThrow('公告图片不在当前账号的官网上，不下载')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects redirects of every shape', async () => {
    const opaque = new Response(null, { status: 200 })
    Object.defineProperties(opaque, { type: { value: 'opaqueredirect' }, status: { value: 0 } })
    const moved = new Response(null, { status: 302, headers: { location: 'https://attacker.example/qr.png' } })
    const followed = imageResponse(png)
    Object.defineProperty(followed, 'url', { value: 'https://attacker.example/qr.png' })
    for (const [response, message] of [
      [opaque, '公告图片地址被重定向，已拒绝'],
      [moved, '公告图片地址被重定向，已拒绝'],
      [followed, '公告图片被重定向到不受信任的地址，已拒绝'],
    ] as const) {
      const reader = createAnnouncementImageReader({ fetch: vi.fn<typeof fetch>(async () => response) })
      await expect(reader.read('solov', 'https://xm.solov.cc/qr.png')).rejects.toThrow(message)
    }
  })

  it('rejects failed answers, oversized bodies, empty bodies and anything that is not a displayable image', async () => {
    const cancel = vi.fn(async () => undefined)
    const declaredTooLarge = imageResponse(png, { headers: { 'content-length': String(announcementImageMaxBytes + 1) } })
    Object.defineProperty(declaredTooLarge, 'body', { value: { cancel } })
    const streamedTooLarge = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(png))
        controller.enqueue(new Uint8Array(announcementImageMaxBytes))
        controller.close()
      },
    }), { status: 200 })
    const cases: Array<[Response, string]> = [
      [new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }), '公告图片下载失败，服务返回 HTTP 404'],
      [declaredTooLarge, '公告图片响应超过 1024 KB 安全上限'],
      [streamedTooLarge, '公告图片响应超过 1024 KB 安全上限'],
      [new Response('', { status: 200 }), '公告图片下载失败，服务返回了空内容'],
      [new Response('<!doctype html><title>星芒</title>', { status: 200, headers: { 'content-type': 'image/png' } }), '公告图片不是能显示的 PNG、JPEG、GIF 或 WebP，或者尺寸太大'],
      [imageResponse(pngSized(20_000, 20_000)), '公告图片不是能显示的 PNG、JPEG、GIF 或 WebP，或者尺寸太大'],
    ]
    for (const [response, message] of cases) {
      const reader = createAnnouncementImageReader({ fetch: vi.fn<typeof fetch>(async () => response) })
      await expect(reader.read('solov', 'https://xm.solov.cc/qr.png')).rejects.toThrow(message)
    }
    expect(cancel).toHaveBeenCalled()
  })

  it('gives up after the time limit', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const reader = createAnnouncementImageReader({ fetch: fetchImpl, timeoutMs: 10 })

    await expect(reader.read('solov', 'https://xm.solov.cc/qr.png')).rejects.toThrow('公告图片下载超时')
  })

  it('downloads the same image once for concurrent and repeated reads, and again after half an hour', async () => {
    let now = 1_000
    const fetchImpl = vi.fn<typeof fetch>(async () => imageResponse(gif))
    const reader = createAnnouncementImageReader({ fetch: fetchImpl, now: () => now })

    const [first, second] = await Promise.all([
      reader.read('solov', 'https://xm.solov.cc/qr.gif'),
      reader.read('solov', 'https://xm.solov.cc/qr.gif#again'),
    ])
    expect(first).toBe(second)
    await reader.read('solov', 'https://xm.solov.cc/qr.gif')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    now += 30 * 60 * 1000
    await reader.read('solov', 'https://xm.solov.cc/qr.gif')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not remember a failure: the next open tries again', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(imageResponse(png))
    const reader = createAnnouncementImageReader({ fetch: fetchImpl })

    await expect(reader.read('solov', 'https://xm.solov.cc/qr.png')).rejects.toThrow('HTTP 503')
    await expect(reader.read('solov', 'https://xm.solov.cc/qr.png')).resolves.toMatch(/^data:image\/png;base64,/)
  })

  it('downloads at most three images at a time and refuses an endless queue', async () => {
    const { fetchImpl, pending } = heldFetch()
    const reader = createAnnouncementImageReader({ fetch: fetchImpl })

    const reads = Array.from({ length: 5 }, (_, index) => reader.read('solov', `https://xm.solov.cc/${index}.png`))
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(3)

    pending[0].resolve(imageResponse(png))
    await expect(reads[0]).resolves.toMatch(/^data:image\/png/)
    await settle()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(pending[3].url).toBe('https://xm.solov.cc/3.png')

    const queued = Array.from({ length: 31 }, (_, index) => reader.read('solov', `https://xm.solov.cc/queued-${index}.png`))
    await settle()
    await expect(reader.read('solov', 'https://xm.solov.cc/one-too-many.png')).rejects.toThrow('公告图片同时要下的太多，稍后再看')

    // The four reads above plus reads[4] and the 31 queued ones: each starts as an earlier one finishes.
    for (let round = 0; round < 100 && pending.length < 5 + 31; round += 1) {
      for (const entry of pending) entry.resolve(imageResponse(png))
      await settle()
    }
    for (const entry of pending) entry.resolve(imageResponse(png))
    expect(pending).toHaveLength(5 + 31)
    await expect(Promise.all(reads)).resolves.toHaveLength(5)
    await expect(Promise.all(queued)).resolves.toHaveLength(31)
    expect(fetchImpl).toHaveBeenCalledTimes(5 + 31)
  })
})
