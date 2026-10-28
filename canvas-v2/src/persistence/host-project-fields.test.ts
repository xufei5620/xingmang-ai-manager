import { describe, expect, it } from 'vitest'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'
import { v2EquivalentCapabilities } from '../host-capabilities'
import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { hostNoteTextEditAccepted, hostNoteTextProblem, workflowForHostProject } from './host-project-fields'
import type { PersistedWorkflowV2 } from './workflow-schema'
import { parseWorkflowFile, serializeWorkflow } from './workflow-serializer'

const v2 = v2EquivalentCapabilities.project
const kernel = fullCanvasCapabilityProfile.project
const assetId = 'a'.repeat(43)

function workflow(nodes: WorkflowNode[]): WorkflowFile {
  return { ...createEmptyWorkflow('桌面工程'), nodes }
}

function maskSettings(points: number) {
  return { imageEditMask: { version: 1, width: 1024, height: 1024, strokes: [{ tool: 'brush', size: 0.05, points: Array.from({ length: points }, (_, index) => ({ x: (index % 100) / 100, y: 0.5 })) }] } }
}

function persisted(nodes: PersistedWorkflowV2['nodes']): PersistedWorkflowV2 {
  return { schemaVersion: 2, name: '桌面工程', nodes, edges: [] }
}

