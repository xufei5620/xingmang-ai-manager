import { defaultCommerceTask } from '../commerce/commerce-task'
import { defaultInteriorTask } from '../interior/interior-task'
import { createElement, type CSSProperties, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNodeConnections, type NodeProps } from '@xyflow/react'
import { CanvasModelAvailabilityProvider, CanvasUpstreamReferencesProvider, CanvasNodeViewProvider, nodeTypes, type CanvasNode } from './WorkflowNodes'
import type { NodeKind, WorkflowNodeData } from '../model'
import { resolveCanvasCapabilities, v2EquivalentCapabilities } from '../host-capabilities'
import { fullCanvasCapabilities, fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'

vi.mock('@xyflow/react', () => ({
  Handle: (props: { id?: string; style?: CSSProperties; className?: string; 'aria-label'?: string }) => createElement('span', { 'data-handle': props.id, style: props.style, className: props.className, 'aria-label': props['aria-label'] }),
  NodeResizer: () => null,
  NodeToolbar: (props: { children: ReactNode; style?: CSSProperties }) => createElement('aside', { style: props.style }, props.children),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useNodeConnections: vi.fn(() => []),
  useConnection: () => ({ inProgress: false }),
  useStore: (select: (state: { width: number; height: number; transform: number[]; nodeLookup: Map<string, unknown> }) => unknown) => select({ width: 1200, height: 900, transform: [0, 0, 1], nodeLookup: new Map() }),
}))

function renderNode(kind: NodeKind, data: Partial<WorkflowNodeData> & { __canvasDisabled?: boolean } = {}, selected = false, availability: Partial<Parameters<typeof CanvasModelAvailabilityProvider>[0]> = {}, view: Omit<Partial<Parameters<typeof CanvasNodeViewProvider>[0]>, 'children'> = {}): string {
  const props: NodeProps<CanvasNode> = {
    id: 'test-node', type: kind, data: { prompt: '', model: '', status: 'idle', ...data }, selected,
    dragging: false, draggable: true, deletable: true, selectable: true, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0,
  }
  return renderToStaticMarkup(createElement(CanvasModelAvailabilityProvider, {
    connected: true, imageModels: [], videoModels: [], textModels: [], ...availability,
    children: createElement(CanvasNodeViewProvider, { lod: 'detail', ...view, children: createElement(nodeTypes[kind], props) }),
  }))
}

beforeEach(() => { vi.mocked(useNodeConnections).mockReturnValue([]) })

describe('workflow node feedback', () => {
  it('marks a node the host cannot run and offers no run action on it', () => {
    const data = { model: 'gpt-4.1' }, availability = { textModels: ['gpt-4.1'] }
    expect(renderNode('text-generate', data, false, availability)).not.toContain('当前客户端不支持')
    expect(renderNode('text-generate', data, false, availability, { capabilities: fullCanvasCapabilityProfile })).not.toContain('当前客户端不支持')
    expect(renderNode('text-generate', data, false, availability, { capabilities: v2EquivalentCapabilities })).toContain('当前客户端不支持')
    expect(renderNode('image-generate', {}, false, {}, { capabilities: v2EquivalentCapabilities })).not.toContain('当前客户端不支持')
  })
  it('says on the note itself when the host cannot store its text', () => {
    const v2 = { capabilities: v2EquivalentCapabilities }, full = { capabilities: fullCanvasCapabilityProfile }
    const long = renderNode('note', { settings: { text: '说'.repeat(10_001) } }, false, {}, v2)
    expect(long).toContain('当前客户端的便签最多 1 万字，这条便签现在存不进去，改好以后才会保存')
    expect(long).toContain('aria-invalid="true"')
    expect(renderNode('note', { settings: { text: 'https://example.invalid' } }, false, {}, v2)).toContain('当前客户端的便签不能以网址或文件路径开头，这条便签现在存不进去，改好以后才会保存')
    expect(renderNode('note', { settings: { text: '说'.repeat(10_001) } }, false, {}, full)).not.toContain('存不进去')
    expect(renderNode('note', { settings: { text: '说'.repeat(10_000) } }, false, {}, v2)).not.toContain('存不进去')
    expect(renderNode('note', { settings: { text: '说'.repeat(10_001) } })).not.toContain('存不进去')
  })
  it('offers the image resolutions and video models the host declares', () => {
    const v2 = { capabilities: v2EquivalentCapabilities }
    const gemini = { model: 'gemini-3.1-flash-image', size: '1280x720', imageResolution: '2K' as const }, images = { imageModels: ['gemini-3.1-flash-image'] }
    expect(renderNode('image-generate', gemini, true, images, v2)).not.toContain('2K（当前组合不支持）')
    expect(renderNode('image-generate', gemini, true, images, v2)).toContain('<option value="4K">4K</option>')
    expect(renderNode('image-generate', gemini, true, images)).toContain('2K（当前组合不支持）')
    const videos = { videoModels: ['minimax-h3-mini', 'doubao-seedance-2-0-mini-260615'] }
    expect(renderNode('video-generate', { model: 'minimax-h3-mini' }, true, videos, v2)).not.toContain('Seedance')
    expect(renderNode('video-generate', { model: 'minimax-h3-mini' }, true, videos)).toContain('Seedance')
  })
  it('offers no control for a switch the host has off, unless the node already uses it', () => {
    const v2 = { capabilities: v2EquivalentCapabilities }, full = { capabilities: fullCanvasCapabilityProfile }
    const noSearch = { capabilities: resolveCanvasCapabilities({ ...fullCanvasCapabilities, features: { ...fullCanvasCapabilities.features, textWebSearch: false } }) }
    const text = { textModels: ['gpt-4.1'] }
    expect(renderNode('text-generate', { model: 'gpt-4.1' }, false, text, full)).toContain('aria-label="联网搜索"')
    expect(renderNode('text-generate', { model: 'gpt-4.1' }, false, text, noSearch)).not.toContain('aria-label="联网搜索"')
    expect(renderNode('text-generate', { model: 'gpt-4.1', textWebSearch: true }, false, text, noSearch)).toContain('aria-label="联网搜索"')

    expect(renderNode('image-edit', {}, true, {}, full)).toContain('添加局部修改蒙版')
    expect(renderNode('image-edit', {}, true, {}, v2)).not.toContain('添加局部修改蒙版')
    const masked = renderNode('image-edit', { settings: { imageEditMask: { version: 1, width: 8, height: 8, strokes: [] } } }, true, {}, v2)
    expect(masked).toContain('移除蒙版')
    expect(masked).not.toContain('编辑蒙版')

    expect(renderNode('image-generate', { model: 'gpt-image-1' }, true, {}, full)).toContain('aria-label="生成数量"')
    expect(renderNode('image-generate', { model: 'gpt-image-1' }, true, {}, v2)).not.toContain('aria-label="生成数量"')
    expect(renderNode('image-generate', { model: 'gpt-image-1' }, true, {}, v2)).not.toContain('次独立生成')
    const saved = renderNode('image-generate', { model: 'gpt-image-1', imageCandidateCount: 3 }, true, {}, v2)
    expect(saved).toMatch(/aria-label="生成数量"[\s\S]*?<option value="3" selected="">×3<\/option>/)
    expect(saved).not.toContain('<option value="2">')

    expect(renderNode('video-generate', {}, true, {}, full)).toContain('aria-label="视频生成数量"')
    expect(renderNode('video-generate', {}, true, {}, v2)).not.toContain('aria-label="视频生成数量"')
    expect(renderNode('video-generate', {}, true, {}, v2)).not.toContain('<span>生成音频</span>')
    expect(renderNode('video-generate', { settings: { generateAudio: false } }, true, {}, v2)).toContain('<span>生成音频</span>')

    expect(renderNode('router', {}, false, {}, full)).toContain('aria-label="路由策略"')
    expect(renderNode('router', {}, false, {}, v2)).not.toContain('aria-label="路由策略"')
    expect(renderNode('router', { settings: { routerStrategy: { version: 1, strategy: 'all' } } }, false, {}, v2)).toContain('aria-label="路由策略"')
  })
  it('renders legacy router execution honestly and locks strategy edits with the surrounding node state', () => {
    expect(renderNode('router', { settings: { strategy: 'first-available' } })).toContain('旧配置实际保留全部输入')
    for (const data of [{ status: 'running' as const }, { status: 'queued' as const }, { __canvasDisabled: true }, { __canvasLocked: true }]) {
      expect(renderNode('router', { settings: { routerStrategy: { version: 1, strategy: 'all' } }, ...data })).toMatch(/aria-label="路由策略"[^>]*disabled=""/)
    }
    expect(renderNode('router', {}, false, {}, { readOnly: true })).not.toContain('aria-label="路由策略"')
    expect(renderNode('router', { settings: { routerStrategy: { version: 1, strategy: 'first-available' } } })).toContain('首段非空文本')
  })
  it('renders model choices from a pinned source and never shows the project default catalog as its choices', () => {
    const html = renderNode('image-generate', { group: 'fixed', model: 'gpt-image-1' }, true, { imageModels: ['gpt-image-2'], imageModel: 'gpt-image-2', sourceCatalog: { fixed: { state: 'ready', models: ['gpt-image-1'], purposes: ['image'], label: '本人固定来源' } } })
    expect(html).toContain('固定来源：本人固定来源'); expect(html).toContain('<option value="gpt-image-1" selected=""'); expect(html).not.toContain('<option value="gpt-image-2"')
    expect(html).not.toContain('当前分组不提供此图像模型')
  })
  it('shows a missing pinned source without silently selecting the available default model', () => {
    const html = renderNode('image-generate', { group: 'foreign-owner', model: '' }, true, { imageModels: ['gpt-image-2'], imageModel: 'gpt-image-2', sourceCatalog: {} })
    expect(html).toContain('节点固定来源尚未核对或已不存在'); expect(html).not.toContain('<option value="gpt-image-2"')
  })
  it('shows saved interior controls in the selected media composer without expanding unselected or ordinary images', () => {
    const settings = { interiorTask: { ...defaultInteriorTask(), addPeople: true, exterior: 'sea' as const }, imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'original', outputIndex: 0 }] } }
    const selected = renderNode('image-generate', { settings, prompt: '保留天窗' }, true)
    expect(selected.match(/aria-label="室内渲染任务配置"/g)).toHaveLength(1)
    expect(selected).toContain('海景'); expect(selected).toContain('增加人物'); expect(selected).toContain('原图绑定已失效')
    expect(renderNode('image-generate', { settings, prompt: '保留天窗' })).not.toContain('aria-label="室内渲染任务配置"')
    expect(renderNode('image-generate', {}, true)).not.toContain('aria-label="室内渲染任务配置"')
  })
  it('renders completed candidates before the delayed React Flow store echo without changing markup on its measurement notification', () => {
    const result = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 320, height: 240 }
    const before: CanvasNode['data'] = { prompt: '', model: '', status: 'succeeded' }
    const completed: CanvasNode['data'] = { ...before, result, candidates: [{ candidateId: 'crop-result', attemptId: 'crop-attempt', createdAt: '', asset: result }] }
    const node: CanvasNode = { id: 'crop', type: 'image-crop', definitionVersion: 1, position: { x: 0, y: 0 }, data: completed }
    function render(flowData: CanvasNode['data'], nodes: CanvasNode[] = [node]) {
      return renderToStaticMarkup(createElement(CanvasUpstreamReferencesProvider, {
        nodes, edges: [], assets: [], children: createElement(nodeTypes['image-crop'], {
          id: 'crop', type: 'image-crop', data: flowData, selected: false, dragging: false,
          draggable: true, deletable: true, selectable: true, isConnectable: true,
          positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0,
        }),
      }))
    }
    const controlledCommit = render(before)
    expect(controlledCommit).toContain('class="wf-candidates nodrag"')
    expect(controlledCommit).toContain('aria-label="预览候选 1"')
    expect(controlledCommit).toContain('成品放到画布')
    expect(controlledCommit).toContain('wf-output-save')
    expect(render(completed)).toBe(controlledCommit)
    // A removed/replaced node must not resurrect stale Flow content while its
    // internal store waits for the corresponding parent effect.
    expect(render(completed, [])).toBe('')
    expect(render(completed, [{ ...node, type: 'image-grid-split' }])).toBe('')
  })

  it('uses the current controlled result when an older Flow echo still has a discarded candidate', () => {
    const stale: CanvasNode['data'] = { prompt: '', model: '', status: 'succeeded', outputText: '旧输出' }
    const current: CanvasNode = { id: 'output', type: 'output', definitionVersion: 1, position: { x: 0, y: 0 }, data: { ...stale, outputText: '本次完整输出' } }
    const html = renderToStaticMarkup(createElement(CanvasUpstreamReferencesProvider, {
      nodes: [current], edges: [], assets: [], children: createElement(nodeTypes.output, {
        id: 'output', type: 'output', data: stale, selected: false, dragging: false,
        draggable: true, deletable: true, selectable: true, isConnectable: true,
        positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0,
      }),
    }))
    expect(html).toContain('本次完整输出')
    expect(html).not.toContain('旧输出')
  })

  it('shows and reuses complete output-node text without an editable input or an empty-result message', () => {
    const html = renderNode('output', { prompt: 'not the result', outputText: '  完整文字\n第二行 ☕', status: 'succeeded' })
    expect(html).toContain('aria-label="输出文字结果"'); expect(html).toContain('完整文字\n第二行 ☕')
    expect(html).toContain('展开结果'); expect(html).toContain('下载文字结果 TXT'); expect(html).toContain('另存文本'); expect(html).toContain('存为提示词')
    expect(html).not.toContain('连接上游后运行'); expect(html).not.toContain('编辑全文'); expect(html).not.toContain('not the result')
    expect(renderNode('output')).toContain('连接上游后运行')
  })
  it('shows stale output text and a simultaneous media result without erasing either', () => {
    const html = renderNode('output', { outputText: '文字说明', dirty: true, status: 'failed', result: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } })
    expect(html).toContain('上次文字结果（输入已变化）'); expect(html).toContain('文字说明'); expect(html).toContain('class="wf-preview"')
  })
  it('keeps selected text node run buttons in document flow without a second fixed overlay', () => {
    const html = renderNode('text-generate', { model: 'text-model' }, true)
    expect(html).toContain('运行此节点')
    expect(html).not.toContain('wf-node-toolbar'); expect(html).not.toContain('bottom:56px')
    expect(html).not.toContain('运行到此'); expect(html).not.toContain('从此向后')
  })
  it('separates text editing from generated-output actions and explains unavailable output', () => {
    const input = renderNode('prompt', { prompt: '直接输入' })
    expect(input).toContain('aria-label="文本编辑操作"')
    expect(input).toContain('编辑全文')
    expect(input).not.toContain('生成结果操作')
    const empty = renderNode('text-generate')
    expect(empty).toContain('aria-label="生成结果操作"')
    expect(empty).toContain('当前没有可用的文字内容')
    const full = renderNode('text-generate', { prompt: '输入指令', outputText: '独立生成结果' })
    expect(full).toContain('复制生成结果'); expect(full).toContain('下载生成结果 TXT'); expect(full).toContain('另存文本')
    expect(full).toContain('输入指令'); expect(full).toContain('独立生成结果')
  })

  it('retains a long result while disabling only the smaller prompt-preset destination', () => {
    const html = renderNode('text-generate', { outputText: '字'.repeat(32_000) })
    expect(html).toContain('字'.repeat(32_000))
    expect(html).toContain('当前内容不会被截断')
    expect(html).toContain('24,000')
  })

  it('exposes local mask editing from a selected image and editable image node, but never video', () => {
    const result = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    expect(renderNode('image-input', { result }, true)).toContain('aria-label="局部修改"')
    expect(renderNode('image-generate', { result }, true)).toContain('aria-label="局部修改"')
    expect(renderNode('image-edit', {}, true)).toContain('添加局部修改蒙版')
    expect(renderNode('video-input', { result: { kind: 'video', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://video/${'a'.repeat(43)}` } }, true)).not.toContain('局部修改')
    const imageEditMask = { version: 1, width: 16, height: 16, strokes: [{ tool: 'brush', size: .2, points: [{ x: .5, y: .5 }] }] }
    const html = renderNode('image-edit', { model: 'gpt-image-1', settings: { imageEditMask } }, true)
    expect(html).toContain('编辑蒙版'); expect(html).toContain('移除蒙版'); expect(html).toContain('核对并绑定当前原图')
    expect(html).toMatch(/aria-label="开始生成"[^>]*disabled=""/)
  })

  it('keeps gallery progress in the existing status slot while run results are projected', () => {
    const assetId = 'a'.repeat(43)
    const result = { kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}`, width: 256, height: 256 }
    for (const status of ['idle', 'queued', 'running', 'succeeded', 'failed'] as const) {
      const html = renderNode('gallery', { status, result, candidateAssetIds: [assetId] })
      expect(html.match(/class="wf-gallery-empty wf-gallery-status nowheel"/g)).toHaveLength(1)
      expect(html).not.toContain('class="wf-progress"')
      expect(html).toContain('class="wf-preview"')
      if (status === 'queued') expect(html).toContain('等待上游完成，随后汇总候选…')
      else if (status === 'running') expect(html).toContain('正在汇总上游候选…')
      else expect(html).toContain('1 个候选，点击下方缩略图切换产物')
    }
    // Text generation has no gallery status slot and retains its detailed progress.
    expect(renderNode('text-generate', { status: 'running' })).toContain('class="wf-progress"')
  })
  it.each(['prompt', 'output'] as const)('keeps local %s progress in its header without image timing or a transient body', (kind) => {
    for (const status of ['queued', 'running'] as const) {
      const html = renderNode(kind, { status, prompt: '本地文字', outputText: kind === 'output' ? '保留已有结果' : undefined, quality: 'high' })
      expect(html).toContain('class="wf-head-progress"')
      expect(html).toContain(`wf-status-${status}`)
      expect(html).not.toContain('class="wf-progress"')
      expect(html).not.toContain('图像生成中')
      expect(html).not.toMatch(/预计.*分钟/)
      if (kind === 'output') expect(html).toContain('保留已有结果')
    }
    expect(renderNode(kind, { status: 'succeeded' })).not.toContain('class="wf-head-progress"')
  })
  it('provides a docked collapsible composer and groups only implemented advanced controls', () => {
    const html = renderNode('image-generate', { model: 'gpt-image-2' }, true)
    expect(html).toContain('data-placement="fixed"')
    expect(html).toContain('aria-label="收起生成输入区"')
    expect(html).toContain('<summary>更多参数</summary>')
    expect(html).toMatch(/<details class="wf-composer-more">[\s\S]*aria-label="生成画质"/)
    expect(html).toContain('aria-label="生成数量"')
    expect(html).toContain('最多发起 1 次独立生成，按次计费')
  })
  it.each(['image', 'image-generate', 'image-edit'] as const)('shows independent request counts on %s without inventing price estimates', (kind) => {
    const html = renderNode(kind, { model: 'gpt-image-1', imageCandidateCount: 4 }, true)
    expect(html).toMatch(/aria-label="生成数量"[\s\S]*?<option value="4" selected="">×4<\/option>/)
    for (const count of [1, 2, 3]) expect(html).toContain(`<option value="${count}">×${count}</option>`)
    expect(html).toContain('最多发起 4 次独立生成，按次计费；具体金额以所选服务为准')
    expect(html).not.toContain('积分')
    expect(renderNode(kind, { model: 'gpt-image-1', imageCandidateCount: 4, status: 'running' }, true)).toMatch(/aria-label="生成数量"[^>]*disabled=""/)
  })
  it('keeps image request counts off video nodes and retains the selected restored image asset', () => {
    expect(renderNode('video-generate', {}, true)).not.toContain('aria-label="生成数量"')
    const ids = ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43), 'd'.repeat(43)]
    const html = renderNode('image-generate', { imageCandidateCount: 4, candidateAssetIds: ids, result: { kind: 'image', assetId: ids[2], localUrl: `xingmang-asset://image/${ids[2]}` }, status: 'succeeded' })
    expect(html.match(/aria-label="预览候选 [1-4]"/g)).toHaveLength(4)
    expect(html).toMatch(/class="is-selected"[^>]*title="预览候选 3"/)
  })
  it.each(['video', 'video-generate'] as const)('shows independent video quantity controls and completed candidates on %s', (kind) => {
    const ids = ['a'.repeat(43), 'b'.repeat(43)]
    const candidates = ids.map((assetId, index) => ({ candidateId: `candidate-${index}`, attemptId: `attempt-${index}`, createdAt: '', asset: { kind: 'video' as const, assetId, localUrl: `xingmang-asset://video/${assetId}` } }))
    const html = renderNode(kind, { videoCandidateCount: 4, candidates, candidateAssetIds: ids, result: candidates[1].asset, videoBatchProgress: { completed: 2, submitted: 3, total: 4 }, status: 'failed' }, true)
    expect(html).toContain('aria-label="视频生成数量"')
    expect(html).toContain('<option value="4" selected="">×4</option>')
    expect(html).toContain('最多依次提交 4 个独立视频任务')
    expect(html).toContain('aria-label="视频生成候选"')
    expect(html).toContain('已完成 2/4 · 已提交 3')
    expect(html).toContain('aria-label="另存当前视频为节点"')
    expect(html).toContain('aria-label="下载当前视频候选"')
    expect(renderNode(kind, { videoCandidateCount: 4, status: 'running' }, true)).toMatch(/aria-label="视频生成数量"[^>]*disabled=""/)
  })
  it('offers explicit processing and snapshot actions before the image preview', () => {
    const result = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    for (const kind of ['image-collage', 'image-layer', 'image-crop', 'image-tile'] as const) {
      const html = renderNode(kind, { result, status: 'succeeded', dirty: true })
      expect(html).toContain('处理并放到画布'); expect(html).toContain('放置上次成品')
      expect(html.indexOf('wf-output-placement')).toBeLessThan(html.indexOf('image-tool-node'))
    }
    const grid = renderNode('image-grid-split', { result, candidateAssetIds: ['a'.repeat(43), 'b'.repeat(43)], status: 'succeeded' })
    expect(grid).toContain('放置当前切片'); expect(grid).toContain('放置全部切片'); expect(grid).not.toContain('处理并放到画布')
    expect(renderNode('image-generate', { result })).not.toContain('wf-output-placement')
  })
  it('offers exactly one early save action for existing processed results, including disabled and stale nodes', () => {
    const result = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 640, height: 480 }
    for (const kind of ['image-layer', 'image-crop', 'image-collage', 'image-tile', 'image-grid-split', 'frame-extract'] as const) {
      const html = renderNode(kind, { result, status: 'succeeded', dirty: true, __canvasDisabled: true })
      expect(html.match(/class="wf-output-save"/g)).toHaveLength(1)
      expect(html).toContain('另存上次成品')
      expect(html.indexOf('wf-output-save')).toBeLessThan(html.indexOf('image-tool-node') < 0 ? html.indexOf('wf-actions') : html.indexOf('image-tool-node'))
      expect(html).not.toMatch(/class="nodrag wf-rerun"[^>]*>另存<\/button>/)
      const save = html.match(/<button[^>]*class="wf-output-save"[^>]*>/)?.[0]
      expect(save).not.toContain('disabled=""')
    }
    expect(renderNode('image-layer')).not.toContain('wf-output-save')
  })
  it('keeps the processed save action above the preview for read-only existing results without edit or run actions', () => {
    const result = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, width: 640, height: 480 }
    const html = renderNode('image-layer', { result, status: 'succeeded' }, false, {}, { readOnly: true, canRun: false })
    expect(html.match(/class="wf-output-save"/g)).toHaveLength(1)
    expect(html.indexOf('wf-output-save')).toBeLessThan(html.indexOf('wf-input-preview'))
    expect(html).not.toContain('下载素材</button>')
    expect(html).not.toContain('运行此节点')
  })
  it('renders all restored grid candidates and keeps the fifth output selected without run history', () => {
    const ids = Array.from({ length: 9 }, (_, index) => String.fromCharCode(97 + index).repeat(43))
    const html = renderNode('image-grid-split', { candidateAssetIds: ids, result: { kind: 'image', assetId: ids[4], localUrl: `xingmang-asset://image/${ids[4]}` }, status: 'succeeded' })
    expect(html.match(/aria-label="预览候选 [1-9]"/g)).toHaveLength(9)
    expect(html).toMatch(/class="is-selected"[^>]*title="预览候选 5"/)
    expect(html).not.toContain('title="预览候选 10"')
  })
  it('shows custom node names while retaining generation and photography controls', () => {
    const html = renderNode('image-generate', { settings: { title: '咖啡杯主图' } }, true)
    expect(html).toContain('<strong>咖啡杯主图</strong>')
    expect(html).toContain('aria-label="咖啡杯主图提示词"')
    expect(html).toContain('aria-label="摄影控制"')
    expect(renderNode('prompt', { settings: { title: '商品说明' } })).toContain('商品说明提示词')
  })

  it.each(['image-generate', 'image'] as const)('preserves an incompatible saved size in the %s size selector after switching models', (kind) => {
    const html = renderNode(kind, { model: 'gpt-image-1', size: '1280x720', imageResolution: '1K' }, true)
    expect(html).toMatch(/<option[^>]*value="1280x720"[^>]*disabled=""[^>]*selected=""/)
    expect(html).toContain('16:9 · 1280x720（已保存，当前不支持）')
    expect(html).toContain('请更换分辨率、比例或模型')
    expect(html).not.toMatch(/<option[^>]*value="1024x1024"[^>]*selected=""/)
  })

  it('retains a valid custom size in the selector rather than replacing it with a preset', () => {
    const html = renderNode('image-generate', { model: 'gpt-image-2', size: '1600x1200', imageResolution: '1K' }, true)
    expect(html).toMatch(/<option[^>]*value="1600x1200"[^>]*selected=""/)
    expect(html).toContain('1600x1200（已保存尺寸）')
    expect(html).not.toMatch(/<option[^>]*value="1600x1200"[^>]*disabled=""/)
    expect(html).not.toMatch(/<option[^>]*value="1024x1024"[^>]*selected=""/)
  })

  it.each(['image-generate', 'image'] as const)('labels provider-sized %s defaults without promising 1K pixels', (kind) => {
    const html = renderNode(kind, { model: 'grok-imagine-image', size: '1280x720', imageResolution: '1K' }, true)
    expect(html).toMatch(/<option[^>]*value="1K"[^>]*selected="">由服务决定<\/option>/)
    expect(html).not.toContain('1280 × 720')
  })

  it.each(['image-generate', 'image'] as const)('shows the saved unsupported resolution for %s instead of displaying 1K', (kind) => {
    const html = renderNode(kind, { model: 'gemini-3.1-flash-image', size: '1280x720', imageResolution: '4K' }, true)
    expect(html).toMatch(/<option[^>]*value="4K"[^>]*disabled=""[^>]*selected=""/)
    expect(html).toContain('保留的 4K 当前不可用')
    expect(html).toContain('请更换分辨率、比例或模型')
    expect(html).not.toMatch(/<option[^>]*value="1K"[^>]*selected=""/)
  })

  it('disables square 4K while preserving a compatible selected 2K tier', () => {
    const html = renderNode('image-generate', { model: 'gpt-image-2', size: '1024x1024', imageResolution: '2K' }, true)
    expect(html).toMatch(/<option[^>]*value="4K"[^>]*disabled=""/)
    expect(html).toMatch(/<option[^>]*value="2K"[^>]*selected=""/)
    expect(html).toContain('8,294,400 像素')
    expect(html).not.toContain('保留的 2K 当前不可用')
  })

  it('shows the effective request size before generation and the actual asset size afterward', () => {
    const configuration = { model: 'gpt-image-2', size: '1280x720', imageResolution: '4K' } as const
    const pending = renderNode('image-edit', configuration)
    expect(pending).toContain('3840 × 2160')
    expect(pending).not.toContain('1280 × 720')
    const assetId = 'a'.repeat(43)
    const completed = renderNode('image-edit', { ...configuration, result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', width: 2560, height: 1440 } })
    expect(completed).toContain('2560 × 1440')
    expect(completed).not.toContain('3840 × 2160')
    expect(configuration.size).toBe('1280x720')
  })

  it.each(['output', 'router'] as const)('keeps every %s port inside the content-sized node', (kind) => {
    const html = renderNode(kind)
    const minimumHeight = Number(/class="wf-node [^"]+" style="min-height:(\d+)px"/.exec(html)?.[1])
    const portOffsets = [...html.matchAll(/data-handle="[^"]+" style="top:(\d+)px"/g)].map((match) => Number(match[1]))
    expect(minimumHeight).toBe(124)
    expect(portOffsets).toHaveLength(kind === 'output' ? 4 : 8)
    expect(portOffsets).toContain(112)
    for (const top of portOffsets) expect(minimumHeight - top).toBeGreaterThanOrEqual(12)
  })

  it('keeps media and group sizing independent from ordinary port rows', () => {
    expect(renderNode('group')).not.toContain('min-height:')
    expect(renderNode('image-generate')).not.toContain('min-height:')
    expect(renderNode('image-input', { result: { kind: 'image', assetId: 'existing-image' } })).not.toContain('min-height:')
  })

  it('shows the actual image generation failure even when the node is not selected', () => {
    const html = renderNode('image-generate', { status: 'failed', errorMessage: '来源额度不足，请更换来源' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('来源额度不足，请更换来源')
    expect(html).toContain('生成未完成')
    expect(html).not.toContain('画面从这里开始')
  })

  it('preserves the previous media result while reporting a failed regeneration', () => {
    const html = renderNode('video-generate', { status: 'failed', errorMessage: '生成超时', result: { kind: 'video', assetId: 'existing-video' } })
    expect(html).toContain('生成超时')
    expect(html).not.toContain('画面从这里开始')
    expect(html).not.toContain('生成未完成')
  })

  it('uses connection state and accessible direction labels for centered media outputs', () => {
    vi.mocked(useNodeConnections).mockImplementation((options) => options?.handleType === 'source' ? [{ source: 'test-node', sourceHandle: 'out:image', target: 'downstream', targetHandle: 'in:images', edgeId: 'wire' }] : [])
    const html = renderNode('image-input', { result: { kind: 'image', assetId: 'existing-image' } })
    expect(html).toContain('data-handle="out:image"')
    expect(html).toContain('top:50%')
    expect(html).toContain('is-connected')
    expect(html).toContain('输出图像，可连接多个，已连接 1 条')
  })

  it('explains how to enable generation before the first run', () => {
    const html = renderNode('image-generate', {}, true)
    expect(html).toContain('请先在顶部「生成配置」选择可用来源和模型')
    expect(html).toContain('aria-label="开始生成"')
    expect(html).toContain('data-placement="fixed"')
    expect(html).toContain('选中节点，编辑提示词和模型')
  })

  it('only marks an in-flight run as spinning rather than any disabled run button', () => {
    expect(renderNode('text-generate')).toContain('class="nodrag wf-run-node"')
    expect(renderNode('text-generate')).not.toContain('wf-run-node is-running')
    const running = renderNode('text-generate', { status: 'running' })
    expect(running).toContain('wf-run-node is-running')
    expect(running).toContain('文字生成中，完成后会显示在下方')
    expect(running).not.toContain('图像生成中')
  })
})

 describe('dedicated commerce node presentation', () => {
  it('keeps B output selectors locked in both node layouts but leaves ordinary image selectors editable', () => {
    const task = defaultCommerceTask('material-b'), data = { model: 'gpt-image-2', settings: { commerceTask: task }, size: 'auto', imageResolution: '1K' as const }
    for (const saved of [false, true]) {
      const result = saved ? { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } : undefined
      const html = renderNode('image-generate', { ...data, result }, true)
      for (const label of ['生成尺寸', '生成清晰度']) expect(html.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>`))?.[0]).toContain('disabled=""')
      expect(html).toContain('输出尺寸由原图与倍率决定')
      const ordinary = renderNode('image-generate', { ...data, result, settings: {} }, true)
      for (const label of ['生成尺寸', '生成清晰度']) expect(ordinary.match(new RegExp(`<select[^>]*aria-label="${label}"[^>]*>`))?.[0]).not.toContain('disabled=""')
    }
  })
  it('presents an unconfigured model as a normal setup state without hiding real saved incompatibilities', () => {
    const pending = renderNode('image-edit', { model: '', settings: { commerceTask: defaultCommerceTask('material-a') } }, true)
    expect(pending).not.toContain('模型名称不能为空'); expect(pending).not.toContain('1K 当前不可用')
    const unsupported = renderNode('image-edit', { model: 'gpt-image-1', size: '1280x720', imageResolution: '4K' }, true)
    expect(unsupported).toContain('4K 当前不可用')
  })
})
