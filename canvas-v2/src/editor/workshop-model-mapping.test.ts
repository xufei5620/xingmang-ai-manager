import { describe, expect, it } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasGroupSummary } from '../host'
import { availableModelsForKind } from '../library/media-groups'
import type { CanvasNodeSourceCatalog } from '../library/node-model-availability'
import { buildWorkshopModelMapping, planWorkshopModelMapping, workshopModelMappingModels, type WorkshopModelMappingInput, type WorkshopModelMappingRow } from './workshop-model-mapping'

function node(id: string, type = 'image-generate', group?: string, model = 'old-image'): EditorNodeRecord {
  return { id, type, definitionVersion: 1, position: { x: 10, y: 20 }, data: { prompt: '原需求', model, status: 'success', ...(group === undefined ? {} : { group }), settings: { title: `标题 ${id}`, storyboardTask: { version: 1, panels: 25 } }, size: '1536x1024', imageResolution: '4K', seconds: '12', dirty: false, result: { kind: 'image', assetId: 'old-result', localUrl: 'xingmang-asset://image/old-result' }, candidateAssetIds: ['candidate-a', 'candidate-b'], videoCandidateCount: 2, outputText: '旧文字', candidates: [{ assetId: 'retained-candidate' }] } }
}
function fixture(nodes: readonly EditorNodeRecord[] = [node('a'), node('b', 'image-edit'), node('c', 'image-generate', 'old-private')], nodeIds = nodes.map((entry) => entry.id)): WorkshopModelMappingInput {
  const groups: CanvasGroupSummary[] = [
    { name: 'images-a', description: '本人图片 A', ratio: 1, revision: 2, connectionStatus: 'ready', purposes: ['image'] },
    { name: 'images-b', description: '本人图片 B', ratio: 1, revision: 5, connectionStatus: 'ready', purposes: ['image'] },
    { name: 'videos', description: '本人视频', ratio: 1, revision: 4, connectionStatus: 'ready', purposes: ['video'], videoProtocol: 'relay-videos' },
    { name: 'text', description: '本人文字', ratio: 1, revision: 3, connectionStatus: 'ready', purposes: ['text'] },
    { name: 'legacy', description: '旧混合目录', ratio: 1, revision: 6 },
  ]
  const catalog: CanvasNodeSourceCatalog = {
    'images-a': { state: 'ready', models: ['gpt-image-1', 'relay-image-alias'], purposes: ['image'] },
    'images-b': { state: 'ready', models: ['gpt-image-2'], purposes: ['image'] },
    videos: { state: 'ready', models: ['grok-imagine-video'], purposes: ['video'], videoProtocol: 'relay-videos' },
    text: { state: 'ready', models: ['gpt-4.1-mini', 'gpt-image-1'], purposes: ['text'] },
    legacy: { state: 'ready', models: ['gpt-4.1-mini', 'gpt-image-1', 'grok-imagine-video'] },
  }
  return { nodes, nodeIds, groups, catalog }
}
function row(input: WorkshopModelMappingInput, id = 'a'): WorkshopModelMappingRow {
  const value = buildWorkshopModelMapping(input).rows.find((entry) => entry.nodeIds.includes(id))
  if (!value) throw new Error('Missing mapping row')
  return value
}
function choice(input: WorkshopModelMappingInput, id = 'a', group = 'images-a', model = 'gpt-image-1') { return { rowId: row(input, id).id, group, model } }

