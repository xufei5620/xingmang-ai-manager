import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { canvasMediaPurposePreparationSignature, canvasPendingMediaKinds, mergeCanvasMediaPreparationDefaults, pendingCanvasMediaRunKinds, unavailableCanvasMediaRunGroups } from './media-progress-scope'

function graph(): CanvasRunGraph {
  return {
    nodes: [
      { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'image', model: 'gpt-image-1', group: 'good' } },
      { id: 'video', kind: 'video-generate', definitionVersion: 1, data: { prompt: 'video', model: 'grok-imagine-video', group: 'slow' } },
    ],
    edges: [],
  }
}

describe('canvas media progress admission', () => {
  const groups = [{ name: 'good', description: '', ratio: 1, revision: 1, purposes: ['image' as const] }, { name: 'slow', description: '', ratio: 1, revision: 1, purposes: ['video' as const] }]
  const selected = { image: 'good', video: 'slow' }
  const project = { projectEpoch: 1, projectId: 'project-a' }
  function signatures() {
    return {
      image: canvasMediaPurposePreparationSignature('image', selected, groups, 1, project),
      video: canvasMediaPurposePreparationSignature('video', selected, groups, 1, project),
    }
  }
  it('keeps a healthy purpose ready while an unrelated source is pending', () => {
    expect(canvasPendingMediaKinds({ selected, groups, legacyReadRevision: 1, ...project, settledSignatures: signatures(), pendingKinds: ['video'] })).toEqual(['video'])
  })
  it('invalidates only the changed catalog purpose before an effect runs', () => {
    const changed = groups.map((group) => group.name === 'slow' ? { ...group, revision: 2 } : group)
    expect(canvasPendingMediaKinds({ selected, groups: changed, legacyReadRevision: 2, ...project, settledSignatures: signatures(), pendingKinds: [] })).toEqual(['video'])
  })
  it('invalidates a new selected source and a foreign project epoch', () => {
    expect(canvasPendingMediaKinds({ selected: { ...selected, image: 'replacement' }, groups, legacyReadRevision: 1, ...project, settledSignatures: signatures(), pendingKinds: [] })).toEqual(['image'])
    expect(canvasPendingMediaKinds({ selected, groups, legacyReadRevision: 1, projectEpoch: 2, projectId: 'project-b', settledSignatures: signatures(), pendingKinds: [] })).toEqual(['image', 'video'])
  })
  it('requires fresh reads after returning to a previously ready selection whose snapshots were cleared', () => {
    expect(canvasPendingMediaKinds({ selected, groups, legacyReadRevision: 1, ...project, settledSignatures: {}, pendingKinds: [] })).toEqual(['image', 'video'])
  })
  it('blocks only paid purposes involved in the selected chain', () => {
    const preflight = buildCanvasRunPreflight({ graph: graph(), scope: { kind: 'to-node', nodeId: 'image' }, imageModels: ['gpt-image-1'], videoModels: [] })
    expect(pendingCanvasMediaRunKinds(preflight, ['video'])).toEqual([])
    expect(pendingCanvasMediaRunKinds(preflight, ['image', 'video'])).toEqual(['image'])
  })
  it('does not trust pinned paid outputs as source validation', () => {
    const preflight = buildCanvasRunPreflight({ graph: graph(), scope: { kind: 'all' }, cachedNodeIds: ['image', 'video'], imageModels: ['gpt-image-1'], videoModels: [] })
    expect(pendingCanvasMediaRunKinds(preflight, ['video'])).toEqual(['video'])
  })
  it('ignores a disabled upstream and its skipped paid descendants', () => {
    const current = graph()
    current.nodes.unshift({ id: 'disabled', kind: 'prompt', definitionVersion: 1, disabled: true, data: { prompt: 'disabled', model: '' } })
    current.edges.push({ id: 'skip-video', source: 'disabled', target: 'video', sourceHandle: 'out:text', targetHandle: 'in:text' })
    const preflight = buildCanvasRunPreflight({ graph: current, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] })
    expect(pendingCanvasMediaRunKinds(preflight, ['video'])).toEqual([])
    expect(unavailableCanvasMediaRunGroups(preflight, [groups[0]])).toEqual([])
    expect(preflight.canStart).toBe(true)
  })
  it('includes blocked active sources in pending and missing-source checks', () => {
    const preflight = buildCanvasRunPreflight({ graph: graph(), scope: { kind: 'all' }, imageModels: ['gpt-image-1'], videoModels: [] })
    expect(unavailableCanvasMediaRunGroups(preflight, [groups[0]])).toEqual(['slow'])
  })
  it('invalidates a different project id even at the same epoch', () => {
    expect(canvasPendingMediaKinds({ selected, groups, legacyReadRevision: 1, ...project, projectId: 'project-b', settledSignatures: signatures(), pendingKinds: [] })).toEqual(['image', 'video'])
  })
  it('invalidates a legacy catalog reread without provider revisions', () => {
    const legacyGroups = groups.map(({ revision: _revision, ...group }) => group)
    const settledSignatures = { image: canvasMediaPurposePreparationSignature('image', selected, legacyGroups, 1, project), video: canvasMediaPurposePreparationSignature('video', selected, legacyGroups, 1, project) }
    expect(canvasPendingMediaKinds({ selected, groups: legacyGroups, legacyReadRevision: 2, ...project, settledSignatures, pendingKinds: [] })).toEqual(['image', 'video'])
  })
  it.each(['failed', 'withdrawn'] as const)('invalidates same-id sources with %s metadata', (state) => {
    const changed = groups.map((group) => group.name === 'good' ? state === 'failed' ? { ...group, connectionStatus: 'failed' as const } : { ...group, purposes: [] } : group)
    expect(canvasPendingMediaKinds({ selected, groups: changed, legacyReadRevision: 1, ...project, settledSignatures: signatures(), pendingKinds: [] })).toEqual(['image'])
  })
  it('includes paid upstream dependencies in selected scope admission', () => {
    const current = graph()
    current.edges.push({ id: 'video-image', source: 'video', target: 'image', sourceHandle: 'out:video', targetHandle: 'in:image' })
    const preflight = buildCanvasRunPreflight({ graph: current, scope: { kind: 'selection', nodeIds: ['image'] }, imageModels: ['gpt-image-1'], videoModels: [] })
    expect(pendingCanvasMediaRunKinds(preflight, ['video'])).toEqual(['video'])
  })
  it('fills empty defaults without overwriting choices made during reading', () => {
    expect(mergeCanvasMediaPreparationDefaults({ image: 'good', imageModel: 'chosen', video: 'new' }, { image: 'good', imageModel: 'default', video: 'old', videoModel: 'old-model', text: 'text', textModel: 'text-model' }))
      .toEqual({ image: 'good', imageModel: 'chosen', video: 'new', text: 'text', textModel: 'text-model' })
  })
})
