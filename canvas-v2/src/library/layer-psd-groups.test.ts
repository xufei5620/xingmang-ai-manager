import { describe, expect, it, vi } from 'vitest'
import { buildLayerPsdRecordPlan } from './layer-psd-groups'
import { openLayerPsd, readLayerPsd } from './layer-psd-reader'
import { writeLayerPsd } from './layer-psd-writer'
import { buildPsdReaderFixture, fixtureU32 } from './layer-psd-reader.test-fixture'
import type { ImageLayerGrouping } from '../image-tools/recipe'

const fast = { yieldControl: async () => undefined }
type FixtureLayer = NonNullable<NonNullable<Parameters<typeof buildPsdReaderFixture>[0]>['layers']>[number]
function ascii(value: string): number[] { return [...value].map((letter) => letter.charCodeAt(0)) }
function divider(kind: number, blend?: string, key = 'lsct') { return { key, data: [...fixtureU32(kind), ...(blend ? ascii(`8BIM${blend}`) : [])] } }
function folder(kind: number, values: { name?: string; blend?: string; locked?: number; opacity?: number; flags?: number; headerBlend?: string; noChannels?: boolean } = {}) {
  return { name: values.name ?? '产品 🧃', width: 0, height: 0, opacity: values.opacity ?? 255, flags: values.flags ?? 24, blend: values.headerBlend ?? 'norm', channelIds: values.noChannels ? [] : [0, 1, 2, -1], tags: [divider(kind, values.blend ?? (kind === 3 ? 'norm' : 'pass')), ...(values.locked === undefined ? [] : [{ key: 'lspf', data: fixtureU32(values.locked) }])] }
}
function grouping(): ImageLayerGrouping {
  return { version: 1, layerIds: ['private-image-a', 'private-image-b', 'private-image-c'], groups: [{ id: 'private-group', name: '产品 🧃', children: ['private-image-a', 'nested'], visible: true, locked: true }, { id: 'nested', name: '隐藏说明', children: ['private-image-b'], visible: false, locked: false }] }
}

describe('PSD pass-through folder record plan', () => {
  it('brackets complete bottom-to-top subtrees and keeps an optional independent background outside all groups', () => {
    const plan = buildLayerPsdRecordPlan(4, grouping(), 1)
    expect(plan.map((entry) => entry.kind === 'layer' ? entry.index : `${entry.id}:${entry.divider}`)).toEqual([0, 'private-group:3', 1, 'nested:3', 2, 'nested:1', 'private-group:1', 3])
    expect(plan.filter((entry) => entry.kind === 'folder' && entry.divider === 1)).toMatchObject([{ name: '隐藏说明', visible: false }, { name: '产品 🧃', locked: true }])
  })
  it('rejects malformed grouping and unsafe offsets before rendering any pixels', async () => {
    const readLayer = vi.fn(), readComposite = vi.fn(), layers = Array.from({ length: 3 }, (_, index) => ({ name: `叶${index}`, visible: true, opacity: 1, blend: 'source-over' as const }))
    await expect(writeLayerPsd({ width: 1, height: 1, layers, groupedLayerOffset: 1, readLayer, readComposite }, fast)).rejects.toThrow('偏移')
    await expect(writeLayerPsd({ width: 1, height: 1, layers, layerGroups: grouping(), groupedLayerOffset: 1, readLayer, readComposite }, fast)).rejects.toThrow('编组无效')
    expect(readLayer).not.toHaveBeenCalled(); expect(readComposite).not.toHaveBeenCalled()
  })
})

