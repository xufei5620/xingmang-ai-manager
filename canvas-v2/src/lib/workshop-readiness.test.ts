import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type NodeKind, type WorkflowFile, type WorkflowNode } from '../model'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from '../image-tools/recipe'
import { analyzeWorkshopReadiness } from './workshop-readiness'
import { imageCollageTemplates } from '../image-tools/collage-templates'

function node(id: string, kind: NodeKind, settings?: Record<string, unknown>): WorkflowNode {
  return { id, kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', ...(settings ? { settings } : {}) } }
}
function workflow(nodes: WorkflowNode[], edges: WorkflowFile['edges'] = []): WorkflowFile { return { ...createEmptyWorkflow('Reusable'), nodes, edges } }
function edge(source: string, target: string, sourceHandle = 'out:image', targetHandle = 'in:image') { return { id: `${source}-${target}`, source, target, sourceHandle, targetHandle } }

describe('workshop preparation requirements', () => {
  it('admits a fixed two-image collage and second-source layer behind a typed all router without trusting its old preview', () => {
    const a = node('a', 'image-input'), b = node('b', 'image-input'), route = node('route', 'router', { routerStrategy: { version: 1, strategy: 'all' } })
    a.data.result = { kind: 'image', assetId: 'a'.repeat(43), localUrl: '/a' }; b.data.result = { kind: 'image', assetId: 'b'.repeat(43), localUrl: '/b' }
    route.data.result = a.data.result
    const layerRecipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    layerRecipe.layers = [{ sourceIndex: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }]
    const collage = node('collage', 'image-collage', { imageTransform: { ...defaultImageTransformRecipe('collage'), layout: 'template-balanced' } }), layer = node('layer', 'image-layer', { imageTransform: layerRecipe })
    const value = workflow([a, b, route, collage, layer], [edge('a', 'route', 'out:image', 'in:images'), edge('b', 'route', 'out:image', 'in:images'), edge('route', 'collage', 'out:image', 'in:images'), edge('route', 'layer', 'out:image', 'in:images')])
    expect(analyzeWorkshopReadiness(value).requirements.filter((item) => ['collage', 'layer'].includes(item.nodeId) && item.kind === 'configuration')).toEqual([])
    route.data.settings!.routerStrategy = { version: 1, strategy: 'first-available' }
    const requirements = analyzeWorkshopReadiness(value).requirements
    expect(requirements).toContainEqual(expect.objectContaining({ nodeId: 'collage', kind: 'configuration', message: expect.stringContaining('2 张') }))
    expect(requirements).toContainEqual(expect.objectContaining({ nodeId: 'layer', kind: 'image', message: expect.stringContaining('至少连接 2 张') }))
  })
  it.each(['text-generate', 'drama-parse'] as const)('keeps a saved %s source as an unverified requirement without demanding replacement', (kind) => {
    const text = node('text', kind); text.data = { ...text.data, group: 'saved-text-source', model: 'gpt-4.1-mini', prompt: 'Product copy' }
    const value = workflow([text]), before = structuredClone(value), result = analyzeWorkshopReadiness(value)
    expect(result.requirements).toContainEqual(expect.objectContaining({ nodeId: 'text', kind: 'model', modelPurpose: 'text', message: expect.stringContaining('已保存的本人固定文字来源') }))
    expect(result.requirements.filter((entry) => entry.kind === 'model')).toHaveLength(1)
    expect(result.requirements.some((entry) => entry.message.includes('重新选择'))).toBe(false)
    expect(result.modelNodeCounts.text).toBe(1); expect(value).toEqual(before)
    delete text.data.group
    expect(analyzeWorkshopReadiness(value).requirements).toContainEqual(expect.objectContaining({ kind: 'model', message: expect.stringContaining('重新选择文字模型来源') }))
  })
  it('retains vision and search checks for a saved text source without declaring its current account usable', () => {
    const input = node('image', 'image-input'), text = node('text', 'text-generate')
    text.data = { ...text.data, group: 'missing-or-foreign-source', model: 'gpt-4.1-mini', prompt: 'Describe the product', textWebSearch: true }
    const result = analyzeWorkshopReadiness(workflow([input, text], [edge('image', 'text', 'out:image', 'in:images')]))
    const model = result.requirements.find((entry) => entry.nodeId === 'text' && entry.kind === 'model')!
    expect(model.message).toContain('已保存的本人固定文字来源'); expect(model.message).toContain('图片输入与联网搜索')
    expect(result.requirements.some((entry) => entry.nodeId === 'image' && entry.kind === 'image')).toBe(true)
    expect(result.notices.join(' ')).toContain('须在画布中重新补齐')
    text.data.model = 'gpt-3.5-turbo'
    expect(analyzeWorkshopReadiness(workflow([input, text], [edge('image', 'text', 'out:image', 'in:images')])).requirements.some((entry) => entry.kind === 'configuration')).toBe(true)
  })

  it('keeps fixed owner routes as verification requirements without asking to replace them', () => {
    const image = node('image', 'image-generate'), video = node('video', 'video-generate', { generateAudio: false })
    image.data = { ...image.data, group: '33c862c3-def0-499e-bb48-eca363ed69be', model: 'gpt-image-1', prompt: 'Product image' }
    video.data = { ...video.data, group: '3b4d1bfd-f196-457c-859b-0ab892c2a59a', model: 'grok-imagine-video-1.5', prompt: 'Product video', seconds: '5' }
    const value = workflow([image, video]), before = structuredClone(value)
    const result = analyzeWorkshopReadiness(value)
    expect(result.requirements.filter((entry) => entry.kind === 'model')).toHaveLength(3)
    expect(result.requirements.filter((entry) => entry.kind === 'model').every((entry) => entry.message.includes('核对') && !entry.message.includes('重新选择'))).toBe(true)
    expect(result.requirements).toContainEqual(expect.objectContaining({ nodeId: 'image', kind: 'model', message: expect.stringContaining('已保存的本人固定图像来源') }))
    expect(result.requirements).toContainEqual(expect.objectContaining({ nodeId: 'video', kind: 'model', message: expect.stringContaining('已保存的本人固定视频来源') }))
    expect(result.requestCounts).toEqual({ image: 1, video: 1, text: 0 })
    expect(value).toEqual(before)
    delete image.data.group; delete video.data.group
    expect(analyzeWorkshopReadiness(value).requirements.some((entry) => entry.message.includes('重新选择图像模型来源'))).toBe(true)
    expect(analyzeWorkshopReadiness(value).requirements.some((entry) => entry.message.includes('重新选择支持此模型和音频控制'))).toBe(true)
  })

  it('uses saved video parameters and explicit slot roles when inspecting workshop preparation', () => {
    const a = node('a', 'image-input'), b = node('b', 'image-input')
    const v = node('v', 'video-generate', { videoMode: 'fl2va', videoResolution: '480p', videoAspectRatio: '9:16', videoReferenceOrder: { version: 1, slots: [{ edgeId: 'b-v', outputIndex: 0 }, { edgeId: 'a-v', outputIndex: 0 }] } })
    v.data.prompt = 'Transition'; v.data.model = 'minimax-h3-fast'; v.data.seconds = '6'
    const value = workflow([a, b, v], [edge('a', 'v', 'out:image', 'in:images'), edge('b', 'v', 'out:image', 'in:images')])
    expect(analyzeWorkshopReadiness(value).requirements.filter((item) => item.nodeId === 'v' && item.kind === 'configuration')).toEqual([])
    value.edges.pop()
    expect(analyzeWorkshopReadiness(value).requirements).toContainEqual(expect.objectContaining({ nodeId: 'v', kind: 'configuration', message: expect.stringContaining('位置缺失') }))
    v.data.model = 'grok-imagine-video'; v.data.settings!.videoReferenceOrder = { version: 1, slots: [] }
    expect(analyzeWorkshopReadiness(value).requirements).toContainEqual(expect.objectContaining({ nodeId: 'v', kind: 'configuration', message: expect.stringContaining('不接受显式') }))
    expect(analyzeWorkshopReadiness(value).notices.join(' ')).toContain('需要重新确认视频来源协议')
  })

  it('retains native silent video and resolution intent without inventing a provider', () => {
    const video = node('native-video', 'video-generate', { generateAudio: false, videoResolution: '1080p', videoAspectRatio: '3:2' })
    video.data.model = 'grok-imagine-video-1.5'
    video.data.prompt = 'A quiet scene'
    video.data.videoCandidateCount = 3
    const result = analyzeWorkshopReadiness(workflow([video]))
    expect(result.requirements.filter((item) => item.kind === 'configuration')).toEqual([])
    expect(result.requirements).toContainEqual(expect.objectContaining({ kind: 'model', message: expect.stringContaining('已保留生成音频关闭设置') }))
    expect(result.requestCounts.video).toBe(3)
    video.data.model = 'grok-imagine-video'
    expect(analyzeWorkshopReadiness(workflow([video])).requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('分辨率') }))
  })

  it('preserves an Ark multimodal silent configuration without guessing a cleared owner source', () => {
    const image = node('image', 'image-input'), clip = node('clip', 'video-input'), sound = node('sound', 'audio-input')
    const video = node('ark', 'video-generate', { videoMode: 'ref2va', videoResolution: '720p', videoAspectRatio: '1:1', generateAudio: false, videoReferenceOrder: { version: 1, slots: [{ edgeId: 'clip-ark', outputIndex: 0 }, { edgeId: 'image-ark', outputIndex: 0 }, { edgeId: 'sound-ark', outputIndex: 0 }] } })
    video.data = { ...video.data, prompt: 'Product movement', model: 'doubao-seedance-2-0-mini-260615', size: 'auto', seconds: '5', videoCandidateCount: 2 }
    const value = workflow([image, clip, sound, video], [edge('image', 'ark', 'out:image', 'in:images'), edge('clip', 'ark', 'out:video', 'in:videos'), edge('sound', 'ark', 'out:audio', 'in:audios')]), before = structuredClone(value)
    for (const context of [{}, { videoProtocol: 'ark-seedance' as const }]) {
      const result = analyzeWorkshopReadiness(value, context)
      expect(result.requestCounts.video).toBe(2)
      expect(result.requirements.filter((item) => item.kind === 'configuration')).toEqual([])
      expect(result.requirements).toContainEqual(expect.objectContaining({ kind: 'model', message: expect.stringContaining('已保留生成音频关闭设置') }))
      expect(result.requirements).toContainEqual(expect.objectContaining({ kind: 'model', message: expect.stringContaining('重新选择支持此模型和音频控制的兼容视频来源') }))
      expect(JSON.stringify(result)).not.toContain('xAI')
    }
    expect(value).toEqual(before)
    const incompatible = analyzeWorkshopReadiness(value, { videoProtocol: 'relay-videos' })
    expect(incompatible.requirements).toContainEqual(expect.objectContaining({ nodeId: 'ark', kind: 'configuration', message: expect.stringContaining('所选视频来源与配置不兼容') }))
    value.edges.pop()
    expect(analyzeWorkshopReadiness(value).requirements).toContainEqual(expect.objectContaining({ nodeId: 'ark', kind: 'configuration', message: expect.stringContaining('位置缺失') }))
  })

  it('never falls back to another protocol when a selected source rejects the saved parameters', () => {
    const video = node('video', 'video-generate', { generateAudio: false, videoResolution: '1080p' })
    video.data.model = 'grok-imagine-video-1.5'; video.data.prompt = 'Quiet scene'
    const value = workflow([video])
    expect(analyzeWorkshopReadiness(value, { videoProtocol: 'xai-native' }).requirements.filter((item) => item.kind === 'configuration')).toEqual([])
    expect(analyzeWorkshopReadiness(value, { videoProtocol: 'relay-videos' }).requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('所选视频来源与配置不兼容') }))
    expect(analyzeWorkshopReadiness(value, { videoProtocol: 'ark-seedance' }).requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('所选视频来源与配置不兼容') }))
  })

  it('discloses saved web search costs and source compatibility without claiming account readiness', () => {
    const text = node('search', 'text-generate')
    text.data = { ...text.data, prompt: 'Find sources', model: 'gpt-4.1', textWebSearch: true }
    const value = workflow([text]), before = structuredClone(value)
    const result = analyzeWorkshopReadiness(value)
    expect(result.requestCounts).toEqual({ image: 0, video: 0, text: 1 })
    expect(result.nodes[0]).toMatchObject({ webSearch: true, maximumRequestCount: 1, modelHint: 'gpt-4.1', execution: 'model' })
    expect(result.nodes[0].requirements).toEqual([expect.objectContaining({ kind: 'model', modelPurpose: 'text', message: expect.stringContaining('确认来源支持 Responses 联网搜索') })])
    expect(result.notices.join(' ')).toContain('最多调用 1 次搜索')
    expect(result.notices.join(' ')).toContain('模型生成与搜索费用均按所选来源计费')
    expect(result.notices.join(' ')).toContain('不代表刚刚联网')
    expect(value).toEqual(before)
  })

  it('lists unsupported saved search models through the shared protocol validator despite an omitted provider', () => {
    const text = node('search', 'text-generate')
    text.data = { ...text.data, prompt: 'Find sources', model: 'custom-text', textWebSearch: true }
    const result = analyzeWorkshopReadiness(workflow([text]))
    expect(result.nodes[0].webSearch).toBe(true)
    expect(result.nodes[0].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('当前模型尚未接通联网搜索') }))
    expect(result.nodes[0].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('不会改为普通文字生成') }))
    expect(result.requestCounts.text).toBe(1)
  })

  it('does not advertise search fees for omitted, disabled or skipped search configurations', () => {
    const off = node('off', 'text-generate'); off.data.textWebSearch = false; off.data.model = 'custom-text'
    const ordinary = node('ordinary', 'text-generate')
    const disabled = node('disabled', 'text-generate'); disabled.data.textWebSearch = true; disabled.disabled = true
    const downstream = node('downstream', 'text-generate'); downstream.data.textWebSearch = true
    const result = analyzeWorkshopReadiness(workflow([off, ordinary, disabled, downstream], [edge('disabled', 'downstream', 'out:text', 'in:text')]))
    expect(result.nodes.map((entry) => entry.nodeId)).toEqual(['off', 'ordinary'])
    expect(result.nodes.every((entry) => entry.webSearch === undefined)).toBe(true)
    expect(result.notices.join(' ')).not.toContain('搜索')
    expect(result.requirements.some((entry) => entry.message.includes('Responses'))).toBe(false)
    expect(result.skippedNodeCount).toBe(2)
  })

  it('keeps supported visual text templates configuration-only and discloses source and original-image checks', () => {
    const text = node('text', 'text-generate')
    text.data = { ...text.data, prompt: 'Compare the four pictures', model: 'gpt-4.1', textWebSearch: true }
    const images = Array.from({ length: 4 }, (_, index) => node(`image-${index}`, 'image-input'))
    const value = workflow([...images, text], images.map((image) => edge(image.id, text.id, 'out:image', 'in:images')))
    const before = structuredClone(value), result = analyzeWorkshopReadiness(value)
    expect(result.nodes.at(-1)?.requirements.filter((item) => item.kind === 'configuration' || item.kind === 'image')).toEqual([])
    expect(result.nodes.at(-1)?.requirements).toContainEqual(expect.objectContaining({ kind: 'model', message: expect.stringContaining('Responses 图片输入与联网搜索') }))
    expect(result.requirements.filter((item) => item.kind === 'image')).toHaveLength(4)
    expect(result.notices.join(' ')).toContain('工坊不携带原图')
    expect(result.notices.join(' ')).toContain('归属、格式、像素和字节限制')
    expect(result.requestCounts).toEqual({ image: 0, video: 0, text: 1 })
    expect(value).toEqual(before)
  })

  it('reports both an unsupported visual model and too many repeated image bindings', () => {
    const image = node('image', 'image-input'), text = node('text', 'text-generate')
    text.data = { ...text.data, prompt: 'Read pictures', model: 'unknown-vision-model' }
    const value = workflow([image, text], Array.from({ length: 5 }, (_, index) => ({ ...edge(image.id, text.id, 'out:image', 'in:images'), id: `binding-${index}` })))
    const result = analyzeWorkshopReadiness(value)
    const errors = result.nodes[1].requirements.filter((item) => item.kind === 'configuration')
    expect(errors).toHaveLength(2)
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('尚未确认支持图片理解') }))
    expect(errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining('最多支持 4 张') }))
    expect(result.requestCounts.text).toBe(1)
  })

  it('expands visual text grid batches but accepts only their selected image output', () => {
    const image = node('image', 'image-input'), grid = node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } })
    const text = node('text', 'text-generate'); text.data = { ...text.data, prompt: 'Read images', model: 'gpt-4.1' }
    const value = workflow([image, grid, text], [edge(image.id, grid.id), edge(grid.id, text.id, 'out:images', 'in:images')])
    expect(analyzeWorkshopReadiness(value).nodes[2].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('最多支持 4 张') }))
    value.edges[1].sourceHandle = 'out:image'
    expect(analyzeWorkshopReadiness(value).nodes[2].requirements.filter((item) => item.kind !== 'model')).toEqual([])
  })

  it('reports each empty visual source even when another image binding is usable', () => {
    const text = node('text', 'text-generate'); text.data = { ...text.data, prompt: 'Compare pictures', model: 'gpt-4.1' }
    const value = workflow([node('image', 'image-input'), node('empty', 'gallery'), text], [edge('image', text.id, 'out:image', 'in:images'), edge('empty', text.id, 'out:image', 'in:images')])
    const result = analyzeWorkshopReadiness(value)
    expect(result.nodes[2].requirements).toContainEqual(expect.objectContaining({ kind: 'image', message: expect.stringContaining('不会跳过缺图后继续生成') }))
    expect(result.requestCounts.text).toBe(1)
  })

  it('flags disconnected or mismatched visual source ports instead of silently treating them as text-only', () => {
    const text = node('text', 'text-generate'); text.data = { ...text.data, prompt: 'Read an image', model: 'unknown-model' }
    for (const connection of [edge('missing', text.id, 'out:image', 'in:images'), edge('prompt', text.id, 'out:text', 'in:images')]) {
      const result = analyzeWorkshopReadiness(workflow([node('prompt', 'prompt'), text], [connection]))
      expect(result.nodes[1].requirements).toContainEqual(expect.objectContaining({ kind: 'image', message: expect.stringContaining('来源或端口无效') }))
      expect(result.nodes[1].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('尚未确认支持图片理解') }))
    }
  })

  it('keeps unknown visual batch sizes uncertain and does not reuse saved candidate counts as proof', () => {
    const image = node('image', 'image-input')
    const grid = node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 0, columns: 3, gap: 0, padding: 0 } }); grid.data.candidateAssetIds = Array.from({ length: 5 }, (_, index) => String(index).repeat(43))
    const text = node('text', 'text-generate'); text.data = { ...text.data, prompt: 'Read images', model: 'gpt-4.1' }
    const result = analyzeWorkshopReadiness(workflow([image, grid, text], [edge(image.id, grid.id), edge(grid.id, text.id, 'out:images', 'in:images')]))
    expect(result.nodes[2].requirements.filter((item) => item.kind !== 'model')).toEqual([])
    expect(result.notices.join(' ')).toContain('实际展开数量不超过 4 张')
    expect(result.notices.join(' ')).toContain('不按旧生成结果推断')
  })

  it('does not require optional visual inputs or visual capabilities for plain-text and skipped nodes', () => {
    const text = node('text', 'text-generate'); text.data = { ...text.data, prompt: 'Write a story', model: 'custom-text-model' }
    const result = analyzeWorkshopReadiness(workflow([text]))
    expect(result.nodes[0].requirements).toEqual([expect.objectContaining({ kind: 'model' })])
    expect(JSON.stringify(result)).not.toMatch(/视觉|图片理解|图片输入|原图/)
    const image = node('disabled-image', 'image-input'); image.disabled = true
    const skipped = analyzeWorkshopReadiness(workflow([image, text], [edge(image.id, text.id, 'out:image', 'in:images')]))
    expect(skipped.nodes).toEqual([])
    expect(skipped.requestCounts.text).toBe(0)
    expect(JSON.stringify(skipped.notices)).not.toMatch(/视觉|图片理解|图片输入|原图/)
  })

  it('separates enabled model nodes from maximum independent requests and excludes disabled batches', () => {
    const image = node('image', 'image-generate'); image.data.imageCandidateCount = 3
    const edit = node('edit', 'image-edit'); edit.data.imageCandidateCount = 2
    const disabled = node('disabled', 'image-generate'); disabled.data.imageCandidateCount = 4; disabled.disabled = true
    const downstream = node('downstream', 'image-edit'); downstream.data.imageCandidateCount = 4
    const result = analyzeWorkshopReadiness(workflow([image, edit, disabled, downstream, node('video', 'video-generate'), node('text', 'text-generate')], [edge('disabled', 'downstream', 'out:image', 'in:images')]))
    expect(result.modelNodeCounts).toEqual({ image: 2, video: 1, text: 1 })
    expect(result.requestCounts).toEqual({ image: 5, video: 1, text: 1 })
    expect(result.skippedNodeCount).toBe(2)
    expect(result.nodes.find((entry) => entry.nodeId === 'image')?.maximumRequestCount).toBe(3)
    expect(result.nodes.find((entry) => entry.nodeId === 'disabled')).toBeUndefined()
    expect(result.notices.join(' ')).toContain('具体金额需在画布运行前核对')
  })
  it('reports invalid saved batch counts without inventing a request estimate or claiming local-only work', () => {
    const image = node('image', 'image-generate')
    Object.assign(image.data, { imageCandidateCount: 5 })
    const result = analyzeWorkshopReadiness(workflow([image]))
    expect(result.modelNodeCounts.image).toBe(1)
    expect(result.requestCounts.image).toBe(0)
    expect(result.localOnly).toBe(false)
    expect(result.requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('1 到 4') }))
  })
  it.each(imageCollageTemplates)('reports $title exact input requirements without adding model setup', (template) => {
    const inputs = [node('a', 'image-input'), node('b', 'image-input'), node('c', 'image-input')]
    const collage = node('collage', 'image-collage', { imageTransform: { ...defaultImageTransformRecipe('collage'), layout: template.layout } })
    for (const count of [1, 2, 3]) {
      const result = analyzeWorkshopReadiness(workflow([...inputs.slice(0, count), collage], inputs.slice(0, count).map((input) => edge(input.id, 'collage', 'out:image', 'in:images'))))
      expect(result.localOnly).toBe(true)
      expect(result.requestCounts).toEqual({ image: 0, video: 0, text: 0 })
      const requirements = result.requirements.filter((entry) => entry.nodeId === 'collage')
      expect(requirements).toHaveLength(count === template.inputCount ? 0 : 1)
      if (requirements.length) expect(requirements[0].message).toContain(`恰好 ${template.inputCount} 张`)
    }
  })
  it('shares collage layout capacities with execution while retaining material and disabled-branch requirements', () => {
    const base = defaultImageTransformRecipe('collage')
    const input = node('input', 'image-input')
    const grid = node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } })
    const collage = node('collage', 'image-collage')
    const document = workflow([input, grid, collage], [edge('input', 'grid'), edge('grid', 'collage', 'out:images', 'in:images')])
    for (const layout of ['horizontal', 'vertical', 'hero-left', 'hero-top'] as const) {
      collage.data.settings = { imageTransform: { ...base, layout } }
      const requirements = analyzeWorkshopReadiness(document).requirements
      expect(requirements).toContainEqual(expect.objectContaining({ nodeId: 'input', kind: 'image' }))
      expect(requirements.filter((entry) => entry.nodeId === 'collage')).toHaveLength(layout.startsWith('hero') ? 1 : 0)
      if (layout.startsWith('hero')) expect(requirements).toContainEqual(expect.objectContaining({ nodeId: 'collage', message: expect.stringContaining('2–3') }))
    }
    grid.disabled = true
    expect(analyzeWorkshopReadiness(document).requirements.some((entry) => entry.nodeId === 'collage')).toBe(false)
  })

  it('reports the true material entry point without demanding a model for local processing', () => {
    const result = analyzeWorkshopReadiness(workflow([node('input', 'image-input'), node('crop', 'image-crop')], [edge('input', 'crop')]))
    expect(result.localOnly).toBe(true)
    expect(result.requestCounts).toEqual({ image: 0, video: 0, text: 0 })
    expect(result.requirements).toEqual([expect.objectContaining({ nodeId: 'input', kind: 'image' })])
    expect(result.nodes.find((entry) => entry.nodeId === 'crop')?.requirements).toEqual([])
  })

  it('uses recipe source requirements for empty, content-only and bitmap layer stacks', () => {
    const base = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    const content: ImageLayerRecipe = { ...base, explicitLayers: true, layers: [{ sourceIndex: 19, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'text', text: '标题', color: '#ffffff', fontFamily: 'sans-serif', fontSize: 30, fontWeight: 400, align: 'left' } }] }
    for (const recipe of [{ ...base, explicitLayers: true }, content]) {
      const result = analyzeWorkshopReadiness(workflow([node('layer', 'image-layer', { imageTransform: recipe })]))
      expect(result.localOnly).toBe(true)
      expect(result.requirements).toEqual([])
    }
    expect(analyzeWorkshopReadiness(workflow([node('legacy', 'image-layer', { imageTransform: base })])).requirements).toEqual([expect.objectContaining({ kind: 'image' })])
    const bitmap = { ...content, layers: [{ ...content.layers[0], content: undefined, sourceIndex: 0 }] }
    expect(analyzeWorkshopReadiness(workflow([node('bitmap', 'image-layer', { imageTransform: bitmap })])).requirements.some((entry) => entry.kind === 'image')).toBe(true)
  })

  it('counts enabled model nodes and treats saved models as unverified hints', () => {
    const prompt = node('prompt', 'prompt'); prompt.data.prompt = '咖啡海报'
    const image = node('image', 'image-generate', { title: '商品主图' }); image.data.model = 'saved-image-model'; image.data.group = 'old-private-group'
    const text = node('text', 'drama-parse'); text.data.prompt = '剧本'
    const result = analyzeWorkshopReadiness(workflow([prompt, image, text], [edge('prompt', 'image', 'out:text', 'in:text')]))
    // A drama parse may be asked twice when the first answer is not a readable table.
    expect(result.requestCounts).toEqual({ image: 1, video: 0, text: 2 })
    expect(result.nodes.find((entry) => entry.nodeId === 'text')).toMatchObject({ maximumRequestCount: 2 })
    expect(result.localOnly).toBe(false)
    expect(result.nodes.find((entry) => entry.nodeId === 'image')).toMatchObject({ title: '商品主图', modelHint: 'saved-image-model', execution: 'model', requirements: [expect.objectContaining({ kind: 'model', modelPurpose: 'image' })] })
    expect(JSON.stringify(result)).not.toContain('old-private-group')
  })

  it('does not count disabled branches or structural groups as pending model requests', () => {
    const source = node('disabled', 'prompt'); source.disabled = true
    const result = analyzeWorkshopReadiness(workflow([source, node('image', 'image-generate'), node('group', 'group'), node('note', 'note')], [edge('disabled', 'image', 'out:text', 'in:text')]))
    expect(result.nodes).toEqual([])
    expect(result.skippedNodeCount).toBe(2)
    expect(result.skippedNodes).toEqual([{ nodeId: 'disabled', reasonCode: 'disabled', message: '节点已禁用' }, { nodeId: 'image', reasonCode: 'upstream-skip', message: '上游节点已跳过' }])
    expect(result.requestCounts.image).toBe(0)
  })

  it('does not accept an empty text chain or mismatched port as a usable prompt', () => {
    const result = analyzeWorkshopReadiness(workflow([node('prompt', 'prompt'), node('router', 'router'), node('image', 'image-generate')], [edge('prompt', 'router', 'out:text', 'in:text'), edge('router', 'image', 'out:text', 'in:text')]))
    expect(result.nodes.find((entry) => entry.nodeId === 'image')?.requirements.some((entry) => entry.kind === 'prompt')).toBe(true)
    const mismatched = analyzeWorkshopReadiness(workflow([node('input', 'video-input'), node('crop', 'image-crop')], [edge('input', 'crop', 'out:video', 'in:image')]))
    expect(mismatched.nodes.find((entry) => entry.nodeId === 'crop')?.requirements.some((entry) => entry.kind === 'image')).toBe(true)
  })

  it('distinguishes optional image references from required image-edit inputs', () => {
    const generate = node('generate', 'image-generate'); generate.data.prompt = '海报'
    const edit = node('edit', 'image-edit'); edit.data.prompt = '修改颜色'
    const result = analyzeWorkshopReadiness(workflow([generate, edit]))
    expect(result.nodes[0].requirements.map((entry) => entry.kind)).toEqual(['model'])
    expect(result.nodes[1].requirements.map((entry) => entry.kind)).toEqual(['model', 'image'])
  })

  it('validates selected-image and bitmap index constraints with the shared preflight', () => {
    const grid = node('grid', 'image-grid-split')
    const result = analyzeWorkshopReadiness(workflow([grid, node('crop', 'image-crop')], [edge('grid', 'crop', 'out:images')]))
    expect(result.nodes.find((entry) => entry.nodeId === 'crop')?.requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('单图输出') }))
    const layer = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    layer.layers = [{ sourceIndex: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: false }]
    const invalid = analyzeWorkshopReadiness(workflow([node('input', 'image-input'), node('layer', 'image-layer', { imageTransform: layer })], [edge('input', 'layer', 'out:image', 'in:images')]))
    expect(invalid.nodes[1].requirements).toEqual([expect.objectContaining({ kind: 'image', message: expect.stringContaining('至少连接 2 张图片，并按原图层引用顺序对应') })])
  })

  it('states the full ordered bitmap input span without counting content layers or deduplicating sparse source indices', () => {
    const base = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    const bitmap = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over' as const, visible: true }
    const recipe: ImageLayerRecipe = { ...base, explicitLayers: true, layers: [bitmap, { ...bitmap, sourceIndex: 3 }, { ...bitmap, sourceIndex: 3 }, { ...bitmap, sourceIndex: 19, content: { kind: 'text', text: '标题', color: '#ffffff', fontFamily: 'sans-serif', fontSize: 30, fontWeight: 400, align: 'left' } }], layerGroups: { version: 1, layerIds: ['a', 'b', 'c', 'd'], groups: [{ id: 'folder', name: '四来源海报', children: ['a', 'b', 'c', 'd'], visible: true, locked: false }] } }
    for (const count of [0, 1, 3, 4]) {
      const inputs = Array.from({ length: count }, (_, index) => node(`input-${index}`, 'image-input'))
      const value = workflow([...inputs, node('layer', 'image-layer', { imageTransform: recipe })], inputs.map((source) => edge(source.id, 'layer', 'out:image', 'in:images')))
      const result = analyzeWorkshopReadiness(value).nodes.find((entry) => entry.nodeId === 'layer')!
      expect(result.requirements).toEqual(count === 4 ? [] : [expect.objectContaining({ kind: 'image', message: expect.stringContaining('至少连接 4 张图片，并按原图层引用顺序对应') })])
    }
  })

  it('reports video mode input constraints and keeps browser previews local', () => {
    const video = node('video', 'video-generate', { videoMode: 'fl2va' }); video.data.model = 'minimax-h3-base'; video.data.prompt = '镜头推进'
    const result = analyzeWorkshopReadiness(workflow([video, node('frame', 'frame-extract'), node('compare', 'image-compare'), node('panorama', 'image-panorama')], [edge('video', 'frame', 'out:video', 'in:video'), edge('frame', 'compare', 'out:image', 'in:images'), edge('frame', 'panorama')]))
    expect(result.requestCounts).toEqual({ image: 0, video: 1, text: 0 })
    expect(result.nodes[0].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('两张图片') }))
    expect(result.nodes.slice(1).every((entry) => entry.execution === 'local' && entry.requirements.length === 0)).toBe(true)
  })

  it('expands explicit grid batches for input limits without counting them as model requests', () => {
    const grid = node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } })
    const image = node('image', 'image-edit'); image.data.prompt = '修改'
    const result = analyzeWorkshopReadiness(workflow([grid, image, node('collage', 'image-collage')], [edge('grid', 'image', 'out:images', 'in:images'), ...Array.from({ length: 3 }, (_, index) => ({ ...edge('grid', 'collage', 'out:images', 'in:images'), id: `batch-${index}` }))]))
    expect(result.nodes[1].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('4 张') }))
    expect(result.nodes[2].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration', message: expect.stringContaining('20 张') }))
    expect(result.requestCounts).toEqual({ image: 1, video: 0, text: 0 })
  })

  it('shows the exact grid-to-collage capacity once even when the reusable source still needs an image', () => {
    const grid = node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } })
    const collage = node('collage', 'image-collage')
    const value = workflow([node('input', 'image-input'), grid, collage], [edge('input', 'grid'), edge('grid', 'collage', 'out:images', 'in:images')])
    const result = analyzeWorkshopReadiness(value)
    expect(result.nodes[0].requirements).toEqual([expect.objectContaining({ kind: 'image' })])
    expect(result.nodes[2].requirements).toEqual([expect.objectContaining({ kind: 'configuration', message: '9 张输入需至少 9 格，当前 2×2=4 格，请调整拼图行列' })])
    expect(result.localOnly).toBe(true)
    const recipe = defaultImageTransformRecipe('collage')
    if (recipe.kind !== 'collage') throw new Error('bad fixture')
    collage.data.settings = { imageTransform: { ...recipe, rows: 3, columns: 3 } }
    expect(analyzeWorkshopReadiness(value).nodes[2].requirements).toEqual([])
    collage.data.settings = undefined
    value.edges[1].sourceHandle = 'out:image'
    expect(analyzeWorkshopReadiness(value).nodes[2].requirements).toEqual([])
  })

  it('counts repeated collage inputs while accepting tile pools with a valid selected slot', () => {
    const grid = node('grid', 'image-grid-split'), tile = node('tile', 'image-tile'), collage = node('collage', 'image-collage')
    const value = workflow([grid, tile, collage], [edge('grid', 'tile', 'out:images'), ...Array.from({ length: 5 }, (_, i) => ({ ...edge('grid', 'collage', 'out:image', 'in:images'), id: `selected-${i}` }))])
    const result = analyzeWorkshopReadiness(value)
    expect(result.nodes[1].requirements).toEqual([])
    expect(result.nodes[2].requirements).toContainEqual(expect.objectContaining({ message: '5 张输入需至少 5 格，当前 2×2=4 格，请调整拼图行列' }))
    value.edges[0].sourceHandle = 'out:image'
    expect(analyzeWorkshopReadiness(value).nodes[1].requirements).toEqual([])
    value.edges.push({ ...value.edges[0], id: 'second-selected' })
    expect(analyzeWorkshopReadiness(value).nodes[1].requirements).toEqual([])
    tile.data.settings = { ...tile.data.settings, tileInput: { missing: true } }
    expect(analyzeWorkshopReadiness(value).nodes[1].requirements).toContainEqual(expect.objectContaining({ kind: 'configuration' }))
  })

  it('does not report capacity for disabled branches or turn unknown batches into false layer-index failures', () => {
    const grid = node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 0, columns: 3, gap: 0, padding: 0 } })
    const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    recipe.layers = [{ sourceIndex: 8, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: false }]
    const value = workflow([grid, node('layer', 'image-layer', { imageTransform: recipe }), node('collage', 'image-collage')], [edge('grid', 'layer', 'out:images', 'in:images'), edge('grid', 'collage', 'out:images', 'in:images')])
    const result = analyzeWorkshopReadiness(value)
    expect(result.nodes[0].requirements.some((entry) => entry.kind === 'configuration')).toBe(true)
    expect(result.nodes[1].requirements).toEqual([])
    expect(result.nodes[2].requirements).toEqual([])
    expect(result.notices.some((notice) => notice.includes('数量尚不能确定'))).toBe(true)
    grid.disabled = true
    const disabled = analyzeWorkshopReadiness(value)
    expect(disabled.nodes).toEqual([])
    expect(disabled.skippedNodeCount).toBe(3)
    expect(disabled.notices.some((notice) => notice.includes('数量尚不能确定'))).toBe(false)
  })
})
