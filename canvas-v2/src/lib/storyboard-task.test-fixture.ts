import { buildStoryboardWorkflow } from '../storyboard/storyboard-workflow'
import type { CanvasRunGraph } from '../host'
import { buildStoryboardAnalysisPrompt, defaultStoryboardTask, type StoryboardTask } from '../storyboard/storyboard-task'

export function storyboardTaskRunGraphFixture(automaticPlot = true, count = 1, panels: StoryboardTask['panels'] = 9): CanvasRunGraph {
  const task = { ...defaultStoryboardTask(), automaticPlot, panels }
  const prompt = '角色离开家，找到朋友，最后一起回家。'
  const ids = ['a', 'b', 'c', 'd'].slice(0, count)
  const slots = ids.map((_, index) => ({ role: index === 0 ? 'source' as const : 'reference' as const, edgeId: `image-${index}`, outputIndex: 0 }))
  const nodes: CanvasRunGraph['nodes'] = ids.map((letter, index) => ({ id: `source-${index}`, kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: letter.repeat(43) } }))
  nodes.push({ id: 'story', kind: 'image-generate', definitionVersion: 1, data: { prompt, model: 'gpt-image-1', group: 'provider-a', size: '1536x1024', imageCandidateCount: 2, storyboardTask: task, imageReferenceOrder: { version: 1, slots } } })
  const edges: CanvasRunGraph['edges'] = ids.map((_, index) => ({ id: `image-${index}`, source: `source-${index}`, sourceHandle: 'out:image', target: 'story', targetHandle: 'in:images' }))
  if (automaticPlot) {
    nodes.push({ id: 'analysis', kind: 'text-generate', definitionVersion: 1, data: { prompt: buildStoryboardAnalysisPrompt(task, prompt), model: 'gpt-4.1', group: 'provider-a', imageReferenceOrder: { version: 1, slots: slots.map((slot, index) => ({ ...slot, edgeId: `analysis-${index}` })) } } })
    edges.push(...ids.map((_, index) => ({ id: `analysis-${index}`, source: `source-${index}`, sourceHandle: 'out:image', target: 'analysis', targetHandle: 'in:images' })))
    edges.push({ id: 'plot', source: 'analysis', sourceHandle: 'out:text', target: 'story', targetHandle: 'in:text' })
  }
  return { nodes, edges }
}

export function storyboardTaskWorkflowFixture(automaticPlot = true, count = 2) {
  let id = 0
  return buildStoryboardWorkflow({ task: { ...defaultStoryboardTask(), automaticPlot }, sources: ['a','b','c','d'].slice(0, count).map((letter) => ({ assetId: letter.repeat(43), width: 640, height: 480 })), prompt: '角色从家中出发，遇到朋友。', model: 'gpt-image-1', group: 'provider-a', size: '1536x1024', candidateCount: 2, ...(automaticPlot ? { analysis: { model: 'gpt-4.1', group: 'provider-a' } } : {}), createId: () => `storyboard-${++id}` })
}
