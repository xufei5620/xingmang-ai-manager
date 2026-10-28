import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { toCanvasNode, toCanvasRunGraph, workflowNodeData } from '../App'
import { canvasCapabilities } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import type { NodeKind, WorkflowEdge, WorkflowNode } from '../model'
import { cachedNodeIdsForPreflight } from './pinned-reuse'
import { canvasRunInputForHost } from './host-run-compatibility'
import { buildCanvasRunPreflight, sameCanvasRunGraphSnapshot, type CanvasRunPreflight } from './run-preflight'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source); if (!expression) throw new Error(`Missing callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}

const groups = { image: '图片模型', video: '视频模型', text: '文字', imageModel: 'gpt-image-2', videoModel: '', textModel: 'gpt-4.1' }
function workflowNode(id: string, kind: NodeKind, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: workflowNodeData(kind, data, true) }
}

function promptTo(target: string): WorkflowEdge {
  return { id: `prompt-${target}`, source: 'prompt', sourceHandle: 'out:text', target, targetHandle: 'in:text' }
}

function confirm(nodes: WorkflowNode[], hostCapabilities: () => ReturnType<typeof canvasCapabilities>, edges: WorkflowEdge[] = []) {
  const canvasNodes = nodes.map(toCanvasNode), graph = toCanvasRunGraph(canvasNodes, edges, groups)
  const startRun = vi.fn(async () => ({ runId: 'run', graphRevision: 'revision' })), save = vi.fn(async () => undefined)
  const preflights: Array<CanvasRunPreflight | null> = [], banners: Array<string | null> = []
  const env = {
    projectCanRunRef: { current: true }, pendingCanvasRun: { graph, scope: { kind: 'all' } }, projectTransitionRef: { current: false }, startingRunsRef: { current: 0 }, nodes: canvasNodes, edges,
    imageGroup: groups.image, videoGroup: groups.video, textGroup: groups.text, videoProtocol: undefined, mediaGroups: groups, imageAssetDimensions: {}, nodeSourceCatalogRef: { current: {} },
    mediaModelsRef: { current: { image: ['gpt-image-2'], video: [], text: ['gpt-4.1'] } }, toCanvasRunGraph, buildCanvasRunPreflight, cachedNodeIdsForPreflight, sameCanvasRunGraphSnapshot,
    canvasCapabilities: hostCapabilities, canvasRunInputForHost, dramaPreflightBlockReasons: () => ({}), rejectPendingMedia: () => false, rejectUnavailableGroups: () => false,
    setPendingCanvasRun: vi.fn(), setRunPreflight: (value: CanvasRunPreflight | null) => { preflights.push(value) }, setBanner: (value: string | null) => { banners.push(value) }, setStartingRuns: vi.fn(),
    saveBeforeRunRef: { current: save }, hostBridge: () => ({ startRun }), rememberActiveRun: vi.fn(), activeProjectIdRef: { current: 'project' }, openInspectorTab: vi.fn(),
    activeRunsRef: { current: new Map() }, refreshRuns: vi.fn(), outputPlacementCoordinator: { cancel: vi.fn() }, outputPlacementAdapterRef: { current: null },
  }
  const inspectPendingAgentExecution = vi.fn(() => undefined)
  return { run: actual<() => Promise<void>>('confirmCanvasRun', { ...env, inspectPendingAgentExecution }), startRun, save, preflights, banners }
}

describe('actual App run confirmation against the host profile', () => {
  it('blocks a project with a node the host cannot run before any save or request', async () => {
    const { run, startRun, save, preflights, banners } = confirm([workflowNode('prompt', 'prompt', { prompt: '写一段介绍' }), workflowNode('text', 'text-generate', { model: 'gpt-4.1' })], () => canvasCapabilities({}), [promptTo('text')])
    await run()
    expect(startRun).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(preflights.at(-1)?.items.find((item) => item.nodeId === 'text')).toMatchObject({ action: 'blocked', reasonCode: 'unsupported-host', reason: '「文字生成」节点当前客户端暂不支持' })
    expect(banners.at(-1)).toBe('当前运行范围出现新的阻塞项，请先修复后重新运行')
  })

  it('submits only what a host without capabilities() parses for a project it can run', async () => {
    const { run, startRun } = confirm([workflowNode('prompt', 'prompt', { prompt: '一只猫' }), workflowNode('image', 'image-generate', { model: 'gpt-image-2' })], () => canvasCapabilities({}), [promptTo('image')])
    await run()
    expect(startRun).toHaveBeenCalledTimes(1)
    const [input] = startRun.mock.calls[0] as unknown as [{ graph: { nodes: Array<{ data: Record<string, unknown> }> } }]
    const v2Keys = ['prompt', 'model', 'group', 'quality', 'size', 'imageResolution', 'seconds', 'adoptedAssetId', 'videoMode', 'videoResolution', 'videoAspectRatio', 'promptOptimization']
    for (const node of input.graph.nodes) for (const [key, value] of Object.entries(node.data)) {
      expect(v2Keys, key).toContain(key)
      expect(value, key).not.toBeUndefined()
    }
  })

  it('runs the same project on a host that declares the node', async () => {
    const { run, startRun } = confirm([workflowNode('prompt', 'prompt', { prompt: '写一段介绍' }), workflowNode('text', 'text-generate', { model: 'gpt-4.1' })], () => fullCanvasCapabilityProfile, [promptTo('text')])
    await run()
    expect(startRun).toHaveBeenCalledTimes(1)
  })
})