describe('workshop model mapping purpose filtering', () => {
  const models = ['gpt-4o-mini', 'gpt-image-1', 'grok-imagine-video', 'relay-unknown-alias']
  it.each([
    { purpose: 'image' as const, expected: ['gpt-image-1', 'relay-unknown-alias'] },
    { purpose: 'video' as const, expected: ['grok-imagine-video', 'relay-unknown-alias'] },
    { purpose: 'text' as const, expected: ['gpt-4o-mini', 'relay-unknown-alias'] },
  ])('filters mixed explicitly declared catalogs for $purpose without inventing alias capabilities', ({ purpose, expected }) => {
    expect(workshopModelMappingModels(purpose, { models, purposes: ['image', 'video', 'text'] })).toEqual(expected)
    expect(workshopModelMappingModels(purpose, { models: [...models, ...models], purposes: [purpose] })).toEqual(expected)
    expect(workshopModelMappingModels(purpose, { models, purposes: [] })).toEqual([])
  })
  it('keeps legacy inferred media presets and the existing unknown text alias compatibility', () => {
    expect(workshopModelMappingModels('image', { models })).toEqual(['gpt-image-1'])
    expect(workshopModelMappingModels('video', { models })).toEqual(['grok-imagine-video'])
    expect(workshopModelMappingModels('text', { models })).toEqual(['gpt-4o-mini', 'relay-unknown-alias'])
    expect(workshopModelMappingModels('video', { models: ['whisper-1', ...models], purposes: ['video'] })).toEqual(['grok-imagine-video', 'relay-unknown-alias'])
    expect(workshopModelMappingModels('image', { models, purposes: ['video'] })).toEqual([])
  })
  it('uses the same purpose checks for offered sources and atomic plan validation', () => {
    const input = fixture([node('image'), node('video', 'video-generate'), node('text', 'text-generate')])
    input.groups = [{ name: 'mixed', description: '本人多用途', ratio: 1, connectionStatus: 'ready', purposes: ['image', 'video', 'text'] }]
    input.catalog = { mixed: { state: 'ready', models, purposes: ['image', 'video', 'text'] } }
    const source = buildWorkshopModelMapping(input).sources[0]
    expect(source.purposes).toEqual(['image', 'video', 'text'])
    expect(workshopModelMappingModels('image', source)).toEqual(['gpt-image-1', 'relay-unknown-alias'])
    for (const [id, model] of [['image', 'gpt-4o-mini'], ['image', 'grok-imagine-video'], ['video', 'gpt-4o-mini'], ['video', 'gpt-image-1'], ['text', 'gpt-image-1'], ['text', 'grok-imagine-video']]) {
      expect(() => planWorkshopModelMapping({ ...input, choices: [choice(input, id, 'mixed', model)] })).toThrow('用途不匹配')
    }
    const plan = planWorkshopModelMapping({ ...input, choices: [choice(input, 'image', 'mixed', 'gpt-image-1'), choice(input, 'video', 'mixed', 'grok-imagine-video'), choice(input, 'text', 'mixed', 'gpt-4o-mini')] })
    expect(plan.changedNodeIds).toEqual(['image', 'video', 'text'])
    expect(plan.nodes.map((entry) => entry.data.model)).toEqual(['gpt-image-1', 'grok-imagine-video', 'gpt-4o-mini'])
    expect(planWorkshopModelMapping({ ...input, choices: [choice(input, 'video', 'mixed', 'relay-unknown-alias')] }).changedNodeIds).toEqual(['video'])
  })
})

