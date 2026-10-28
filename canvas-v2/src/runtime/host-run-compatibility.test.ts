import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { resolveCanvasCapabilities, v2EquivalentCapabilities } from '../host-capabilities'
import { fullCanvasCapabilities, fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { workflowNodeData } from '../App'
import {
  canvasNodeKindUnsupportedReason,
  canvasRunInputForHost,
  canvasRunNodeUnsupportedReason,
  canvasRunUpstreamUnsupportedReason,
  withoutHostDisabledDefaults,
} from './host-run-compatibility'
import { buildCanvasRunPreflight } from './run-preflight'

type RunNode = CanvasRunGraph['nodes'][number]

function node(kind: string, data: Partial<RunNode['data']> = {}, id = kind): RunNode {
  return { id, kind, definitionVersion: 1, data: { prompt: '', model: '', ...data } }
}

const v2 = v2EquivalentCapabilities
const origin = { version: 1 as const, sessionId: 'session', turnId: 'turn', proposalDigest: 'a'.repeat(64) }

describe('host run compatibility', () => {
  it('names a node kind the host does not run', () => {
    expect(canvasRunNodeUnsupportedReason(node('text-generate'), v2)).toBe('「文字生成」节点当前客户端暂不支持')
    expect(canvasNodeKindUnsupportedReason('image-crop', v2)).toMatch(/^「.+」节点当前客户端暂不支持$/)
    expect(canvasNodeKindUnsupportedReason('image-generate', v2)).toBeUndefined()
    expect(canvasRunNodeUnsupportedReason(node('text-generate'), fullCanvasCapabilityProfile)).toBeUndefined()
  })

  it('names every switched-on feature the host has off, once each', () => {
    const data = {
      imageCandidateCount: 2, textWebSearch: true, generateAudio: false, routerStrategy: { version: 1, strategy: 'all' },
      videoProtocol: 'ark-seedance', videoReferenceOrder: { version: 1, slots: [{}] }, imageReferenceOrder: { version: 1, slots: [] },
      imageEditMask: {}, commerceTask: {}, imageTransform: {}, imageOutputIndex: 0,
    // Only presence matters to the check, so the structured values stay empty.
    } as unknown as Partial<RunNode['data']>
    expect(canvasRunNodeUnsupportedReason(node('image-generate', data), v2)).toBe(
      '「一次出多张图、联网搜索、生成音频设置、路由策略、这个视频接口、视频参考顺序、参考图角色、蒙版局部修改、电商创作、图片处理」当前客户端暂不支持',
    )
    expect(canvasRunNodeUnsupportedReason(node('image-generate', data), fullCanvasCapabilityProfile)).toBeUndefined()
  })

  it('does not count values that leave the request as the host already sends it', () => {
    const data = { imageCandidateCount: 1, videoCandidateCount: 1, textWebSearch: false, videoProtocol: 'relay-videos', videoReferenceOrder: { version: 1, slots: [] }, seconds: '15', videoResolution: '720p', videoAspectRatio: '21:9' } as Partial<RunNode['data']>
    expect(canvasRunNodeUnsupportedReason(node('video-generate', data), v2)).toBeUndefined()
  })

  it('checks the values a host parses on every node, not only video nodes', () => {
    for (const [data, label] of [
      [{ videoResolution: '1080p' }, '视频分辨率'],
      [{ videoAspectRatio: '3:2' }, '视频比例'],
      [{ seconds: '16' }, '视频时长'],
      [{ seconds: '06' }, '视频时长'],
      [{ seconds: '0' }, '视频时长'],
      [{ seconds: '6.0' }, '视频时长'],
    ] as Array<[Partial<RunNode['data']>, string]>) {
      expect(canvasRunNodeUnsupportedReason(node('video-generate', data), v2), JSON.stringify(data)).toBe(`「${label}」当前客户端暂不支持`)
      expect(canvasRunNodeUnsupportedReason(node('image-generate', data), v2), JSON.stringify(data)).toBe(`「${label}」当前客户端暂不支持`)
    }
  })

  it('names an upstream node the host cannot run', () => {
    expect(canvasRunUpstreamUnsupportedReason([node('prompt'), node('text-generate')], v2)).toBe('上游的「文字生成」节点当前客户端暂不支持')
    expect(canvasRunUpstreamUnsupportedReason([node('prompt')], v2)).toBeUndefined()
  })

  it('sends a v2-era host only the node kinds and the twelve keys it parses, without undefined values', () => {
    const graph: CanvasRunGraph = {
      nodes: [
        node('prompt', { prompt: '猫', quality: undefined, imageCandidateCount: 1 }),
        node('image-generate', { model: 'gpt-image-2', group: '图片模型', size: '1024x1024', imageResolution: '2K', imageCandidateCount: 1, adoptedAssetId: undefined, seconds: undefined }),
        node('text-generate', { model: 'gpt-4.1' }),
      ],
      edges: [
        { id: 'e1', source: 'prompt', sourceHandle: 'out:text', target: 'image-generate', targetHandle: 'in:prompt' },
        { id: 'e2', source: 'prompt', sourceHandle: 'out:text', target: 'text-generate', targetHandle: 'in:prompt' },
      ],
    }
    const sent = canvasRunInputForHost({ graph, scope: { kind: 'all' } }, v2)
    expect(sent).toEqual({
      graph: {
        nodes: [
          { id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: '猫', model: '' } },
          { id: 'image-generate', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', group: '图片模型', size: '1024x1024', imageResolution: '2K' } },
        ],
        edges: [graph.edges[0]],
      },
      scope: { kind: 'all' },
    })
    for (const entry of sent.graph.nodes) expect(Object.values(entry.data)).not.toContain(undefined)
    expect(graph.nodes).toHaveLength(3)
  })

  it('sends a version-1 host every kernel key it gave, without undefined values or values it cannot parse', () => {
    const desktop = resolveCanvasCapabilities({ ...fullCanvasCapabilities, host: 'desktop', video: { ...fullCanvasCapabilities.video, miniMaxResolutions: ['480p', '720p'] } })
    const graph: CanvasRunGraph = {
      nodes: [
        node('text-generate', { model: 'gpt-4.1', textWebSearch: true, quality: undefined }),
        node('video-generate', { videoResolution: '1080p', seconds: '6' }, 'outside-scope'),
      ],
      edges: [],
    }
    const sent = canvasRunInputForHost({ graph, scope: { kind: 'selection', nodeIds: ['text-generate'] }, agentExecution: origin }, desktop)
    expect(sent.graph.nodes.map((entry) => entry.data)).toEqual([{ prompt: '', model: 'gpt-4.1', textWebSearch: true }, { prompt: '', model: '', seconds: '6' }])
    expect(sent.agentExecution).toEqual(origin)
  })

  it('refuses to send an Agent origin to a host without agent execution', () => {
    expect(() => canvasRunInputForHost({ graph: { nodes: [], edges: [] }, scope: { kind: 'all' }, agentExecution: origin }, v2)).toThrow('当前客户端不支持由 Agent 发起运行')
    expect(canvasRunInputForHost({ graph: { nodes: [], edges: [] }, scope: { kind: 'all' } }, v2)).not.toHaveProperty('agentExecution')
  })

  it('leaves the routing strategy out of a new router when the host has it off', () => {
    const data = workflowNodeData('router', {}, true)
    expect(data.settings).toHaveProperty('routerStrategy')
    expect(withoutHostDisabledDefaults(data, fullCanvasCapabilityProfile)).toBe(data)
    const restricted = withoutHostDisabledDefaults(data, v2)
    expect(restricted.settings ?? {}).not.toHaveProperty('routerStrategy')
    expect({ ...restricted, settings: { ...restricted.settings, routerStrategy: data.settings?.routerStrategy } }).toEqual(data)
    const prompt = workflowNodeData('prompt', {}, true)
    expect(withoutHostDisabledDefaults(prompt, v2)).toBe(prompt)
  })

  it('blocks nodes the host cannot run, and nodes they feed, before any request', () => {
    const graph: CanvasRunGraph = {
      nodes: [node('text-generate', { model: 'gpt-4.1', group: '文字' }), node('image-generate', { model: 'gpt-image-2', group: '图片模型' })],
      edges: [{ id: 'e', source: 'text-generate', sourceHandle: 'out:text', target: 'image-generate', targetHandle: 'in:prompt' }],
    }
    const base = { graph, imageGroup: '图片模型', textGroup: '文字', imageModels: ['gpt-image-2'], videoModels: [], textModels: ['gpt-4.1'] }
    const all = buildCanvasRunPreflight({ ...base, scope: { kind: 'all' }, capabilities: v2 })
    expect(all.canStart).toBe(false)
    expect(all.items.map((item) => [item.nodeId, item.reasonCode, item.reason])).toEqual([
      ['text-generate', 'unsupported-host', '「文字生成」节点当前客户端暂不支持'],
      ['image-generate', 'unsupported-host', '上游的「文字生成」节点当前客户端暂不支持'],
    ])
    const downstream = buildCanvasRunPreflight({ ...base, scope: { kind: 'selection', nodeIds: ['image-generate'] }, capabilities: v2 })
    expect(downstream.canStart).toBe(false)
    expect(downstream.items.find((item) => item.nodeId === 'image-generate')?.reasonCode).toBe('unsupported-host')
    expect(buildCanvasRunPreflight({ ...base, scope: { kind: 'all' } }).items.every((item) => item.reasonCode !== 'unsupported-host')).toBe(true)
    expect(buildCanvasRunPreflight({ ...base, scope: { kind: 'all' }, capabilities: fullCanvasCapabilityProfile }).items.every((item) => item.reasonCode !== 'unsupported-host')).toBe(true)
  })
})
