import { awaitingCanvasFixedVideoSources, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasGroupSummary, CanvasRunEvent, CanvasRunGraph, CanvasRunRecord } from '../host'
import type { WorkflowNode } from '../model'
import { canvasRunStatusLabel, mergeCanvasRunEvent } from './run-events'
import { matchingCanvasRunNodeIds, matchingRunRecordNodes } from './run-input-matching'
import { autoFixedDownstreamNodeIds, projectRunRecordToNodes } from './run-projection'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const callbacks = new Map<string, string>()
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === 'useCallback') callbacks.set(node.name.getText(source), node.initializer.arguments[0].getText(source))
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'onRunEvent') callbacks.set('runEvent', node.arguments[0].getText(source))
  if (ts.isFunctionExpression(node) && node.name?.text === 'retryPendingRunProjectionAfterCatalog') callbacks.set(node.name.text, node.getText(source))
  if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'changed' && node.initializer.getText(source).includes('setGroupsLoaded')) callbacks.set('catalogReceived', node.initializer.getText(source))
  ts.forEachChild(node, visit)
}
visit(source)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  const expression = callbacks.get(name)
  if (!expression) throw new Error(`Missing App callback ${name}`)
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as T
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function record(runId = 'run-1', status: CanvasRunRecord['status'] = 'running'): CanvasRunRecord {
  return { version: 1, runId, userId: 1, ownerId: 1, projectId: 'project-1', graphRevision: 'graph-1', scope: { kind: 'all' }, status, createdAt: '2026-10-14T12:00:00.000Z', startedAt: '2026-10-14T12:00:00.000Z', nodes: [], events: [] }
}
function terminal(runId = 'run-1'): CanvasRunEvent { return { version: 1, type: 'run-terminal', runId, graphRevision: 'graph-1', sequence: 2, at: '2026-10-14T12:00:02.000Z', status: 'succeeded', outcome: { succeeded: [], failed: [], skipped: [], cached: [], cancelled: [] } } }
const waitingMessage = '正在处理图像并保存素材，完成后会继续原工作流'
function fixture(options: { submitted?: CanvasRunGraph; nodes?: WorkflowNode[]; groupsLoaded?: boolean } = {}) {
  const reads: Array<ReturnType<typeof deferred<CanvasRunRecord[]>>> = [], refreshes: Promise<void>[] = []
  const listRuns = vi.fn(() => { const pending = deferred<CanvasRunRecord[]>(); reads.push(pending); return pending.promise })
  let banner: string | null = null, records: CanvasRunRecord[] = [record()]
  const setBanner = vi.fn((value: string | null | ((previous: string | null) => string | null)) => { banner = typeof value === 'function' ? value(banner) : value })
  const setRunRecords = vi.fn((value: CanvasRunRecord[] | ((previous: CanvasRunRecord[]) => CanvasRunRecord[])) => { records = typeof value === 'function' ? value(records) : value })
  const activeRunsRef = { current: new Map([['run-1', { graphRevision: 'graph-1', projectId: 'project-1' }]]) }
  const runWaitingBannerRef: { current: { runId: string; graphRevision: string; message: string } | null } = { current: null }
  const projectEpochRef = { current: 1 }, activeProjectIdRef = { current: 'project-1' }, runsRequestRevisionRef = { current: 0 }
  let nodes = options.nodes ?? [], dirtyNodeIds = new Set(nodes.filter((node) => node.data.dirty).map((node) => node.id))
  const submitted = options.submitted ?? { nodes: [], edges: [] }, graph = { nodes, edges: [] }, graphRef = { current: graph }, pendingRunProjectionIdsRef = { current: new Set(['run-1']) }, runInputGraphsRef = { current: new Map([['run-1', submitted]]) }
  const groupsLoadedRef = { current: options.groupsLoaded ?? true }, groupsRef = { current: [] as CanvasGroupSummary[] }, runGroupsRef = { current: { video: 'provider-a', videoProtocol: 'relay-videos' as 'relay-videos' | 'xai-native' } }
  const forgetActiveRun = vi.fn((runId: string) => activeRunsRef.current.delete(runId))
  const rememberActiveRun = vi.fn((entry: CanvasRunRecord) => { activeRunsRef.current.set(entry.runId, { graphRevision: entry.graphRevision, projectId: entry.projectId! }); pendingRunProjectionIdsRef.current.add(entry.runId) })
  const setRunsError = vi.fn(), setRunsLoading = vi.fn(), setSelectedRunId = vi.fn(), refreshAssets = vi.fn(), patchNodeData = vi.fn()
  const setNodes = vi.fn((update: (nodes: WorkflowNode[]) => WorkflowNode[]) => { nodes = update(nodes); graphRef.current = { ...graphRef.current, nodes } })
  const setDirtyNodeIds = vi.fn((update: (ids: Set<string>) => Set<string>) => { dirtyNodeIds = update(dirtyNodeIds) })
  function toCanvasRunGraph(current: WorkflowNode[], _edges: unknown, groups: typeof runGroupsRef.current, sourceCatalog: CanvasNodeSourceCatalog = {}): CanvasRunGraph {
    return { ...submitted, nodes: submitted.nodes.filter((original) => current.some((node) => node.id === original.id)).map((original) => {
      const group = current.find((node) => node.id === original.id)?.data.group
      return { ...original, data: { ...original.data, ...(['video', 'video-generate'].includes(original.kind) ? { videoProtocol: group !== undefined ? sourceCatalog[group]?.videoProtocol : groups.videoProtocol } : {}) } }
    }) }
  }
  const confirmedRunGroups = actual<() => typeof runGroupsRef.current>('confirmedRunGroups', { groupsRef, runGroupsRef })
  const nodeSourceCatalogRef: { current: CanvasNodeSourceCatalog } = { current: {} }
  const environment = { awaitingCanvasFixedVideoSources, nodeSourceCatalogRef, projectCanRunRef: { current: true }, hostBridge: () => ({ listRuns }), window: { xingmangCanvasHost: {}, setTimeout }, activeRunsRef, runWaitingBannerRef, projectEpochRef, activeProjectIdRef, runsRequestRevisionRef, graphRef, pendingRunProjectionIdsRef, runInputGraphsRef, groupsLoadedRef, groupsRef, runGroupsRef, confirmedRunGroups, setBanner, setRunRecords, forgetActiveRun, rememberActiveRun, setRunsError, setRunsLoading, setSelectedRunId, selectedRunId: 'run-1', setNodes, setDirtyNodeIds, matchingCanvasRunNodeIds, toCanvasRunGraph, matchingRunRecordNodes, projectRunRecordToNodes, autoFixedDownstreamNodeIds, isDramaAssetNodeType: () => false, canvasRunStatusLabel, mergeCanvasRunEvent, refreshAssets, patchNodeData, assetQuery: {} }
  const refresh = actual<(runId?: string) => Promise<void>>('refreshRuns', { ...environment, outputPlacementCoordinator: { accept: vi.fn() } })
  const refreshRuns = (runId?: string) => { const promise = refresh(runId); refreshes.push(promise); return promise }
  const event = actual<(event: CanvasRunEvent) => void>('runEvent', { ...environment, refreshRuns })
  function catalogChanged() {
    actual<() => void>('retryPendingRunProjectionAfterCatalog', { groupsLoaded: groupsLoadedRef.current, pendingRunProjectionIdsRef, refreshRunsRef: { current: refreshRuns } })()
  }
  function receiveCatalog(videoProtocol: 'relay-videos' | 'xai-native') {
    const changed = actual<(snapshot: { groups: CanvasGroupSummary[]; refreshing: boolean; error: null }) => void>('catalogReceived', {
      mediaPreparationMountedRef: { current: true }, draftActionsEnabledRef: { current: true }, groupsRef, groupsLoadedRef,
      setRefreshingGroups: vi.fn(), setGroupsError: vi.fn(), setGroups: vi.fn(), setGroupsLoaded: vi.fn(),
      catalogReadRevisionRef: { current: 0 }, setCatalogReadRevision: vi.fn(), mediaPreparationErrorsRef: { current: {} },
      mediaRetryRevisionRef: { current: 0 }, setMediaRetryRevision: vi.fn(),
    })
    // React setters deliberately do not commit a new render in this callback.
    changed({ groups: [{ name: 'provider-a', description: 'Video source', ratio: '—', videoProtocol }], refreshing: false, error: null })
  }
  function waiting(runId = 'run-1', type: 'image' | 'frame' | 'video' = 'image') {
    event({ version: 1, runId, graphRevision: 'graph-1', sequence: 1, at: '2026-10-14T12:00:01.000Z', type: 'run-waiting', waitingForVideo: type === 'video', framePreparations: [], ...(type === 'image' ? { imagePreparations: [{}] } : type === 'frame' ? { framePreparations: [{}] } : {}) } as CanvasRunEvent)
  }
  return { ...environment, reads, refreshes, refreshRuns, waiting, event, catalogChanged, receiveCatalog, banner: () => banner, records: () => records, nodes: () => nodes, dirtyNodeIds: () => dirtyNodeIds }
}

