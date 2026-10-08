import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCanvasProjectPackage,
  maximumCanvasProjectAssets,
  parseCanvasProjectPackage,
  parseCanvasProjectWorkflow,
  readCanvasProjectAssetSources,
  remapCanvasProjectWorkflow,
} from './canvas-project-package'

const assetId = 'A'.repeat(43)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function workflow(): string {
  return JSON.stringify({
    schemaVersion: 2, name: '离线工程', nodes: [{
      id: 'image-1', kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 },
      data: { prompt: '', model: '', result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' }, candidateAssetIds: [assetId] },
    }], edges: [],
  })
}

describe('canvas project package', () => {
  it('round-trips owned image bytes and remaps stable references', () => {
    const content = buildCanvasProjectPackage(workflow(), [{
      asset: { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `xingmang-${assetId}.png` },
      bytes: png,
    }], '2026-08-13T00:00:00.000Z')
    const parsed = parseCanvasProjectPackage(content)
    const replacement = 'B'.repeat(43)
    const remapped = remapCanvasProjectWorkflow(parsed.workflow, new Map([[assetId, replacement]]))

    expect(parsed.assets[0].bytes.equals(png)).toBe(true)
    expect(remapped).not.toContain(assetId)
    expect(remapped).toContain(replacement)
    expect(content).not.toMatch(/apiKey|accessToken|refreshToken|Authorization|[A-Z]:\\/i)
  })

  it('refuses too many assets before reading any body', async () => {
    let reads = 0
    const ids = Array.from({ length: maximumCanvasProjectAssets + 1 }, (_, index) => String(index).padStart(43, 'a'))
    await expect(readCanvasProjectAssetSources(ids, async (id) => {
      reads += 1
      return { asset: { assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png', fileName: 'x.png' }, bytes: png }
    })).rejects.toThrow('画布项目资产数量超出安全上限')
    expect(reads).toBe(0)
  })

  it('reads with bounded concurrency and stops once the byte budget is exceeded', async () => {
    let active = 0
    let maxActive = 0
    let reads = 0
    const big = Buffer.alloc(30 * 1024 * 1024)
    const ids = Array.from({ length: maximumCanvasProjectAssets }, (_, index) => String(index).padStart(43, 'a'))
    await expect(readCanvasProjectAssetSources(ids, async (id) => {
      reads += 1
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return { asset: { assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png', fileName: 'x.png' }, bytes: big }
    })).rejects.toThrow('画布项目超出 96 MB 安全上限')
    expect(maxActive).toBeLessThanOrEqual(4)
    expect(reads).toBeLessThan(10)
  })

  it('keeps the requested order when every asset fits', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((character) => character.repeat(43))
    const sources = await readCanvasProjectAssetSources(ids, async (id) => {
      await new Promise((resolve) => setTimeout(resolve, id.startsWith('a') ? 5 : 0))
      return { asset: { assetId: id, localUrl: `xingmang-asset://image/${id}`, mimeType: 'image/png', fileName: 'x.png' }, bytes: png }
    })
    expect(sources.map((source) => source.asset.assetId)).toEqual(ids)
  })

  it('accepts every node data field the renderer schema can serialize', () => {
    // The renderer's serializer and this validator are two hand-maintained
    // lists in different tsconfig programs, so nothing makes them agree.
    // `group` and `imageResolution` were added to the schema and not here,
    // which failed every autosave whose node carried either one.
    const schema = fs.readFileSync(
      path.join(__dirname, '..', 'canvas-v2', 'src', 'persistence', 'workflow-schema.ts'),
      'utf8',
    )
    const block = schema.slice(schema.indexOf('interface PersistedWorkflowNodeV2'))
    const dataBlock = block.slice(block.indexOf('data: {'), block.indexOf('\n}'))
    const fields = [...dataBlock.matchAll(/^\s{4}([a-zA-Z]+)\??:/gm)].map((match) => match[1])
    expect(fields).toContain('group')
    expect(fields).toContain('imageResolution')
    expect(fields).toContain('latestAttemptDurationMs')

    const sample: Record<string, unknown> = {
      prompt: '多行\n提示词', model: 'gpt-image-2', group: '生图分组', quality: 'low',
      size: '1152x1536', imageResolution: '4K', seconds: '5',
      result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png' },
      settings: { videoMode: 'auto' }, candidateAssetIds: [assetId],
      latestAttemptDurationMs: 8_123,
    }
    // Every declared field must be represented in the sample, so a new schema
    // field cannot slip past this test either.
    expect(Object.keys(sample).sort()).toEqual([...fields].sort())

    const document = JSON.parse(workflow())
    document.nodes[0].data = sample
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(document))).not.toThrow()
  })

  it('accepts every asset reference field the renderer schema can serialize', () => {
    const schema = fs.readFileSync(
      path.join(__dirname, '..', 'canvas-v2', 'src', 'persistence', 'workflow-schema.ts'),
      'utf8',
    )
    const block = schema.slice(schema.indexOf('interface PersistedAssetRefV2'))
    const fields = [...block.slice(0, block.indexOf('\n}')).matchAll(/^\s{2}([a-zA-Z]+)\??:/gm)].map((match) => match[1])
    expect(fields).toContain('durationSeconds')

    const sample: Record<string, unknown> = {
      kind: 'video',
      assetId,
      localUrl: `xingmang-asset://video/${assetId}`,
      mimeType: 'video/mp4',
      width: 1280,
      height: 720,
      durationSeconds: 5.2,
      taskId: 'task-1',
    }
    expect(Object.keys(sample).sort()).toEqual([...fields].sort())

    const document = JSON.parse(workflow())
    document.nodes[0].data.result = sample
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(document))).not.toThrow()
    document.nodes[0].data.result = { ...sample, filePath: 'C:\\\\Users\\\\secret.mp4' }
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(document))).toThrow('未知或敏感字段')
  })

  it('rejects sensitive fields, remote locations and dangling edges', () => {
    const sensitive = JSON.parse(workflow())
    sensitive.nodes[0].data.settings = { apiKey: 'sk-secret' }
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(sensitive))).toThrow('不安全')
    sensitive.nodes[0].data.settings = { source: 'https://private.invalid/x' }
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(sensitive))).toThrow('不安全')
    const dangling = JSON.parse(workflow())
    dangling.edges = [{ id: 'e', source: 'missing', sourceHandle: 'out:image', target: 'image-1', targetHandle: 'in:image' }]
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(dangling))).toThrow('不存在的节点')
    const hostileViewport = JSON.parse(workflow())
    hostileViewport.viewport = { x: 0, y: 0, zoom: 1, accessToken: 'hidden' }
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(hostileViewport))).toThrow('视口格式错误')
  })

  it('rejects damaged, duplicated and excessive asset entries', () => {
    const content = JSON.parse(buildCanvasProjectPackage(workflow(), []))
    const encoded = png.toString('base64')
    const sha256 = '0'.repeat(64)
    content.assets = [{ assetId, mimeType: 'image/png', bytesBase64: encoded, sha256 }]
    expect(() => parseCanvasProjectPackage(JSON.stringify(content))).toThrow('完整性')
    content.assets = Array.from({ length: maximumCanvasProjectAssets + 1 }, () => ({ assetId, mimeType: 'image/png', bytesBase64: encoded, sha256 }))
    expect(() => parseCanvasProjectPackage(JSON.stringify(content))).toThrow('资产清单')
  })

  it('rejects unbounded or sensitive provenance metadata', () => {
    const content = JSON.parse(buildCanvasProjectPackage(workflow(), []))
    content.provenance = [{ name: '来源', license: 'MIT', accessToken: 'hidden' }]
    expect(() => parseCanvasProjectPackage(JSON.stringify(content))).toThrow('未知或敏感字段')
    content.provenance = Array.from({ length: 65 }, () => ({ name: '来源', license: 'MIT' }))
    expect(() => parseCanvasProjectPackage(JSON.stringify(content))).toThrow('来源清单')
  })

  it('keeps audio and video references without treating them as embedded images', () => {
    const audioId = 'C'.repeat(43)
    const videoId = 'D'.repeat(43)
    const content = JSON.stringify({
      schemaVersion: 2, name: '媒体项目', mediaGroups: { image: '生图分组', video: 'grok', text: '对话分组', imageModel: 'gpt-image-2', videoModel: 'grok-imagine-video', textModel: 'gpt-5.4' },
      nodes: [
        { id: 'audio', kind: 'audio-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', result: { kind: 'audio', assetId: audioId, localUrl: `xingmang-asset://audio/${audioId}`, mimeType: 'audio/wav' } } },
        { id: 'video', kind: 'video-input', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: '', model: '', seconds: '5', result: { kind: 'video', assetId: videoId, localUrl: `xingmang-asset://video/${videoId}`, mimeType: 'video/mp4' } } },
      ],
      edges: [],
    })
    const parsed = parseCanvasProjectWorkflow(content)
    expect(parsed.assetIds).toEqual([])
    expect(parsed.workflow).toMatchObject({
      mediaGroups: {
        image: '生图分组', video: 'grok', text: '对话分组',
        imageModel: 'gpt-image-2', videoModel: 'grok-imagine-video', textModel: 'gpt-5.4',
      },
    })
    expect(buildCanvasProjectPackage(content, [])).toContain(`xingmang-asset://audio/${audioId}`)
  })

  it('accepts drama fields persisted in the existing settings bag', () => {
    const document = JSON.parse(workflow())
    document.nodes[0] = {
      id: 'char-1', kind: 'drama-character', definitionVersion: 1, position: { x: 12, y: 24 },
      data: {
        prompt: '定妆', model: '',
        settings: { assetKind: 'character', name: '虞晚', elementId: 'yuwan', appearance: '红衣金饰', locked: true },
      },
    }
    expect(() => parseCanvasProjectWorkflow(JSON.stringify(document))).not.toThrow()
  })
})
