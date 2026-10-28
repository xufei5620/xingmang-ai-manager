import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { sanitizeWorkshopWorkflow } from './workshop-sanitizer'
import { graphHasNodeMediaSource, projectHasNodeMediaSource, assertNodeMediaSourceClientVersion, assertNodeMediaSourceWorkflow, assertNodeMediaSourceRun } from './node-model-source-contract'
function workflow(group: unknown) { return { nodes: [{ id: 'image', kind: 'image-generate', data: { model: 'pinned-model', group } }] } }
describe('fixed node model source contract', () => {
  it.each([null, false, 0, '', 'owned-source', { future: 2 }])('protects fixed source presence %# even when malformed', (group) => {
    const raw = workflow(group)
    expect(graphHasNodeMediaSource(raw)).toBe(true); expect(projectHasNodeMediaSource(JSON.stringify(raw))).toBe(true)
    for (const version of [undefined, null, false, 0, 3]) expect(() => assertNodeMediaSourceWorkflow(JSON.stringify(raw), version)).toThrow('刷新')
    if (group !== 'owned-source') expect(() => assertNodeMediaSourceWorkflow(JSON.stringify(raw), 1)).toThrow('格式无效')
  })
  it('does not classify default mediaGroups, passive text, group nodes or ordinary immutable run graph fields as a new project format', () => {
    for (const raw of [{ mediaGroups: { image: 'default' }, nodes: [{ id: 'image', kind: 'image-generate', data: { model: 'm' } }] }, { nodes: [{ id: 'text', kind: 'text', data: { group: 'not-a-source', model: '' } }] }, { nodes: [{ id: 'g', kind: 'group', data: { group: 'not-a-source' } }] }]) {
      expect(graphHasNodeMediaSource(raw)).toBe(false); expect(() => assertNodeMediaSourceWorkflow(JSON.stringify(raw), undefined)).not.toThrow()
    }
    expect(() => assertNodeMediaSourceClientVersion(3, false)).toThrow()
    expect(() => projectHasNodeMediaSource('{')).toThrow()
  })
  it('compares only in-scope saved fixed nodes and never substitutes global source or model', () => {
    const content = JSON.stringify(workflow('owned-source'))
    const graph = { nodes: [{ id: 'image', data: { model: 'pinned-model', group: 'owned-source' } }] }
    expect(() => assertNodeMediaSourceRun(content, graph, ['image'])).not.toThrow()
    for (const data of [{ model: 'pinned-model', group: 'global-source' }, { model: 'global-model', group: 'owned-source' }, { model: 'pinned-model' }]) expect(() => assertNodeMediaSourceRun(content, { nodes: [{ id: 'image', data }] }, ['image'])).toThrow('已保存工程不一致')
    expect(() => assertNodeMediaSourceRun(content, { nodes: [{ id: 'image', data: { model: 'global', group: 'global' } }] }, ['another'])).not.toThrow()
  })
})


describe('fixed source raw persistence boundary', () => {
  function mediaWorkflow(): WorkflowFile { return { ...createEmptyWorkflow('Fixed source'), nodes: [{ id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'scene', model: 'image-model', group: 'owned-source', status: 'idle' } }] } }
  it.each([null, false, 0, '', ' ', { future: 2 }])('rejects raw malformed fixed source %# before projection', (group) => {
    const raw = mediaWorkflow(); Object.assign(raw.nodes[0].data, { group })
    expect(() => toPersistedWorkflowV2(raw)).toThrow('固定模型来源')
    expect(sanitizeWorkflowV2(raw)).toBeNull()
    expect(() => sanitizeWorkshopWorkflow(raw, 'node', 'Reusable')).toThrow('固定模型来源')
    const mixed = mediaWorkflow(); mixed.nodes.push({ ...raw.nodes[0], id: 'second' })
    expect(sanitizeWorkflowV2(mixed)).toBeNull()
  })
  it('retains valid owner fixed routes and requires explicit default source before workshop reuse', () => {
    const raw = mediaWorkflow(); const saved = toPersistedWorkflowV2(raw)
    expect(saved.nodes[0].data.group).toBe('owned-source')
    expect(sanitizeWorkflowV2(saved)?.workflow.nodes[0].data.group).toBe('owned-source')
    expect(() => sanitizeWorkshopWorkflow(raw, 'node', 'Reusable')).toThrow('使用画布默认来源')
    delete raw.nodes[0].data.group
    expect(sanitizeWorkflowV2(toPersistedWorkflowV2(raw))?.workflow.nodes[0].data.group).toBeUndefined()
  })
})