describe('saved fields for the host project store', () => {
  it('keeps only the eleven node data keys a v2 store accepts, and leaves the editor marks in memory', () => {
    const nodes: WorkflowNode[] = [
      { id: 'text', kind: 'text-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '写一句文案', outputText: '回答', textWebSearch: true, dirty: true, model: 'gpt-4.1', group: '文字', status: 'succeeded', settings: { title: '文案' } } },
      { id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 0, y: 300 }, data: { prompt: '猫', model: 'gpt-image-2', group: '图片模型', size: '1024x1024', imageResolution: '2K', status: 'idle', imageCandidateCount: 2, dirty: true } },
      { id: 'video', kind: 'video-generate', definitionVersion: 1, position: { x: 0, y: 600 }, data: { prompt: '海浪', model: 'MiniMax-Hailuo-02', seconds: '6', status: 'idle', videoCandidateCount: 2 } },
    ]
    const saved = JSON.parse(serializeWorkflow(workflow(nodes), v2)) as PersistedWorkflowV2
    expect(saved.nodes.map((node) => node.data)).toEqual([
      { prompt: '写一句文案', model: 'gpt-4.1', group: '文字', settings: { title: '文案' } },
      { prompt: '猫', model: 'gpt-image-2', group: '图片模型', size: '1024x1024', imageResolution: '2K' },
      { prompt: '海浪', model: 'MiniMax-Hailuo-02', seconds: '6' },
    ])
    const full = JSON.parse(serializeWorkflow(workflow(nodes), kernel)) as PersistedWorkflowV2
    expect(full.nodes.map((node) => Object.keys(node.data))).toEqual([
      expect.arrayContaining(['outputText', 'textWebSearch', 'dirty']), expect.arrayContaining(['imageCandidateCount', 'dirty']), expect.arrayContaining(['videoCandidateCount']),
    ])
  })

  it('writes the kernel format unchanged for a kernel store and without a store', () => {
    const node: WorkflowNode = { id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '猫', model: 'gpt-image-2', status: 'idle', dirty: true, imageCandidateCount: 2 } }
    expect(serializeWorkflow(workflow([node]), kernel)).toBe(serializeWorkflow(workflow([node])))
    const content = persisted([{ id: 'n', kind: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', dirty: true } }])
    expect(workflowForHostProject(content, kernel)).toBe(content)
  })

  it('leaves out a switched-off feature setting a v2 store would refuse, keeping the rest of the node', () => {
    const node: WorkflowNode = {
      id: 'edit', kind: 'image-edit', definitionVersion: 1, position: { x: 0, y: 0 },
      data: { prompt: '把背景换成海边', model: 'gpt-image-1', status: 'idle', result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` }, settings: { title: '改图', ...maskSettings(300) } },
    }
    const saved = JSON.parse(serializeWorkflow(workflow([node]), v2)) as PersistedWorkflowV2
    expect(saved.nodes[0].data).toEqual({ prompt: '把背景换成海边', model: 'gpt-image-1', result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` }, settings: { title: '改图' } })
    // A setting the v2 store can hold stays, even when its feature is off there.
    const small = { ...node, data: { ...node.data, settings: { title: '改图', ...maskSettings(200) } } }
    expect(JSON.parse(serializeWorkflow(workflow([small]), v2)).nodes[0].data.settings.imageEditMask.strokes[0].points).toHaveLength(200)
    expect(JSON.parse(serializeWorkflow(workflow([node]), kernel)).nodes[0].data.settings.imageEditMask.strokes[0].points).toHaveLength(300)
  })

  it('stops the save instead of dropping note prose a v2 store would refuse', () => {
    for (const text of ['说'.repeat(10_001), 'https://example.invalid/说明', '/Users/me/说明.txt']) {
      const note: WorkflowNode = { id: 'note', kind: 'note', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { text } } }
      expect(() => serializeWorkflow(workflow([note]), v2), text.slice(0, 20)).toThrow('便签正文超过当前客户端的上限（1 万字），或以网址、路径开头，保存未完成')
      expect(JSON.parse(serializeWorkflow(workflow([note]), kernel)).nodes[0].data.settings.text).toBe(text)
    }
    const fits: WorkflowNode = { id: 'note', kind: 'note', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { text: '说'.repeat(10_000) } } }
    expect(JSON.parse(serializeWorkflow(workflow([fits]), v2)).nodes[0].data.settings.text).toHaveLength(10_000)
  })

  it('reads back to the same saved content', () => {
    const nodes: WorkflowNode[] = [
      { id: 'prompt', kind: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '一只猫', model: '', status: 'idle', dirty: true } },
      { id: 'edit', kind: 'image-edit', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: '', model: 'gpt-image-1', status: 'idle', imageCandidateCount: 2, settings: { title: '改图', ...maskSettings(300) } } },
    ]
    const content = serializeWorkflow(workflow(nodes), v2)
    const reopened = parseWorkflowFile(content)
    expect(reopened).not.toBeNull()
    expect(serializeWorkflow(reopened!, v2)).toBe(content)
    expect(serializeWorkflow(reopened!)).toBe(content)
  })

  it('names why a note cannot be stored, by the host store limits', () => {
    expect(hostNoteTextProblem('说'.repeat(10_000), v2)).toBeUndefined()
    expect(hostNoteTextProblem('说'.repeat(10_001), v2)).toBe('当前客户端的便签最多 1 万字')
    expect(hostNoteTextProblem('说'.repeat(100_001), kernel)).toBe('当前客户端的便签最多 10 万字')
    expect(hostNoteTextProblem('说'.repeat(10_001), { ...kernel, noteText: { maximumLength: 12_345, plainTextOnly: false } })).toBeUndefined()
    expect(hostNoteTextProblem('说'.repeat(12_346), { ...kernel, noteText: { maximumLength: 12_345, plainTextOnly: false } })).toBe('当前客户端的便签最多 12,345 字')
    for (const text of ['https://a.invalid', 'http:x', 'file:x', 'data:x', '/Users/me', 'C:\\Users', 'D:/x', '\\\\server\\share']) {
      expect(hostNoteTextProblem(text, v2), text).toBe('当前客户端的便签不能以网址或文件路径开头')
      expect(hostNoteTextProblem(text, kernel), text).toBeUndefined()
    }
    for (const text of ['看 https://a.invalid', ' /Users/me', 'mailto:x', '']) expect(hostNoteTextProblem(text, v2), text).toBeUndefined()
  })

  it('refuses only the edit that makes a storable note unstorable', () => {
    expect(hostNoteTextEditAccepted('说'.repeat(9_999), '说'.repeat(10_000), v2)).toBe(true)
    expect(hostNoteTextEditAccepted('说'.repeat(10_000), '说'.repeat(10_001), v2)).toBe(false)
    expect(hostNoteTextEditAccepted('', 'https://a.invalid', v2)).toBe(false)
    expect(hostNoteTextEditAccepted('ht', 'htt', v2)).toBe(true)
    expect(hostNoteTextEditAccepted('http', 'http:', v2)).toBe(false)
    // A note pasted or opened too long takes every edit, so it can be shortened step by step.
    expect(hostNoteTextEditAccepted('说'.repeat(12_000), '说'.repeat(11_999), v2)).toBe(true)
    expect(hostNoteTextEditAccepted('说'.repeat(12_000), '说'.repeat(12_001), v2)).toBe(true)
    expect(hostNoteTextEditAccepted('', 'https://a.invalid', kernel)).toBe(true)
  })
})