describe('workshop model mapping exact scope and source choices', () => {
  it('separates inheritance, fixed routes and purposes while combining matching image kinds', () => {
    const input = fixture([node('a'), node('b', 'image-edit'), node('fixed', 'image-generate', 'images-a'), node('video', 'video-generate', undefined, 'old-image'), node('text', 'text-generate', undefined, 'same-text'), node('parse', 'drama-parse', undefined, 'same-text'), node('prompt', 'prompt')])
    const rows = buildWorkshopModelMapping(input).rows
    expect(rows).toHaveLength(4)
    expect(row(input)).toMatchObject({ purpose: 'image', originalModel: 'old-image', originalGroupLabel: '继承画布默认来源', nodeIds: ['a', 'b'], nodeTitles: ['标题 a', '标题 b'] })
    expect(Object.hasOwn(row(input), 'originalGroup')).toBe(false)
    expect(row(input, 'fixed')).toMatchObject({ originalGroup: 'images-a', originalGroupLabel: '本人图片 A', nodeIds: ['fixed'] })
    expect(row(input, 'video').purpose).toBe('video')
    expect(row(input, 'text').nodeIds).toEqual(['text', 'parse'])
    expect(rows.every((entry) => entry.id.length > 0)).toBe(true)
    expect(new Set(rows.map((entry) => entry.id)).size).toBe(4)
  })
  it('never includes execution-only upstreams, outside nodes or group children not explicitly supplied', () => {
    const group = node('group', 'group'), child = { ...node('child'), parentId: 'group' }, upstream = node('upstream', 'text-generate'), outside = node('outside')
    const input = fixture([upstream, group, child, outside], ['child'])
    expect(buildWorkshopModelMapping(input).rows.map((entry) => entry.nodeIds)).toEqual([['child']])
    const plan = planWorkshopModelMapping({ ...input, choices: [choice(input, 'child')] })
    expect(plan.changedNodeIds).toEqual(['child'])
    expect(plan.nodes[0]).toBe(upstream); expect(plan.nodes[1]).toBe(group); expect(plan.nodes[3]).toBe(outside)
    expect(buildWorkshopModelMapping({ ...input, nodeIds: ['group'] }).rows).toEqual([])
  })
  it('keeps unavailable original sources repairable without replacing them before an explicit choice', () => {
    const input = fixture(), original = structuredClone(input.nodes), missing = row(input, 'c')
    expect(missing).toMatchObject({ originalGroup: 'old-private', originalGroupLabel: '原来源不可用' })
    expect(missing.blockedReason).toBeUndefined()
    expect(planWorkshopModelMapping({ ...input, choices: [] }).changes).toEqual([])
    expect(input.nodes).toEqual(original)
    const plan = planWorkshopModelMapping({ ...input, choices: [choice(input, 'c', 'images-b', 'gpt-image-2')] })
    expect(plan.changes).toEqual([{ nodeId: 'c', beforeGroup: 'old-private', beforeModel: 'old-image', group: 'images-b', model: 'gpt-image-2' }])
    expect(plan.nodes[0]).toBe(input.nodes[0]); expect(plan.nodes[1]).toBe(input.nodes[1])
  })
  it('offers only owned saved ready catalogs and intersects declared purposes', () => {
    const input = fixture()
    input.groups = [...input.groups, { name: 'pending', description: '', ratio: 1, connectionStatus: 'ready' }, { name: 'failed', description: '', ratio: 1, connectionStatus: 'failed' }, { name: 'untested', description: '', ratio: 1, connectionStatus: 'untested' }, { name: 'incompatible', description: '', ratio: 1, connectionStatus: 'ready', purposes: ['image'] }, { name: 'missing', description: '', ratio: 1 }]
    input.catalog = { ...input.catalog, pending: { state: 'pending', models: ['gpt-image-1'] }, failed: { state: 'ready', models: ['gpt-image-1'] }, untested: { state: 'ready', models: ['gpt-image-1'] }, incompatible: { state: 'ready', models: ['gpt-image-1'], purposes: ['text'] }, orphan: { state: 'ready', models: ['gpt-image-1'], purposes: ['image'] } }
    const result = buildWorkshopModelMapping(input)
    expect(result.sources.map((entry) => entry.group)).toEqual(['images-a', 'images-b', 'videos', 'text', 'legacy'])
    expect(result.sources[0]).toMatchObject({ group: 'images-a', label: '本人图片 A', revision: 2, purposes: ['image'] })
    const legacy = result.sources.find((entry) => entry.group === 'legacy')!
    expect(legacy.purposes).toBeUndefined()
    expect(availableModelsForKind('image', legacy.models, legacy.purposes)).toEqual(['gpt-image-1'])
    expect(availableModelsForKind('video', legacy.models, legacy.purposes)).toEqual(['grok-imagine-video'])
    expect(availableModelsForKind('text', legacy.models, legacy.purposes)).toEqual(['gpt-4.1-mini'])
    expect(planWorkshopModelMapping({ ...input, choices: [choice(input, 'a', 'images-a', 'relay-image-alias')] }).changedNodeIds).toEqual(['a', 'b'])
  })
  it('does not treat prototype catalog entries as saved sources', () => {
    const input = fixture(), catalog: CanvasNodeSourceCatalog = Object.create({ 'images-a': { state: 'ready', models: ['gpt-image-1'], purposes: ['image'] } })
    expect(buildWorkshopModelMapping({ ...input, catalog }).sources).toEqual([])
  })
  it.each(['missing-id', 'duplicate-scope', 'duplicate-node'])('rejects an ambiguous or stale scope: %s', (mode) => {
    const input = fixture()
    if (mode === 'missing-id') input.nodeIds = ['a', 'gone']
    if (mode === 'duplicate-scope') input.nodeIds = ['a', 'a']
    if (mode === 'duplicate-node') input.nodes = [input.nodes[0], input.nodes[0]]
    expect(() => buildWorkshopModelMapping(input)).toThrow()
  })
})