describe('actual App waiting notification reconciliation', () => {
  it('does not read, continue or project private run history in a collaborator view', async () => {
    const f = fixture(); f.projectCanRunRef.current = false; await f.refreshRuns()
    expect(f.reads).toEqual([]); expect(f.setNodes).not.toHaveBeenCalled(); expect(f.setDirtyNodeIds).not.toHaveBeenCalled()
  })
  it.each(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'] as const)('settles the waiting message when a durable %s record arrives before the terminal event', async (status) => {
    const f = fixture(); f.waiting()
    expect(f.banner()).toBe(waitingMessage)
    f.reads[0].resolve([record('run-1', status)]); await f.refreshes[0]
    expect(f.banner()).toBe(`运行结束：${canvasRunStatusLabel(status)}`)
    expect(f.activeRunsRef.current.size).toBe(0)
    expect(f.runWaitingBannerRef.current).toBeNull()
    expect(f.records()[0].status).toBe(status)
    expect(f.pendingRunProjectionIdsRef.current.size).toBe(0)
    f.event({ version: 1, type: 'run-terminal', runId: 'run-1', graphRevision: 'graph-1', sequence: 2, at: '2026-10-14T12:00:02.000Z', status, outcome: { succeeded: [], failed: [], skipped: [], cached: [], cancelled: [] } })
    f.waiting()
    expect(f.banner()).toBe(`运行结束：${canvasRunStatusLabel(status)}`)
    expect(f.refreshes).toHaveLength(1)
    expect(f.setRunsError).toHaveBeenCalledExactlyOnceWith(null)
  })

  it.each(['frame', 'video'] as const)('settles durable completion for %s preparation too', async (type) => {
    const f = fixture(); f.waiting('run-1', type)
    f.reads[0].resolve([record('run-1', 'succeeded')]); await f.refreshes[0]
    expect(f.banner()).toBe('运行结束：已完成')
  })

  it.each(['请核对恢复结果', null])('does not overwrite a later unrelated or dismissed notification: %s', async (message) => {
    const f = fixture(); f.waiting(); f.setBanner(message)
    f.reads[0].resolve([record('run-1', 'succeeded')]); await f.refreshes[0]
    expect(f.banner()).toBe(message)
    expect(f.runWaitingBannerRef.current).toBeNull()
  })

  it.each(['请核对恢复结果', null])('preserves newer or dismissed waiting notices when the terminal event wins: %s', async (message) => {
    const f = fixture(); f.waiting(); f.setBanner(message)
    f.event(terminal())
    expect(f.banner()).toBe(message)
    expect(f.runWaitingBannerRef.current).toBeNull()
    expect(f.activeRunsRef.current.has('run-1')).toBe(false)
    for (const pending of f.reads) pending.resolve([record('run-1', 'succeeded')])
    await Promise.all(f.refreshes)
    expect(f.banner()).toBe(message)
  })

  it('keeps another run waiting when a different terminal event arrives first', async () => {
    const f = fixture(); f.activeRunsRef.current.set('run-2', { graphRevision: 'graph-1', projectId: 'project-1' })
    f.waiting('run-1'); f.waiting('run-2'); f.event(terminal('run-1'))
    expect(f.banner()).toBe(waitingMessage)
    expect(f.runWaitingBannerRef.current?.runId).toBe('run-2')
    expect(f.activeRunsRef.current.has('run-1')).toBe(false)
    for (const pending of f.reads) pending.resolve([record('run-1', 'succeeded'), record('run-2')])
    await Promise.all(f.refreshes)
    expect(f.banner()).toBe(waitingMessage)
    expect(f.runWaitingBannerRef.current?.runId).toBe('run-2')
  })

  it('settles its own waiting notice and preserves ordinary completion when no waiting notice exists', async () => {
    for (const withWaiting of [false, true]) {
      const f = fixture()
      if (withWaiting) f.waiting()
      f.event(terminal())
      expect(f.banner()).toBe('运行结束：已完成')
      expect(f.runWaitingBannerRef.current).toBeNull()
      for (const pending of f.reads) pending.resolve([record('run-1', 'succeeded')])
      await Promise.all(f.refreshes)
      expect(f.banner()).toBe('运行结束：已完成')
    }
  })

  it('does not settle another concurrent run with the identical waiting text', async () => {
    const f = fixture(); f.activeRunsRef.current.set('run-2', { graphRevision: 'graph-1', projectId: 'project-1' })
    f.waiting('run-1'); f.waiting('run-2')
    f.reads[0].resolve([record('run-1', 'succeeded'), record('run-2')]); await f.refreshes[0]
    f.reads[1].resolve([record('run-1', 'succeeded'), record('run-2')]); await f.refreshes[1]
    expect(f.banner()).toBe(waitingMessage)
    expect(f.runWaitingBannerRef.current?.runId).toBe('run-2')
    expect(f.activeRunsRef.current.has('run-1')).toBe(false)
    expect(f.activeRunsRef.current.has('run-2')).toBe(true)
  })

  it('counts only other still-running tasks after reconciling the complete durable list', async () => {
    const f = fixture()
    for (const runId of ['run-2', 'run-3']) f.activeRunsRef.current.set(runId, { graphRevision: 'graph-1', projectId: 'project-1' })
    f.waiting()
    f.reads[0].resolve([record('run-1', 'succeeded'), record('run-2', 'cancelled'), record('run-3')]); await f.refreshes[0]
    expect(f.banner()).toBe('运行结束：已完成（还有 1 个任务在生成）')
  })

  it.each(['project', 'request'] as const)('ignores stale durable reads before mutating run membership or banner after %s changes', async (change) => {
    const f = fixture(); f.waiting()
    if (change === 'project') { f.projectEpochRef.current++; f.activeProjectIdRef.current = 'project-2' }
    else f.runsRequestRevisionRef.current++
    f.reads[0].resolve([record('run-1', 'succeeded')]); await f.refreshes[0]
    expect(f.banner()).toBe(waitingMessage)
    expect(f.activeRunsRef.current.has('run-1')).toBe(true)
    expect(f.forgetActiveRun).not.toHaveBeenCalled()
  })

  it('does not take a different graph revision as the owner of a waiting message', async () => {
    const f = fixture(); f.waiting()
    f.reads[0].resolve([{ ...record('run-1', 'succeeded'), graphRevision: 'another-graph' }]); await f.refreshes[0]
    expect(f.banner()).toBe(waitingMessage)
  })
})

