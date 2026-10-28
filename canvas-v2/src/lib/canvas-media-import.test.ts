import { describe, expect, it } from 'vitest'
import { buildCanvasMediaUpload, canvasMediaExtension, canvasMediaFileAccept, isUploadedAssetCategoryTarget, isUploadedCanvasAsset, maximumCanvasMediaFileBytes, maximumCanvasMediaFormBytes, parseCanvasMediaUploadResponse, resolveCanvasImportMedia } from './canvas-media-import'

const id = 'a'.repeat(43)
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
const mp4 = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 109, 112, 52, 50])
const wav = new TextEncoder().encode('RIFF0000WAVEfmt ')
const project = '11111111-1111-4111-8111-111111111111'

function summary(mediaType = 'video', mimeType = 'video/mp4') {
  return { assetId: id, localUrl: `xingmang-asset://${mediaType}/${id}`, thumbnailUrl: `xingmang-asset://thumbnail/${id}`, mimeType, mediaType, fileName: '本地素材', createdAt: '2026-10-10T00:00:00.000Z', source: 'imported', taskId: 'imported' }
}

describe('canvas media import boundaries', () => {
  it('encodes a captured category target in the multipart upload and requires the corresponding owned assignment receipt', async () => {
    for (const target of [{}, { categoryId: null }, { categoryId: project, expectedCategoryVersion: 7 }]) {
      const upload = await buildCanvasMediaUpload([new File([png], 'source.png')], undefined, target)
      const form = await new Response(upload.body, { headers: { 'content-type': upload.contentType } }).formData()
      expect(form.get('categoryId')).toBe(target.categoryId === undefined ? null : target.categoryId === null ? 'uncategorized' : project)
      expect(form.get('expectedCategoryVersion')).toBe(target.categoryId ? '7' : null)
    }
    expect(isUploadedAssetCategoryTarget(summary(), {})).toBe(true)
    expect(isUploadedAssetCategoryTarget({ ...summary(), categoryId: null, organizationVersion: 0 }, { categoryId: null })).toBe(true)
    expect(isUploadedAssetCategoryTarget({ ...summary(), categoryId: project, organizationVersion: 1 }, { categoryId: project, expectedCategoryVersion: 7 })).toBe(true)
    for (const received of [summary(), { ...summary(), categoryId: null, organizationVersion: 0 }, { ...summary(), categoryId: project, organizationVersion: 0 }]) expect(isUploadedAssetCategoryTarget(received, { categoryId: project, expectedCategoryVersion: 7 })).toBe(false)
    for (const target of [{ categoryId: project }, { categoryId: null, expectedCategoryVersion: 1 }, { expectedCategoryVersion: 1 }, { categoryId: 'other-owner', expectedCategoryVersion: 1 }]) await expect(buildCanvasMediaUpload([new File([png], 'source.png')], undefined, target)).rejects.toThrow()
  })
  it('rejects M4A, AVIF, HEIF and AAC headers instead of mislabelling them as MP4 or MP3', () => {
    for (const brand of ['M4A ', 'M4B ', 'heic', 'mif1', 'avif', 'qt  ']) {
      const bytes = mp4.slice()
      bytes.set(new TextEncoder().encode(brand), 8)
      expect(resolveCanvasImportMedia(bytes)).toBeNull()
    }
    const compatibleAudio = mp4.slice()
    compatibleAudio.set(new TextEncoder().encode('M4A '), 16)
    expect(resolveCanvasImportMedia(compatibleAudio)).toBeNull()
    for (const size of [0, 1, 8, 15, 17, 4100]) {
      const bytes = mp4.slice()
      new DataView(bytes.buffer).setUint32(0, size)
      expect(resolveCanvasImportMedia(bytes)).toBeNull()
    }
    expect(resolveCanvasImportMedia(mp4.slice(0, 12))).toBeNull()
    expect(resolveCanvasImportMedia(new Uint8Array([255, 241, 80, 128]))).toBeNull()
    expect(resolveCanvasImportMedia(new Uint8Array([255, 249, 80, 128]))).toBeNull()
    expect(resolveCanvasImportMedia(new Uint8Array([255, 235]))).toBeNull()
  })

  it('recognizes only the server-supported image, video and audio signatures', () => {
    expect(resolveCanvasImportMedia(png)).toEqual({ mediaType: 'image', mimeType: 'image/png' })
    expect(resolveCanvasImportMedia(new Uint8Array([255, 216, 255]))).toEqual({ mediaType: 'image', mimeType: 'image/jpeg' })
    expect(resolveCanvasImportMedia(new TextEncoder().encode('RIFF0000WEBP'))).toEqual({ mediaType: 'image', mimeType: 'image/webp' })
    expect(resolveCanvasImportMedia(mp4)).toEqual({ mediaType: 'video', mimeType: 'video/mp4' })
    expect(resolveCanvasImportMedia(wav)).toEqual({ mediaType: 'audio', mimeType: 'audio/wav' })
    expect(resolveCanvasImportMedia(new TextEncoder().encode('ID3audio'))).toEqual({ mediaType: 'audio', mimeType: 'audio/mpeg' })
    expect(resolveCanvasImportMedia(new Uint8Array([255, 251]))).toEqual({ mediaType: 'audio', mimeType: 'audio/mpeg' })
    for (const invalid of [new Uint8Array([255]), new TextEncoder().encode('<svg>'), new TextEncoder().encode('RIFF0000AVI '), new TextEncoder().encode('OggS')]) expect(resolveCanvasImportMedia(invalid)).toBeNull()
  })

  it('provides type-specific file chooser filters without restricting general imports to images', () => {
    expect(canvasMediaFileAccept('video')).toBe('video/mp4')
    expect(canvasMediaFileAccept('audio')).toBe('audio/mpeg,audio/wav')
    expect(canvasMediaFileAccept('image')).not.toContain('video')
    expect(canvasMediaFileAccept()).toContain('video/mp4,audio/mpeg,audio/wav')
  })

  it('normalizes a mislabeled MP4 to a video multipart file and retains the selected project', async () => {
    const file = new File([mp4], '镜头.mp4', { type: 'image/png' })
    const result = await buildCanvasMediaUpload([file], project)
    const form = await new Response(result.body, { headers: { 'Content-Type': result.contentType } }).formData()
    const uploaded = form.get('file')
    expect(uploaded).toBeInstanceOf(File)
    if (!(uploaded instanceof File)) throw new Error('missing test file')
    expect(uploaded.type).toBe('video/mp4')
    expect(uploaded.name).toBe('镜头.mp4')
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(mp4)
    expect(form.get('projectId')).toBe(project)
    expect(result.media).toEqual([{ mediaType: 'video', mimeType: 'video/mp4' }])
    expect(file.type).toBe('image/png')
  })

  it('rejects the wrong node media type before creating an upload request', async () => {
    await expect(buildCanvasMediaUpload([new File([mp4], '伪装.png', { type: 'image/png' })], project, { mediaType: 'image' })).rejects.toThrow('该节点只接受PNG')
    await expect(buildCanvasMediaUpload([new File([png], '伪装.mp4', { type: 'video/mp4' })], project, { mediaType: 'video' })).rejects.toThrow('该节点只接受MP4')
    await expect(buildCanvasMediaUpload([new File([wav], 'voice.wav')], null, { mediaType: 'audio' })).resolves.toMatchObject({ media: [{ mediaType: 'audio', mimeType: 'audio/wav' }] })
  })

  it('accepts the exact 32 MiB file boundary but rejects one additional byte', async () => {
    const bytes = new Uint8Array(maximumCanvasMediaFileBytes)
    bytes.set(png)
    const result = await buildCanvasMediaUpload([new File([bytes], 'large.png')])
    expect(result.body.size).toBeGreaterThan(maximumCanvasMediaFileBytes)
    expect(result.body.size).toBeLessThan(maximumCanvasMediaFormBytes)
    await expect(buildCanvasMediaUpload([new File([bytes, new Uint8Array(1)], 'oversized.png')])).rejects.toThrow('32 MB')
  })

  it('counts multipart overhead rather than accepting a 40 MiB file sum as a 40 MiB request', async () => {
    const bytes = new Uint8Array(maximumCanvasMediaFormBytes / 2)
    bytes.set(png)
    await expect(buildCanvasMediaUpload([new File([bytes], 'one.png'), new File([bytes], 'two.png')])).rejects.toThrow('含文件表单')
  })

  it('rejects empty, unsupported and excessive inputs and bounds transmitted filenames', async () => {
    await expect(buildCanvasMediaUpload([])).rejects.toThrow('1–8')
    await expect(buildCanvasMediaUpload([new File([], 'empty.mp4')])).rejects.toThrow('为空')
    await expect(buildCanvasMediaUpload([new File(['unknown'], 'fake.png', { type: 'image/png' })])).rejects.toThrow('支持 PNG')
    await expect(buildCanvasMediaUpload(Array.from({ length: 9 }, () => new File([png], 'small.png')))).rejects.toThrow('1–8')
    await expect(buildCanvasMediaUpload([new File([png], 'small.png')], '../../other-owner')).rejects.toThrow('工程编号')
    const upload = await buildCanvasMediaUpload([new File([png], `\u0000${'名'.repeat(300)}.png`)])
    const file = (await new Response(upload.body, { headers: { 'Content-Type': upload.contentType } }).formData()).get('file')
    if (!(file instanceof File)) throw new Error('missing test file')
    expect(file.name.length).toBe(160)
    expect(file.name).not.toContain('\u0000')
  })

  it('retains actual video and audio summaries rather than fabricating image results', () => {
    expect(parseCanvasMediaUploadResponse({ items: [summary()] }, { mediaType: 'video', mimeType: 'video/mp4' })).toMatchObject({ mediaType: 'video', taskId: 'imported' })
    expect(parseCanvasMediaUploadResponse({ items: [summary('audio', 'audio/mpeg')] }, { mediaType: 'audio', mimeType: 'audio/mpeg' })).toMatchObject({ mediaType: 'audio', mimeType: 'audio/mpeg' })
  })

  it('rejects foreign URLs, mismatched media, deleted assets and incomplete upload receipts', () => {
    const expected = { mediaType: 'video' as const, mimeType: 'video/mp4' as const }
    for (const invalid of [{ ...summary(), localUrl: 'https://example.com/clip.mp4' }, { ...summary(), thumbnailUrl: 'https://example.com/cover.jpg' }, { ...summary(), mimeType: 'image/png' }, { ...summary(), mediaType: 'image' }, { ...summary(), taskId: '' }, { ...summary(), deletedAt: '2026-10-10' }, { ...summary(), createdAt: 'invalid' }, { ...summary(), width: -1 }]) {
      expect(isUploadedCanvasAsset(invalid, expected)).toBe(false)
      expect(() => parseCanvasMediaUploadResponse({ items: [invalid] }, expected)).toThrow('到素材库核对')
    }
    expect(() => parseCanvasMediaUploadResponse({ items: [] }, expected)).toThrow('不会自动再次上传')
    expect(() => parseCanvasMediaUploadResponse({ items: [summary(), summary()] }, expected)).toThrow('无法确认')
  })

  it('uses the real media extension for downloads and rejects unknown content types', () => {
    expect(['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'audio/mpeg', 'audio/wav'].map(canvasMediaExtension)).toEqual(['png', 'jpg', 'webp', 'mp4', 'mp3', 'wav'])
    expect(canvasMediaExtension('video/mp4; charset=binary')).toBe('mp4')
    expect(canvasMediaExtension('text/html')).toBeNull()
  })
})
