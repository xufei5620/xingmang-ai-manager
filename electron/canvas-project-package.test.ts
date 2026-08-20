import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCanvasProjectPackage,
  maximumCanvasProjectAssets,
  parseCanvasProjectPackage,
  parseCanvasProjectWorkflow,
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
      schemaVersion: 2, name: '媒体项目', mediaGroups: { image: '生图分组', video: 'grok' },
      nodes: [
        { id: 'audio', kind: 'audio-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', result: { kind: 'audio', assetId: audioId, localUrl: `xingmang-asset://audio/${audioId}`, mimeType: 'audio/wav' } } },
        { id: 'video', kind: 'video-input', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: '', model: '', seconds: '5', result: { kind: 'video', assetId: videoId, localUrl: `xingmang-asset://video/${videoId}`, mimeType: 'video/mp4' } } },
      ],
      edges: [],
    })
    const parsed = parseCanvasProjectWorkflow(content)
    expect(parsed.assetIds).toEqual([])
    expect(parsed.workflow).toMatchObject({ mediaGroups: { image: '生图分组', video: 'grok' } })
    expect(buildCanvasProjectPackage(content, [])).toContain(`xingmang-asset://audio/${audioId}`)
  })
})
