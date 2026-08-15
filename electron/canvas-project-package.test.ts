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
