import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { parseXingCanvasProject, serializeXingCanvasProject } from './project-package'
import { maximumWorkflowBytes } from './workflow-schema'

const assetId = 'a'.repeat(43)
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1sAAAAASUVORK5CYII='

function workflow(): WorkflowFile {
  return { ...createEmptyWorkflow('桌面图片项目'), nodes: [{ id: 'input', kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` } } }] }
}

function desktopPackage() {
  return {
    format: 'xingmang-canvas-project', packageVersion: 1, createdAt: '2026-10-10T00:00:00.000Z',
    workflow: workflow(),
    assets: [{ assetId, mimeType: 'image/png', bytesBase64: png, sha256: createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex') }],
    provenance: [{ name: '星芒原创画布模板', license: 'Proprietary' }],
  }
}

describe('portable project envelopes', () => {
  it('keeps the Sites license envelope and its notices readable', () => {
    const licenses = [{ name: 'React Flow', license: 'MIT', notice: '保留声明' }]
    const parsed = parseXingCanvasProject(serializeXingCanvasProject(workflow(), { licenses }))
    expect(parsed?.workflow.nodes[0].data.result?.assetId).toBe(assetId)
    expect(parsed?.licenses).toEqual(licenses)
    expect(parsed?.embeddedAssetCount).toBe(0)
    expect(parsed?.warnings).toEqual([])
  })

  it('reads the actual desktop assets and provenance shape without claiming to import bytes', () => {
    const source = desktopPackage()
    const parsed = parseXingCanvasProject(JSON.stringify(source))
    expect(parsed?.workflow.nodes[0].data.result?.assetId).toBe(assetId)
    expect(parsed?.licenses).toEqual(source.provenance)
    expect(parsed?.embeddedAssetCount).toBe(1)
    expect(parsed?.warnings).toContain('项目包内有 1 张嵌入图片，当前仅读取工作流，不会复制这些图片；请单独导入图片并重新选择素材。')
    expect(parsed).not.toHaveProperty('assets')
    expect(JSON.stringify(parsed)).not.toContain(png)
  })

  it('accepts desktop packages that have no embedded images', () => {
    expect(parseXingCanvasProject(JSON.stringify({ ...desktopPackage(), assets: [] }))?.embeddedAssetCount).toBe(0)
  })

  it.each(['not-a-date', '2026-10-10T00:00:00.000Z\0', 'a'.repeat(65)])('refuses to serialize an unreadable project timestamp %s', (createdAt) => {
    expect(() => serializeXingCanvasProject(workflow(), { createdAt })).toThrow('时间格式')
  })

  it.each([
    { packageVersion: 2 }, { format: 'other-project' }, { createdAt: 'not-a-date' },
    { createdAt: '2026-10-10T00:00:00.000Z\0' }, { unknown: true }, { licenses: [] },
    { assets: undefined }, { provenance: undefined }, { provenance: 'MIT' },
  ])('rejects an unsupported or ambiguous desktop envelope %j', (change) => {
    expect(parseXingCanvasProject(JSON.stringify({ ...desktopPackage(), ...change }))).toBeNull()
  })

  it.each([
    { assetId: 'short' }, { mimeType: 'audio/mpeg' }, { mimeType: { toString: 'image/png' } },
    { bytesBase64: '' }, { bytesBase64: 'A===' }, { bytesBase64: 'a bad body' },
    { sha256: 'short' }, { sha256: 'A'.repeat(64) }, { extra: 'unknown' },
  ])('rejects invalid embedded image metadata %j', (change) => {
    const source = desktopPackage()
    expect(parseXingCanvasProject(JSON.stringify({ ...source, assets: [{ ...source.assets[0], ...change }] }))).toBeNull()
  })

  it('rejects duplicate and excessive embedded image entries', () => {
    const source = desktopPackage()
    expect(parseXingCanvasProject(JSON.stringify({ ...source, assets: [source.assets[0], source.assets[0]] }))).toBeNull()
    const assets = Array.from({ length: 65 }, (_, index) => ({ ...source.assets[0], assetId: String(index).padStart(43, 'a') }))
    expect(parseXingCanvasProject(JSON.stringify({ ...source, assets }))).toBeNull()
  })

  it('bounds and validates every license and provenance entry', () => {
    const source = desktopPackage()
    expect(parseXingCanvasProject(JSON.stringify({ ...source, provenance: Array.from({ length: 65 }, () => source.provenance[0]) }))).toBeNull()
    expect(parseXingCanvasProject(JSON.stringify({ ...source, provenance: [{ ...source.provenance[0], notice: 'Unexpected desktop field' }] }))).toBeNull()
    const sites = JSON.parse(serializeXingCanvasProject(workflow()))
    expect(parseXingCanvasProject(JSON.stringify({ ...sites, licenses: [{ name: 'x', license: 'MIT', notice: 'a'.repeat(8_001) }] }))).toBeNull()
    expect(parseXingCanvasProject(JSON.stringify({ ...sites, licenses: [{ name: 'x\0', license: 'MIT' }] }))).toBeNull()
    expect(() => serializeXingCanvasProject(workflow(), { licenses: Array.from({ length: 65 }, () => ({ name: 'x', license: 'MIT' })) })).toThrow('数量')
  })

  it('measures the envelope in UTF-8 bytes for reading and writing', () => {
    const source = createEmptyWorkflow('中文容量')
    source.nodes = Array.from({ length: 75 }, (_, index) => ({ id: `prompt-${index}`, kind: 'prompt', definitionVersion: 1, position: { x: index, y: 0 }, data: { prompt: '星'.repeat(100_000), model: '', status: 'idle' } }))
    const content = JSON.stringify({ ...desktopPackage(), workflow: source, assets: [] })
    expect(content.length).toBeLessThan(maximumWorkflowBytes)
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(maximumWorkflowBytes + 256 * 1024)
    expect(parseXingCanvasProject(content)).toBeNull()
    expect(() => serializeXingCanvasProject(source)).toThrow('安全上限')
  })
})
