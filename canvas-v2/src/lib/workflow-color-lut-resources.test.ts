import { describe, expect, it, vi } from 'vitest'
import { parseColorLutCube } from '../image-tools/layer-color-lut'
import type { AssetColorLutSource } from '../image-tools/layer-color-lut-selection'
import { describeColorLutResource, serializeColorLutResource, type ColorLutResourceDescriptor } from './color-lut-resource-contract'
import { buildWorkflowColorLutResources, collectWorkflowColorLutSources, importWorkflowColorLutResources, parseWorkflowColorLutResources, remapWorkflowColorLutSources } from './workflow-color-lut-resources'

async function fixture(name = 'Owned identity', id = 'a'.repeat(43)) {
  const table = parseColorLutCube(`TITLE "${name}"\nLUT_1D_SIZE 2\n0 0 0\n1 1 1\n`)
  const bytes = serializeColorLutResource(table), content = new TextDecoder().decode(bytes)
  const descriptor: ColorLutResourceDescriptor = { ...await describeColorLutResource(bytes), assetId: id }
  const source: AssetColorLutSource = { kind: 'asset', lutAssetId: id, digest: descriptor.digest, name, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
  const workflow = { schemaVersion: 2, name: '保留工程', nodes: [{ id: 'layer', data: { prompt: '原文字', settings: { other: 7, imageTransform: { version: 1, kind: 'layer', layers: [{ id: 'one', colorGrade: { exposure: 1, lut: { version: 1, enabled: false, strength: 0, source } } }] } } } }], edges: [] }
  return { table, bytes, content, descriptor, source, workflow }
}

describe('workflow LUT resource closure', () => {
  it('collects disabled zero-strength custom sources and deduplicates layers without mutating', async () => {
    const f = await fixture(), layer = f.workflow.nodes[0].data.settings.imageTransform.layers[0]
    f.workflow.nodes[0].data.settings.imageTransform.layers = Array.from({ length: 20 }, (_, index) => ({ ...layer, id: String(index) }))
    const before = JSON.stringify(f.workflow)
    expect(collectWorkflowColorLutSources(f.workflow)).toEqual([f.source])
    expect(JSON.stringify(f.workflow)).toBe(before)
    expect(before.length).toBeLessThan(12 * 1024)
  })

  it('supports flat run recipes while remapping only LUT IDs and preserving settings', async () => {
    const f = await fixture(), workflow = { nodes: [{ data: { imageTransform: f.workflow.nodes[0].data.settings.imageTransform, settings: { keep: '原设置' } } }] }
    const next = remapWorkflowColorLutSources(workflow, new Map([[f.source.lutAssetId, { ...f.descriptor, assetId: 'b'.repeat(43) }]]))
    expect(collectWorkflowColorLutSources(next)[0].lutAssetId).toBe('b'.repeat(43))
    expect(collectWorkflowColorLutSources(workflow)[0].lutAssetId).toBe('a'.repeat(43))
    expect(next.nodes[0].data.settings.keep).toBe('原设置')
    expect(next.nodes[0].data.imageTransform.layers[0].colorGrade).toMatchObject({ exposure: 1, lut: { enabled: false, strength: 0 } })
  })

  it('rejects conflicting metadata for one immutable source', async () => {
    const f = await fixture(), node = structuredClone(f.workflow.nodes[0])
    node.data.settings.imageTransform.layers[0].colorGrade.lut.source.name = '冲突'
    f.workflow.nodes.push(node)
    expect(() => collectWorkflowColorLutSources(f.workflow)).toThrow('冲突')
  })

  it.each([null, false, undefined, { version: 2 }, { version: 1, enabled: false, strength: 0, source: { kind: 'builtin', presetId: 'unknown' } }])('rejects malformed present selections without dropping them: %j', async (value) => {
    const f = await fixture(), raw = structuredClone(f.workflow) as unknown as { nodes: { data: { settings: { imageTransform: { layers: { colorGrade: { lut: unknown } }[] } } } }[] }
    raw.nodes[0].data.settings.imageTransform.layers[0].colorGrade.lut = value
    expect(() => collectWorkflowColorLutSources(raw)).toThrow()
  })

  it('requires every custom source mapping and verifies replacement content identity', async () => {
    const f = await fixture()
    expect(() => remapWorkflowColorLutSources(f.workflow, new Map())).toThrow('缺少')
    expect(() => remapWorkflowColorLutSources(f.workflow, new Map([[f.source.lutAssetId, { ...f.descriptor, digest: '0'.repeat(64) }]]))).toThrow('摘要')
  })

  it('builds one self-contained resource per digest and validates owned read receipts', async () => {
    const f = await fixture(), second = structuredClone(f.workflow.nodes[0]); second.data.settings.imageTransform.layers[0].colorGrade.lut.source.lutAssetId = 'c'.repeat(43); f.workflow.nodes.push(second)
    const read = vi.fn(async (source: AssetColorLutSource) => ({ descriptor: { ...f.descriptor, assetId: source.lutAssetId }, table: f.table }))
    expect(await buildWorkflowColorLutResources(f.workflow, read)).toEqual([{ content: f.content }])
    expect(read).toHaveBeenCalledTimes(2)
    await expect(buildWorkflowColorLutResources(f.workflow, async () => ({ descriptor: { ...f.descriptor, assetId: 'd'.repeat(43) }, table: f.table }))).rejects.toThrow('其他素材')
  })

  it('never fetches an original account ID on import and remaps to the verified current-owner receipt', async () => {
    const f = await fixture(), upload = vi.fn(async () => ({ ...f.descriptor, assetId: 'n'.repeat(43) }))
    const restored = await importWorkflowColorLutResources(f.workflow, [{ content: f.content }], upload)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0]).toHaveLength(2)
    expect(collectWorkflowColorLutSources(restored)[0].lutAssetId).toBe('n'.repeat(43))
    expect(f.workflow.nodes[0].data.settings.imageTransform.layers[0].colorGrade.lut.source.lutAssetId).toBe('a'.repeat(43))
  })

  it('verifies the complete registry before the first upload and rejects altered samples', async () => {
    const f = await fixture(), g = await fixture('Second', 'b'.repeat(43)), workflow = { nodes: [...f.workflow.nodes, ...g.workflow.nodes] }
    const altered = JSON.parse(g.content); altered.data = `${altered.data[0] === 'A' ? 'B' : 'A'}${altered.data.slice(1)}`
    const upload = vi.fn()
    await expect(importWorkflowColorLutResources(workflow, [{ content: f.content }, { content: JSON.stringify(altered) }], upload)).rejects.toThrow()
    expect(upload).not.toHaveBeenCalled()
  })

  it.each(['missing', 'extra', 'duplicate', 'url'])('refuses non self-contained resource registries: %s', async (mode) => {
    const f = await fixture(), upload = vi.fn(), other = await fixture('Unrelated')
    const resources = mode === 'missing' ? [] : mode === 'duplicate' ? [{ content: f.content }, { content: f.content }] : mode === 'extra' ? [{ content: f.content }, { content: other.content }] : [{ content: f.content, url: 'https://external.invalid/lut' }]
    await expect(importWorkflowColorLutResources(f.workflow, resources, upload)).rejects.toThrow()
    expect(upload).not.toHaveBeenCalled()
  })

  it('rejects mismatched upload receipts before returning a workflow', async () => {
    const f = await fixture()
    await expect(importWorkflowColorLutResources(f.workflow, [{ content: f.content }], async () => ({ ...f.descriptor, name: '别的表' }))).rejects.toThrow('摘要')
  })

  it('aborts an uncooperative upload promptly without returning a late graph', async () => {
    const f = await fixture(), controller = new AbortController()
    let resolve!: (value: ColorLutResourceDescriptor) => void
    const upload = vi.fn(() => new Promise<ColorLutResourceDescriptor>((done) => { resolve = done }))
    const pending = importWorkflowColorLutResources(f.workflow, [{ content: f.content }], upload, { signal: controller.signal })
    await vi.waitFor(() => expect(upload).toHaveBeenCalled())
    controller.abort(new Error('测试取消'))
    await expect(pending).rejects.toThrow('测试取消')
    resolve(f.descriptor)
  })

  it('rejects expired deadlines and oversized registries before IO', async () => {
    const f = await fixture(), upload = vi.fn(), controller = new AbortController(); controller.abort()
    await expect(importWorkflowColorLutResources(f.workflow, [{ content: f.content }], upload, { signal: controller.signal })).rejects.toThrow()
    await expect(importWorkflowColorLutResources(f.workflow, [{ content: f.content }], upload, { deadline: Date.now() - 1 })).rejects.toThrow('超时')
    expect(() => parseWorkflowColorLutResources(f.workflow, Array.from({ length: 21 }, () => ({ content: f.content })))).toThrow('数量')
    expect(upload).not.toHaveBeenCalled()
  })
})