describe('workshop model mapping immutable patches', () => {
  it('changes mixed image, video and text routes once without resetting parameters, candidates, outputs or projections', () => {
    const input = fixture([node('i', 'image-edit'), node('v', 'video-generate'), node('t', 'text-generate'), node('outside')], ['i', 'v', 't']), before = structuredClone(input.nodes)
    const plan = planWorkshopModelMapping({ ...input, choices: [choice(input, 'i', 'images-b', 'gpt-image-2'), choice(input, 'v', 'videos', 'grok-imagine-video'), choice(input, 't', 'text', 'gpt-4.1-mini')] })
    expect(plan.changedNodeIds).toEqual(['i', 'v', 't']); expect(plan.changes).toHaveLength(3)
    expect(plan.nodes).toHaveLength(input.nodes.length)
    for (let index = 0; index < 3; index++) {
      const { group: _group, model: _model, ...data } = plan.nodes[index].data
      const { model: _oldModel, ...original } = before[index].data
      expect(data).toEqual(original)
      expect(plan.nodes[index].data.settings).toBe(input.nodes[index].data.settings)
      expect(plan.nodes[index].data.result).toBe(input.nodes[index].data.result)
      expect(plan.nodes[index].data.candidateAssetIds).toBe(input.nodes[index].data.candidateAssetIds)
      expect(plan.nodes[index].data.status).toBe('success'); expect(plan.nodes[index].data.dirty).toBe(false)
      expect(plan.nodes[index].position).toBe(input.nodes[index].position)
      expect(Object.hasOwn(plan.changes[index], 'beforeGroup')).toBe(false)
    }
    expect(plan.nodes[3]).toBe(input.nodes[3]); expect(input.nodes).toEqual(before)
  })
  it('does not manufacture a change for an exact fixed pair and leaves unselected rows untouched', () => {
    const input = fixture([node('a', 'image-generate', 'images-a', 'gpt-image-1'), node('b')])
    const plan = planWorkshopModelMapping({ ...input, choices: [choice(input)] })
    expect(plan.changes).toEqual([]); expect(plan.changedNodeIds).toEqual([])
    expect(plan.nodes[0]).toBe(input.nodes[0]); expect(plan.nodes[1]).toBe(input.nodes[1])
  })
  it.each(['unknown-row', 'duplicate-row', 'foreign-group', 'wrong-purpose', 'missing-model', 'known-wrong-text-model', 'extra-field'])('rejects the entire invalid selection without mutating inputs: %s', (mode) => {
    const input = fixture(), before = structuredClone(input.nodes), selected = choice(input)
    if (mode === 'unknown-row') selected.rowId = 'not-a-current-row'
    if (mode === 'foreign-group') selected.group = 'not-owned'
    if (mode === 'wrong-purpose') { selected.group = 'videos'; selected.model = 'grok-imagine-video' }
    if (mode === 'missing-model') selected.model = 'not-in-saved-catalog'
    if (mode === 'known-wrong-text-model') { selected.group = 'legacy'; selected.model = 'gpt-4.1-mini' }
    if (mode === 'extra-field') Reflect.set(selected, 'automatic', true)
    expect(() => planWorkshopModelMapping({ ...input, choices: mode === 'duplicate-row' ? [selected, selected] : [selected] })).toThrow()
    expect(input.nodes).toEqual(before)
  })
  it.each(['group-revision', 'source-removed', 'source-pending', 'model-removed', 'original-model', 'original-source', 'scope-member'])('rejects stale choices after a live snapshot change: %s', (mode) => {
    const input = fixture(), selected = choice(input)
    if (mode === 'group-revision') input.groups = input.groups.map((entry) => entry.name === 'images-a' ? { ...entry, revision: 3 } : entry)
    if (mode === 'source-removed') input.groups = input.groups.filter((entry) => entry.name !== 'images-a')
    if (mode === 'source-pending') input.catalog = { ...input.catalog, 'images-a': { ...input.catalog['images-a'], state: 'pending' } }
    if (mode === 'model-removed') input.catalog = { ...input.catalog, 'images-a': { ...input.catalog['images-a'], models: [] } }
    if (mode === 'original-model') input.nodes = input.nodes.map((entry) => entry.id === 'a' ? { ...entry, data: { ...entry.data, model: 'changed' } } : entry)
    if (mode === 'original-source') input.nodes = input.nodes.map((entry) => entry.id === 'a' ? { ...entry, data: { ...entry.data, group: 'images-b' } } : entry)
    if (mode === 'scope-member') input.nodeIds = ['a', 'c']
    expect(() => planWorkshopModelMapping({ ...input, choices: [selected] })).toThrow('变化')
  })
})