const nativeAssetId = 'n'.repeat(43)
function nativeVideoFixture() {
  const node: WorkflowNode = {
    id: 'video', kind: 'video-generate', position: { x: 0, y: 0 },
    data: { prompt: 'a scene', model: 'grok-imagine-video', status: 'idle', result: { kind: 'video', assetId: 'o'.repeat(43), localUrl: '/api/assets/old/content' } },
  }
  const submitted: CanvasRunGraph = {
    nodes: [{ id: node.id, kind: node.kind, definitionVersion: 1, data: { prompt: node.data.prompt, model: node.data.model, group: 'provider-a', videoProtocol: 'xai-native', generateAudio: false } }], edges: [],
  }
  const completed: CanvasRunRecord = {
    ...record('run-1', 'succeeded'), nodes: [{ nodeId: node.id, kind: node.kind, state: 'succeeded', attempts: [{
      attemptId: 'native-attempt', fingerprint: 'native-fingerprint', state: 'succeeded', cached: false,
      startedAt: '2026-10-14T12:00:00.000Z', completedAt: '2026-10-14T12:00:02.000Z', durationMs: 2000, videoTaskId: 'native-task',
      candidates: [{ candidateId: 'native-candidate', attemptId: 'native-attempt', createdAt: '2026-10-14T12:00:02.000Z', asset: { kind: 'video', assetId: nativeAssetId, localUrl: `/api/assets/${nativeAssetId}/content`, taskId: 'native-task' } }],
    }] }],
  }
  return { ...fixture({ submitted, nodes: [node], groupsLoaded: false }), completed, originalNode: structuredClone(node) }
}

