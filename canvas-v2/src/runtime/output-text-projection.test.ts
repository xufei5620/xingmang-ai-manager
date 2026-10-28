import { describe, expect, it } from 'vitest'
import type { CanvasRunCandidate, CanvasRunRecord } from '../host'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowNode } from '../model'
import { latestGeneratedOutputText, projectRunRecordToNodes } from './run-projection'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'

const at = '2026-10-15T16:00:00.000Z', assetId = 'a'.repeat(43)
const asset = { kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}` }
function node(): WorkflowNode { return { id: 'output', kind: 'output', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'output instructions', model: '', status: 'idle', dirty: true } } }
function run(text = '  完整正文\n\n'): CanvasRunRecord {
  return { version: 1, runId: 'run', userId: 1, ownerId: 1, graphRevision: 'revision', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at, nodes: [{ nodeId: 'output', kind: 'output', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: 'fingerprint', state: 'succeeded', cached: false, startedAt: at, completedAt: at, durationMs: 10, candidates: [], outputText: text }] }], events: [] }
}
function candidate(): CanvasRunCandidate { return { candidateId: 'candidate', attemptId: 'attempt', createdAt: at, asset } }
function restore(value: WorkflowNode): WorkflowNode {
  const workflow = { ...createEmptyWorkflow(), nodes: [value] }
  return parseWorkflowFile(serializeWorkflow(workflow))!.nodes[0]
}

describe('output node text result projection and persistence', () => {
  it('projects actual output text separately from the input and preserves exact prose on reopen', () => {
    const result = projectRunRecordToNodes([node()], run())[0]
    expect(result.data).toMatchObject({ outputText: '  完整正文\n\n', prompt: 'output instructions', status: 'succeeded', dirty: false })
    expect(restore(result).data).toMatchObject({ outputText: '  完整正文\n\n', prompt: 'output instructions', status: 'succeeded' })
  })
  it('keeps original output and marks it stale on failure or input mismatch', () => {
    const previous = { ...node(), data: { ...node().data, outputText: 'previous result', result: asset } }
    const failed = run('failed partial text'); failed.status = 'failed'; failed.nodes[0].state = 'failed'; failed.nodes[0].attempts[0].state = 'failed'
    expect(latestGeneratedOutputText(failed.nodes[0])).toBeUndefined()
    expect(projectRunRecordToNodes([previous], failed)[0].data).toMatchObject({ outputText: 'previous result', result: asset, dirty: true })
    expect(projectRunRecordToNodes([previous], run('new late result'), [], new Set())[0].data).toMatchObject({ outputText: 'previous result', result: asset, dirty: true })
  })
  it('replays cached text without replacing input and supports both text and media in one output', () => {
    const cached = run(); cached.nodes[0].state = 'cached'; cached.nodes[0].attempts[0].state = 'cached'; cached.nodes[0].attempts[0].cached = true; cached.nodes[0].attempts[0].candidates = [candidate()]
    const result = projectRunRecordToNodes([node()], cached)[0]
    expect(result.data).toMatchObject({ outputText: '  完整正文\n\n', result: asset, fromCache: true })
    expect(restore(result).data).toMatchObject({ outputText: '  完整正文\n\n', result: asset })
  })
  it('does not present previous media as a new text-only output', () => {
    const previous = { ...node(), data: { ...node().data, outputText: 'old', result: asset, candidates: [candidate()], candidateAssetIds: [assetId], adoptedCandidateId: 'candidate', selectedCandidateId: 'candidate' } }
    const current = run('new text')
    current.nodes[0].attempts.unshift({ ...current.nodes[0].attempts[0], attemptId: 'earlier', candidates: [candidate()], outputText: 'old mixed result' })
    const result = projectRunRecordToNodes([previous], current)[0]
    expect(result.data.outputText).toBe('new text')
    for (const field of ['result', 'candidates', 'candidateAssetIds', 'adoptedCandidateId', 'selectedCandidateId']) expect(result.data[field as keyof typeof result.data]).toBeUndefined()
    expect(restore(result).data.result).toBeUndefined()
  })
  it('clears prior text on successful media-only output while preserving the fresh asset', () => {
    const previous = { ...node(), data: { ...node().data, outputText: 'old prose' } }, current = run('')
    current.nodes[0].attempts[0].candidates = [candidate()]
    const result = projectRunRecordToNodes([previous], current)[0]
    expect(result.data.outputText).toBe('')
    expect(result.data.result).toEqual(asset)
    expect(restore(result).data.outputText).toBeUndefined()
  })
  it('retains full supported output length and rejects malformed imported output without altering input', () => {
    const current = projectRunRecordToNodes([node()], run('长'.repeat(32_000)))[0]
    expect(restore(current).data.outputText).toBe('长'.repeat(32_000))
    const persisted = toPersistedWorkflowV2({ ...createEmptyWorkflow(), nodes: [current] })
    persisted.nodes[0].data.outputText = '长'.repeat(32_001)
    expect(sanitizeWorkflowV2(persisted)).toBeNull()
    expect(current.data.prompt).toBe('output instructions')
  })
})
