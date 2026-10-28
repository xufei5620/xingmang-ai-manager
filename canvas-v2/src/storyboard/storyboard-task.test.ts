import { describe, expect, it } from 'vitest'
import { assertStoryboardAnalysisConfiguration, assertStoryboardTaskConfiguration, buildStoryboardAnalysisPrompt, buildStoryboardTaskPrompt, defaultStoryboardTask, parseNodeStoryboardTask, parseStoryboardTask, resolveStoryboardImageRequest, storyboardPanelOptions, storyboardStyleOptions, storyboardTaskRoles } from './storyboard-task'
import { assertImageReferenceRunConfiguration } from '../commerce/image-task-configuration'
import { storyboardTaskRunGraphFixture } from '../lib/storyboard-task.test-fixture'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'

function validate(input = storyboardTaskRunGraphFixture()) { const byId = new Map(input.nodes.map((node) => [node.id, node])); assertImageReferenceRunConfiguration(byId.get('story')!, input.edges, byId) }

describe('storyboard task contract and explicit visual plot', () => {
  it('preserves every observed style and panel combination as one image task', () => {
    for (const { value: style } of storyboardStyleOptions) for (const panels of storyboardPanelOptions) {
      const task = { ...defaultStoryboardTask(), style, panels }
      expect(parseStoryboardTask(task)).toEqual(task)
      expect(buildStoryboardTaskPrompt(task, '保留主角')).toContain(`${panels} 个分镜面板`)
      expect(resolveStoryboardImageRequest(task, { model: 'gpt-image-1', prompt: '保留主角', size: '1536x1024' })).toEqual({ model: 'gpt-image-1', prompt: buildStoryboardTaskPrompt(task, '保留主角'), size: '1536x1024' })
    }
  })
  it.each([null, false, [], {}, { ...defaultStoryboardTask(), version: 2 }, { ...defaultStoryboardTask(), panels: 6 }, { ...defaultStoryboardTask(), automaticPlot: 1 }, { ...defaultStoryboardTask(), fakeNativeStrength: .5 }])('rejects invalid, unknown and future fields: %j', (value) => expect(() => parseStoryboardTask(value)).toThrow())
  it('accepts only image creation nodes and requires a manual plot', () => {
    for (const kind of ['image', 'image-generate', 'image-edit']) expect(parseNodeStoryboardTask(kind, defaultStoryboardTask())).toEqual(defaultStoryboardTask())
    expect(() => parseNodeStoryboardTask('text-generate', defaultStoryboardTask())).toThrow()
    expect(() => resolveStoryboardImageRequest({ ...defaultStoryboardTask(), automaticPlot: false }, { model: 'gpt-image-1', prompt: '  ' })).toThrow('剧情')
  })
  it('uses the ordered slots as the only input count and rejects all other task families', () => {
    for (const count of [1, 2, 3, 4]) {
      const graph = storyboardTaskRunGraphFixture(true, count), node = graph.nodes.find((node) => node.id === 'story')!
      expect(storyboardTaskRoles(defaultStoryboardTask(), count)).toEqual(['source', ...Array(count - 1).fill('reference')])
      expect(() => assertStoryboardTaskConfiguration(node.data.storyboardTask, node.data.imageReferenceOrder)).not.toThrow()
      for (const index of [0, 1, 2]) { const others: unknown[] = [undefined, undefined, undefined]; others[index] = {}; expect(() => assertStoryboardTaskConfiguration(node.data.storyboardTask, node.data.imageReferenceOrder, ...others)).toThrow('同时') }
      expect(() => validate(graph)).not.toThrow()
    }
    for (const count of [0, 5, 1.5]) expect(() => storyboardTaskRoles(defaultStoryboardTask(), count)).toThrow()
  })
  it.each(['reordered', 'foreign-source', 'wrong-port', 'extra-text', 'extra-image', 'disabled', 'web-search', 'unknown-model', 'stale-plot'])('blocks ambiguous or stale analysis before requests: %s', (mode) => {
    const graph = storyboardTaskRunGraphFixture(true, 3), analysis = graph.nodes.find((node) => node.id === 'analysis')!
    if (mode === 'reordered') { const slots = analysis.data.imageReferenceOrder!.slots; [slots[1], slots[2]] = [slots[2], slots[1]] }
    if (mode === 'foreign-source') graph.edges.find((edge) => edge.id === 'analysis-1')!.source = 'source-2'
    if (mode === 'wrong-port') graph.edges.find((edge) => edge.id === 'plot')!.sourceHandle = 'out:image'
    if (mode === 'extra-text' || mode === 'extra-image') graph.edges.push({ id: 'foreign', source: 'source-0', sourceHandle: mode === 'extra-text' ? 'out:text' : 'out:image', target: 'analysis', targetHandle: mode === 'extra-text' ? 'in:text' : 'in:images' })
    if (mode === 'disabled') analysis.disabled = true
    if (mode === 'web-search') analysis.data.textWebSearch = true
    if (mode === 'unknown-model') analysis.data.model = 'unknown-vision'
    if (mode === 'stale-plot') graph.nodes.find((node) => node.id === 'story')!.data.prompt = '另一段剧情'
    expect(() => validate(graph)).toThrow()
  })
  it('canonical analysis includes the unchanged plot, with no hidden request or duplicate task count', () => {
    const graph = storyboardTaskRunGraphFixture(true, 4, 25)
    const preflight = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], textModels: ['gpt-4.1'], videoModels: [] })
    expect(preflight.canStart).toBe(true); expect(preflight.imageRequestCount).toBe(2); expect(preflight.textRequestCount).toBe(1); expect(preflight.paidRequestCount).toBe(3)
    const story = graph.nodes.find((node) => node.id === 'story')!, analysis = graph.nodes.find((node) => node.id === 'analysis')!
    expect(analysis.data.prompt).toBe(buildStoryboardAnalysisPrompt(story.data.storyboardTask!, story.data.prompt))
    expect(analysis.data.prompt.endsWith(story.data.prompt)).toBe(true)
    expect(() => assertStoryboardAnalysisConfiguration(story, graph.edges, new Map(graph.nodes.map((node) => [node.id, node])))).not.toThrow()
    const manual = storyboardTaskRunGraphFixture(false, 4, 25)
    const check = buildCanvasRunPreflight({ graph: manual, scope: { kind: 'all' }, imageModels: ['gpt-image-1'], textModels: ['gpt-4.1'], videoModels: [] })
    expect(check.canStart).toBe(true); expect(check.textRequestCount).toBe(0); expect(check.imageRequestCount).toBe(2)
  })
})