describe('actual App delayed video source catalog restoration', () => {
  it('waits for the pinned source independently of a ready but different project source before consuming the terminal snapshot', async () => {
    const f = nativeVideoFixture(); f.graphRef.current.nodes[0].data.group = 'provider-a'; f.receiveCatalog('relay-videos')
    const original = structuredClone(f.nodes()[0]), read = f.refreshRuns(); f.reads[0].resolve([f.completed]); await read
    expect(f.nodes()).toEqual([original]); expect(f.pendingRunProjectionIdsRef.current.has('run-1')).toBe(true)
    f.nodeSourceCatalogRef.current = { 'provider-a': { state: 'ready', models: ['grok-imagine-video'], videoProtocol: 'xai-native', purposes: ['video'] } }
    f.catalogChanged(); f.reads[1].resolve([f.completed]); await f.refreshes[1]
    expect(f.nodes()[0].data.result?.assetId).toBe(nativeAssetId); expect(f.pendingRunProjectionIdsRef.current.size).toBe(0)
    expect(f.runGroupsRef.current.videoProtocol).toBe('relay-videos')
  })
  it('uses the confirmed native catalog in the microtask before React commits the rendered protocol', async () => {
    const f = nativeVideoFixture(), read = f.refreshRuns()
    f.receiveCatalog('xai-native')
    expect(f.groupsLoadedRef.current).toBe(true)
    expect(f.groupsRef.current[0].videoProtocol).toBe('xai-native')
    expect(f.runGroupsRef.current.videoProtocol).toBe('relay-videos')
    f.event({ version: 1, type: 'node-state', runId: 'run-1', graphRevision: 'graph-1', sequence: 1, at: f.completed.startedAt, nodeId: 'video', state: 'succeeded' })
    expect(f.patchNodeData).toHaveBeenCalledWith('video', expect.objectContaining({ status: 'succeeded' }))
    f.reads[0].resolve([f.completed]); await read
    expect(f.nodes()[0].data.result?.assetId).toBe(nativeAssetId)
    expect(f.nodes()[0].data.dirty).toBe(false); expect(f.dirtyNodeIds().size).toBe(0)
    expect(f.banner()).toBeNull(); expect(f.pendingRunProjectionIdsRef.current.size).toBe(0)
  })

  it('rejects a genuine catalog protocol change before the old native render is committed again', async () => {
    const f = nativeVideoFixture()
    f.receiveCatalog('xai-native'); f.runGroupsRef.current.videoProtocol = 'xai-native'
    const read = f.refreshRuns()
    f.receiveCatalog('relay-videos')
    expect(f.runGroupsRef.current.videoProtocol).toBe('xai-native')
    f.event({ version: 1, type: 'node-state', runId: 'run-1', graphRevision: 'graph-1', sequence: 1, at: f.completed.startedAt, nodeId: 'video', state: 'succeeded' })
    expect(f.patchNodeData).not.toHaveBeenCalled()
    f.reads[0].resolve([f.completed]); await read
    expect(f.nodes()[0].data.result).toEqual(f.originalNode.data.result)
    expect(f.nodes()[0].data.dirty).toBe(true); expect(f.dirtyNodeIds().has('video')).toBe(true)
    expect(f.nodes()[0].data.candidateAssetIds).toContain(nativeAssetId)
    expect(f.banner()).toContain('输入已变化')
  })

  it('retains the original native result until the source is known, then adopts it without another generation', async () => {
    const f = nativeVideoFixture()
    f.event({ version: 1, type: 'node-state', runId: 'run-1', graphRevision: 'graph-1', sequence: 1, at: f.completed.startedAt, nodeId: 'video', state: 'succeeded' })
    expect(f.patchNodeData).not.toHaveBeenCalled()
    const read = f.refreshRuns(); f.reads[0].resolve([f.completed]); await read
    expect(f.records()).toEqual([f.completed])
    expect(f.pendingRunProjectionIdsRef.current.has('run-1')).toBe(true)
    expect(f.runInputGraphsRef.current.get('run-1')?.nodes[0].data.videoProtocol).toBe('xai-native')
    expect(f.nodes()).toEqual([f.originalNode])
    expect(f.setNodes).not.toHaveBeenCalled(); expect(f.setDirtyNodeIds).not.toHaveBeenCalled()
    expect(f.banner()).toBeNull()
    expect(f.setRunsError).toHaveBeenLastCalledWith('运行结果已保留，等待视频来源核对后回填；可刷新模型来源重试')

    f.receiveCatalog('xai-native'); f.runGroupsRef.current.videoProtocol = 'xai-native'
    f.catalogChanged(); expect(f.reads).toHaveLength(2)
    f.reads[1].resolve([f.completed]); await f.refreshes[1]
    expect(f.nodes()[0].data.result?.assetId).toBe(nativeAssetId)
    expect(f.nodes()[0].data.result?.taskId).toBe('native-task')
    expect(f.nodes()[0].data.dirty).toBe(false); expect(f.dirtyNodeIds().size).toBe(0)
    expect(f.pendingRunProjectionIdsRef.current.size).toBe(0); expect(f.runInputGraphsRef.current.size).toBe(0)
    expect(f.setRunsError).toHaveBeenLastCalledWith(null)
    f.catalogChanged(); expect(f.reads).toHaveLength(2)
  })

  it('still rejects adoption if the confirmed source really changed to relay', async () => {
    const f = nativeVideoFixture(), read = f.refreshRuns()
    f.reads[0].resolve([f.completed]); await read
    f.receiveCatalog('relay-videos')
    f.catalogChanged(); f.reads[1].resolve([f.completed]); await f.refreshes[1]
    expect(f.nodes()[0].data.result).toEqual(f.originalNode.data.result)
    expect(f.nodes()[0].data.dirty).toBe(true); expect(f.dirtyNodeIds().has('video')).toBe(true)
    expect(f.nodes()[0].data.candidateAssetIds).toContain(nativeAssetId)
    expect(f.records()).toEqual([f.completed])
    expect(f.banner()).toContain('输入已变化')
    expect(f.pendingRunProjectionIdsRef.current.size).toBe(0)
  })

  it('keeps a failed or unfinished catalog read pending instead of consuming the snapshot', async () => {
    const f = nativeVideoFixture(), read = f.refreshRuns()
    f.reads[0].resolve([f.completed]); await read
    f.catalogChanged(); f.catalogChanged()
    expect(f.reads).toHaveLength(1)
    expect(f.pendingRunProjectionIdsRef.current.has('run-1')).toBe(true)
    expect(f.runInputGraphsRef.current.has('run-1')).toBe(true)
    expect(f.nodes()).toEqual([f.originalNode])
  })

  it.each(['project', 'request'] as const)('rejects a delayed catalog retry after the %s epoch changes', async (change) => {
    const f = nativeVideoFixture(), read = f.refreshRuns()
    f.reads[0].resolve([f.completed]); await read
    f.receiveCatalog('xai-native'); f.runGroupsRef.current.videoProtocol = 'xai-native'; f.catalogChanged()
    if (change === 'project') { f.projectEpochRef.current++; f.activeProjectIdRef.current = 'project-2' }
    else f.runsRequestRevisionRef.current++
    f.reads[1].resolve([f.completed]); await f.refreshes[1]
    expect(f.nodes()).toEqual([f.originalNode]); expect(f.setDirtyNodeIds).not.toHaveBeenCalled()
    expect(f.pendingRunProjectionIdsRef.current.has('run-1')).toBe(true)
  })

  it('allows non-video terminal output while the video source catalog is unavailable', async () => {
    const node: WorkflowNode = { id: 'text', kind: 'text-generate', position: { x: 0, y: 0 }, data: { prompt: 'write', model: 'gpt-4.1', status: 'idle' } }
    const submitted: CanvasRunGraph = { nodes: [{ id: node.id, kind: node.kind, definitionVersion: 1, data: { prompt: node.data.prompt, model: node.data.model } }], edges: [] }
    const f = fixture({ nodes: [node], submitted, groupsLoaded: false })
    const completed: CanvasRunRecord = { ...record('run-1', 'succeeded'), nodes: [{ nodeId: node.id, kind: node.kind, state: 'succeeded', attempts: [{ attemptId: 'text-attempt', fingerprint: 'text-fingerprint', state: 'succeeded', cached: false, startedAt: record().startedAt, completedAt: '2026-10-14T12:00:02.000Z', durationMs: 200, candidates: [], outputText: 'complete text' }] }] }
    const read = f.refreshRuns(); f.reads[0].resolve([completed]); await read
    expect(f.nodes()[0].data.outputText).toBe('complete text')
    expect(f.pendingRunProjectionIdsRef.current.size).toBe(0)
    expect(f.setRunsError).toHaveBeenCalledExactlyOnceWith(null)
  })
})