describe('workshop model mapping mutation fences', () => {
  it.each(['locked', 'data-locked', 'draggable', 'disabled', 'data-disabled', 'running', 'queued'])('blocks a directly protected row: %s', (mode) => {
    const target = node('a')
    if (mode === 'locked') target.locked = true
    if (mode === 'data-locked') target.data.settings = { locked: true }
    if (mode === 'draggable') Reflect.set(target, 'draggable', false)
    if (mode === 'disabled') target.disabled = true
    if (mode === 'data-disabled') target.data.settings = { disabled: true }
    if (mode === 'running' || mode === 'queued') target.data.status = mode
    const input = fixture([target]);expect(row(input).blockedReason).toBeTruthy()
    expect(() => planWorkshopModelMapping({ ...input, choices: [choice(input)] })).toThrow(row(input).blockedReason)
  })
  it.each(['locked', 'disabled', 'running', 'queued'])('blocks a protected ancestor without requiring that ancestor in the exact mapping scope: %s', (mode) => {
    const group = node('outer', 'group'), inner = { ...node('inner', 'group'), parentId: group.id }, target = { ...node('a'), parentId: inner.id }
    if (mode === 'locked') group.locked = true
    else if (mode === 'disabled') group.disabled = true
    else group.data.status = mode
    const input = fixture([group, inner, target], ['a']);expect(row(input).blockedReason).toContain('所属分组')
    expect(() => planWorkshopModelMapping({ ...input, choices: [choice(input)] })).toThrow()
  })
  it.each(['missing', 'wrong-parent-kind', 'cycle'])('rejects an unverifiable ancestor chain: %s', (mode) => {
    const parent = node('parent', mode === 'wrong-parent-kind' ? 'prompt' : 'group'), child = { ...node('a'), parentId: parent.id }
    if (mode === 'cycle') parent.parentId = child.id
    const input = fixture(mode === 'missing' ? [child] : [parent, child], ['a']);expect(row(input).blockedReason).toContain('分组')
    expect(() => planWorkshopModelMapping({ ...input, choices: [choice(input)] })).toThrow()
  })
  it('rechecks lock state when applying an earlier unblocked choice', () => {
    const input = fixture(), selected = choice(input);input.nodes = input.nodes.map((entry) => entry.id === 'a' ? { ...entry, locked: true } : entry)
    expect(() => planWorkshopModelMapping({ ...input, choices: [selected] })).toThrow('锁定')
  })
})