describe('independently assembled PSD folder import', () => {
  it.each([1, 2])('reads standard type %i folders whose pass-through key is in lsct rather than the normal layer header', async (kind) => {
    const doc = await readLayerPsd(buildPsdReaderFixture({ layers: [folder(3), { name: '底层' }, folder(3, { noChannels: true }), { name: '隐藏子层', flags: 10 }, folder(2, { name: '内组', flags: 26 }), folder(kind, { locked: 0x80000000 })] }), fast)
    expect(doc.layers.map((layer) => [layer.name, layer.visible])).toEqual([['底层', true], ['隐藏子层', false]])
    expect(doc.layerGroups).toEqual({ version: 1, layerIds: ['psd-layer-1', 'psd-layer-2'], groups: [{ id: 'psd-group-1', name: '产品 🧃', children: ['psd-layer-1', 'psd-group-2'], visible: true, locked: true }, { id: 'psd-group-2', name: '内组', children: ['psd-layer-2'], visible: false, locked: false }] })
  })
  it.each([7, 15, 0x80000000, 0x80000001, 0x80000004, 0x80000007, 0x8000000f])('preserves complete protection %i without dropping its lock', async (flags) => {
    const doc = await readLayerPsd(buildPsdReaderFixture({ layers: [folder(3), { name: '独立锁', tags: [{ key: 'lspf', data: fixtureU32(flags) }] }, folder(1, { locked: flags })] }), fast)
    expect(doc.layers[0].locked).toBe(true)
    expect(doc.layerGroups!.groups[0].locked).toBe(true)
  })
  it.each([1, 2, 4, 8, 0x10, 0x80000010, 0xffffffff])('rejects partial or unknown protection %i rather than expanding its meaning', async (flags) => {
    await expect(openLayerPsd(buildPsdReaderFixture({ layers: [folder(3), {}, folder(1, { locked: flags })] }), fast)).rejects.toThrow('锁定')
  })
  it.each([
    ['unmatched opener', [folder(3), {}]],
    ['orphan folder', [{}, folder(1)]],
    ['empty folder', [{}, folder(3), folder(1)]],
    ['isolated normal folder', [folder(3), {}, folder(1, { blend: 'norm' })]],
    ['isolated blend folder', [folder(3), {}, folder(1, { blend: 'mul ' })]],
    ['group opacity', [folder(3), {}, folder(1, { opacity: 254 })]],
    ['group pixels', [folder(3), {}, { ...folder(1), width: 1, height: 1 }]],
    ['group offset', [folder(3), {}, { ...folder(1), left: 1 }]],
    ['duplicate divider', [folder(3), {}, { ...folder(1), tags: [divider(1, 'pass'), divider(1, 'pass')] }]],
    ['conflicting lsdk', [folder(3), {}, { ...folder(1), tags: [divider(1, 'pass'), divider(2, 'pass', 'lsdk')] }]],
  ] satisfies Array<[string, FixtureLayer[]]>)('rejects %s before exposing any leaf', async (_label, layers) => {
    await expect(openLayerPsd(buildPsdReaderFixture({ layers: structuredClone([...layers]) }), fast)).rejects.toThrow()
  })
  it('rejects excess nesting, group count and total record count before leaf decode', async () => {
    await expect(openLayerPsd(buildPsdReaderFixture({ layers: [...Array.from({ length: 5 }, () => folder(3)), {}, ...Array.from({ length: 5 }, () => folder(1))] }), fast)).rejects.toThrow('4 层')
    const groups = Array.from({ length: 6 }, (_, index) => [...Array.from({ length: index === 5 ? 1 : 4 }, () => folder(3)), {}, ...Array.from({ length: index === 5 ? 1 : 4 }, () => folder(1))]).flat()
    await expect(openLayerPsd(buildPsdReaderFixture({ layers: groups }), fast)).rejects.toThrow('20 个组')
    await expect(openLayerPsd(buildPsdReaderFixture({ layers: Array.from({ length: 62 }, () => folder(3)) }), fast)).rejects.toThrow('记录超过')
  })
  it.each([
    [], [0], [...fixtureU32(1), 0], fixtureU32(9), [...fixtureU32(1), ...ascii('BAD!pass')], [...fixtureU32(1), ...ascii('8BIMpass'), ...fixtureU32(1)],
  ])('rejects invalid lsct structure %j explicitly', async (...values) => {
    const data = values.flat()
    await expect(openLayerPsd(buildPsdReaderFixture({ layers: [{ tags: [{ key: 'lsct', data }] }] }), fast)).rejects.toThrow('编组')
  })
  it('retains validated hierarchy when a caller mutates the returned metadata before decoding', async () => {
    const reader = await openLayerPsd(buildPsdReaderFixture({ layers: [folder(3), {}, folder(1)] }), fast)
    reader.layers[0].visible = false
    expect((await reader.readLayer(0)).visible).toBe(true)
  })
})

describe('PSD folder export roundtrip', () => {
  it('preserves nested names, own hidden and complete lock flags with an ungrouped background offset', async () => {
    const groups = grouping(), frame = { width: 2, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255, 20, 30, 40, 128]) }, readLayer = vi.fn(async () => frame)
    const bytes = await writeLayerPsd({ width: 2, height: 1, layers: ['背景', '产品', '说明', '顶层'].map((name, index) => ({ name, visible: index !== 3, locked: index === 2, opacity: index === 2 ? .5 : 1, blend: 'source-over' })), layerGroups: groups, groupedLayerOffset: 1, readLayer, readComposite: async () => frame }, fast)
    const doc = await readLayerPsd(bytes, fast)
    expect(doc.layers.map((layer) => layer.name)).toEqual(['背景', '产品', '说明', '顶层'])
    expect(doc.layers[2]).toMatchObject({ visible: true, locked: true, opacity: 128 / 255 })
    expect(doc.layerGroups!.groups.map((group) => [group.name, group.visible, group.locked])).toEqual([['产品 🧃', true, true], ['隐藏说明', false, false]])
    expect(doc.layerGroups!.groups[0].children).toEqual(['psd-layer-2', 'psd-group-2'])
    expect(doc.layerGroups!.groups[1].children).toEqual(['psd-layer-3'])
    expect(doc.layers[0].data).toEqual(frame.data)
    expect(readLayer.mock.calls).toHaveLength(4)
    const text = new TextDecoder().decode(bytes)
    expect(text).not.toContain('private-image'); expect(text).not.toContain('private-group')
  })
  it.each(['\uD800', 'x\uDC00'])('rejects a lone UTF16 surrogate in a leaf name before any pixel read: %j', async (name) => {
    const readLayer = vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) })), readComposite = readLayer
    await expect(writeLayerPsd({ width: 1, height: 1, layers: [{ name, visible: true, opacity: 1, blend: 'source-over' }], readLayer, readComposite }, fast)).rejects.toThrow('名称')
    expect(readLayer).not.toHaveBeenCalled()
  })
})
