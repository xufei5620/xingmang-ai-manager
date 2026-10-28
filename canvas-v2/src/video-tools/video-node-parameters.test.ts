import { describe, expect, it } from 'vitest'
import type { WorkflowNodeData } from '../model'
import { assertEditableVideoNode, buildVideoParameterPatch, inspectVideoNodeParameters, videoParametersForNode, type VideoParameterPatch } from './video-node-parameters'

function data(changes: Partial<WorkflowNodeData> = {}): WorkflowNodeData { return { prompt: '保留提示词', model: 'minimax-h3-mini', status: 'idle', seconds: '8', size: '1280x720', settings: { videoMode: 'fl2va', videoResolution: '480p', videoAspectRatio: '9:16', promptOptimization: true, title: '视频草稿' }, result: { kind: 'video', assetId: 'v'.repeat(43), taskId: 'existing-task' }, ...changes } }
describe('video node parameter helpers', () => {
  it('preserves inactive model parameters for explicit inspection instead of normalizing during selection', () => {
    const source = data(), patch = buildVideoParameterPatch(source, { model: 'grok-imagine-video' })
    expect(patch).toEqual({ model: 'grok-imagine-video' }); expect(source.settings?.videoMode).toBe('fl2va')
    const inspect = inspectVideoNodeParameters({ ...source, ...patch }, 'grok-imagine-video')
    expect(inspect.resetLabels).toEqual(['生成模式', '视频比例', '视频分辨率', '提示词优化'])
    expect(inspect.reset).toMatchObject({ videoMode: undefined, videoAspectRatio: undefined, videoResolution: undefined, promptOptimization: undefined })
    const reset = buildVideoParameterPatch(source, inspect.reset)
    expect(reset).toEqual({ settings: { title: '视频草稿' } }); expect(source.result?.taskId).toBe('existing-task')
  })
  it('retains unrelated settings and old video results when patching or clearing fields', () => {
    const source = data(), before = structuredClone(source)
    expect(buildVideoParameterPatch(source, { seconds: '9', videoResolution: undefined })).toEqual({ seconds: '9', settings: { videoMode: 'fl2va', videoAspectRatio: '9:16', promptOptimization: true, title: '视频草稿' } })
    expect(source).toEqual(before); expect(videoParametersForNode(source, 'other-model').model).toBe('other-model')
  })
  it.each([{ prompt: 'overwrite' }, { model: ' spaced ' }, { model: '' }, { seconds: 7 }, { promptOptimization: 'false' }, { videoMode: 'x'.repeat(33) }])('rejects malformed patches without modifying data: %j', (patch) => {
    const source = data(), before = structuredClone(source)
    expect(() => buildVideoParameterPatch(source, patch as unknown as VideoParameterPatch)).toThrow(); expect(source).toEqual(before)
  })
  it('preserves false audio, resets unsupported relay settings explicitly, and clears image aspect hints', () => {
    const source = data({ model: 'grok-imagine-video-1.5', settings: { generateAudio: false, videoAspectRatio: '9:16', title: '保留' } })
    expect(buildVideoParameterPatch(source, { generateAudio: false }).settings?.generateAudio).toBe(false)
    expect(inspectVideoNodeParameters(source, source.model, 'relay-videos').reset).toMatchObject({ generateAudio: undefined })
    expect(inspectVideoNodeParameters(source, source.model, 'xai-native', 1).reset).toMatchObject({ videoAspectRatio: undefined })
    expect(buildVideoParameterPatch(source, { generateAudio: undefined }).settings).toEqual({ videoAspectRatio: '9:16', title: '保留' })
    expect(() => buildVideoParameterPatch(source, { generateAudio: 'false' } as unknown as VideoParameterPatch)).toThrow()
  })
  it('rejects locked, disabled, missing or cyclic group ancestry and running targets', () => {
    const nodes = [{ id: 'group', type: 'group', data: data(), draggable: true, disabled: false, parentId: undefined as string | undefined }, { id: 'video', type: 'video-generate', parentId: 'group', data: data(), draggable: true, disabled: false }]
    expect(assertEditableVideoNode(nodes, 'video')).toBe(nodes[1])
    nodes[0].draggable = false; expect(() => assertEditableVideoNode(nodes, 'video')).toThrow('锁定'); nodes[0].draggable = true
    nodes[0].disabled = true; expect(() => assertEditableVideoNode(nodes, 'video')).toThrow('禁用'); nodes[0].disabled = false
    nodes[0].parentId = 'video'; expect(() => assertEditableVideoNode(nodes, 'video')).toThrow('层级'); nodes[0].parentId = undefined
    expect(() => assertEditableVideoNode(nodes.slice(1), 'video')).toThrow('分组已变化')
    nodes[1].data.status = 'running'; expect(() => assertEditableVideoNode(nodes, 'video')).toThrow('正在生成')
    nodes[1].data.status = 'queued'; expect(() => assertEditableVideoNode(nodes, 'video')).toThrow('正在生成')
    expect(() => assertEditableVideoNode(nodes, 'group')).toThrow('视频生成节点')
  })
})
