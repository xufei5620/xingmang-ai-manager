import { parseNodeRouterStrategy } from '../runtime/router-strategy'
import { parseNodeStoryboardTask } from '../storyboard/storyboard-task'
import { parseNodeExteriorTask } from '../exterior/exterior-task'
import { parseNodeInteriorTask } from '../interior/interior-task'
import { parseNodeCommerceTask } from '../commerce/commerce-task'
import { parseNodeImageReferenceOrder } from '../commerce/image-reference-order'
import { assertImageReferenceRunConfiguration } from '../commerce/image-task-configuration'
import { parseVideoReferenceOrder } from '../video-tools/video-reference-order'
import { assertCanvasVideoInputCardinality, inspectCanvasVideoInputs } from '../video-tools/video-inputs'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { validateTextWebSearchConfiguration } from '../runtime/text-web-search'
import { textImageInputLimits, validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeMediaKind } from '../library/node-model-availability'
import { imageTransformRecipeForNode, imageTransformRecipeNeedsSources, isImageTransformNodeKind } from '../image-tools/recipe'
import type { CanvasRunGraph } from '../host'
import type { PortKind, WorkflowFile, WorkflowNode } from '../model'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { canvasImageInputCardinality, canvasImageTransformInputErrors } from '../runtime/image-input-cardinality'
import { parseNodeTileInput } from '../image-tools/tile-input'
import { assertCanvasTileInput } from '../runtime/tile-run-input'
import { videoRequestParameters, type VideoProtocol } from './video-request-protocol'

export interface WorkshopReadinessRequirement {
  nodeId: string
  nodeTitle: string
  kind: 'image' | 'video' | 'audio' | 'prompt' | 'model' | 'configuration' | 'upstream'
  message: string
  modelPurpose?: 'image' | 'video' | 'text'
}

export interface WorkshopReadinessNode {
  nodeId: string
  title: string
  kind: WorkflowNode['kind']
  execution: 'local' | 'model'
  /** Saved identifiers are hints, never proof of account/model availability. */
  modelHint?: string
  maximumRequestCount?: number
  webSearch?: true
  requirements: WorkshopReadinessRequirement[]
}

export interface WorkshopReadiness {
  nodes: WorkshopReadinessNode[]
  requirements: WorkshopReadinessRequirement[]
  localOnly: boolean
  /** Enabled model nodes, excluding disabled nodes and skipped branches. */
  modelNodeCounts: { image: number; video: number; text: number }
  /** Maximum independent requests before cache checks; each batch slot counts. */
  requestCounts: { image: number; video: number; text: number }
  skippedNodeCount: number
  skippedNodes: Array<{ nodeId: string; reasonCode: 'disabled' | 'upstream-skip'; message: string }>
  notices: string[]
}

function definition(node: WorkflowNode) {
  return builtinNodeRegistry.resolve(node.kind === 'image' ? 'image-generate' : node.kind === 'video' ? 'video-generate' : node.kind === 'text' ? 'prompt' : node.kind)
}

function runNode(node: WorkflowNode): CanvasRunGraph['nodes'][number] {
  const settings = node.data.settings ?? {}
  let imageTransform
  try { if (isImageTransformNodeKind(node.kind)) imageTransform = imageTransformRecipeForNode(node.kind, settings) } catch { /* Preflight reports the invalid configuration below. */ }
  return { id: node.id, kind: node.kind, definitionVersion: node.definitionVersion ?? 1, disabled: node.disabled, data: {
    prompt: node.data.prompt, model: node.data.model, size: node.data.size, quality: node.data.quality, imageResolution: node.data.imageResolution,
    ...(node.data.imageCandidateCount !== undefined ? { imageCandidateCount: node.data.imageCandidateCount } : {}),
    ...(node.data.videoCandidateCount !== undefined ? { videoCandidateCount: node.data.videoCandidateCount } : {}),
    ...(node.data.textWebSearch !== undefined ? { textWebSearch: node.data.textWebSearch } : {}),
    ...(imageTransform ? { imageTransform } : {}),
    ...(Object.hasOwn(settings, 'routerStrategy') ? { routerStrategy: parseNodeRouterStrategy(node.kind, settings.routerStrategy) } : {}),
    ...(Object.hasOwn(settings, 'interiorTask') ? { interiorTask: parseNodeInteriorTask(node.kind, settings.interiorTask) } : {}),
    ...(Object.hasOwn(settings, 'exteriorTask') ? { exteriorTask: parseNodeExteriorTask(node.kind, settings.exteriorTask) } : {}),
    ...(Object.hasOwn(settings, 'storyboardTask') ? { storyboardTask: parseNodeStoryboardTask(node.kind, settings.storyboardTask) } : {}),
    ...(settings.commerceTask !== undefined ? { commerceTask: parseNodeCommerceTask(node.kind, settings.commerceTask) } : {}),
    ...(settings.imageReferenceOrder !== undefined ? { imageReferenceOrder: parseNodeImageReferenceOrder(node.kind, settings.imageReferenceOrder) } : {}),
    ...(settings.tileInput !== undefined ? { tileInput: parseNodeTileInput(node.kind, settings.tileInput) } : {}),
    ...(typeof settings.timestampSeconds === 'number' ? { frameTimestampSeconds: settings.timestampSeconds } : {}),
    ...(['video', 'video-generate'].includes(node.kind) ? {
      seconds: node.data.seconds, size: node.data.size,
      videoReferenceOrder: settings.videoReferenceOrder === undefined ? { version: 1 as const, slots: [] } : parseVideoReferenceOrder(settings.videoReferenceOrder),
      videoMode: settings.videoMode as CanvasRunGraph['nodes'][number]['data']['videoMode'],
      videoResolution: settings.videoResolution as CanvasRunGraph['nodes'][number]['data']['videoResolution'],
      videoAspectRatio: settings.videoAspectRatio as CanvasRunGraph['nodes'][number]['data']['videoAspectRatio'],
      promptOptimization: settings.promptOptimization as CanvasRunGraph['nodes'][number]['data']['promptOptimization'],
      ...(typeof settings.generateAudio === 'boolean' ? { generateAudio: settings.generateAudio } : {}),
    } : {}),
  } }
}

/** Configuration-only inspection. It never resolves an account, credential or asset. */
export function analyzeWorkshopReadiness(workflow: WorkflowFile, context: { videoProtocol?: VideoProtocol } = {}): WorkshopReadiness {
  const executable = workflow.nodes.filter((node) => definition(node)?.executable)
  const ids = new Set(executable.map((node) => node.id))
  const byId = new Map(executable.map((node) => [node.id, node]))
  const edges = workflow.edges.filter((edge) => {
    const source = byId.get(edge.source), target = byId.get(edge.target)
    if (!source || !target || !ids.has(edge.source) || !ids.has(edge.target)) return false
    const output = definition(source)?.ports.find((port) => port.direction === 'output' && port.id === edge.sourceHandle)
    const input = definition(target)?.ports.find((port) => port.direction === 'input' && port.id === edge.targetHandle)
    return Boolean(output && input && output.kind === input.kind)
  })
  const graph: CanvasRunGraph = { nodes: executable.map(runNode), edges: edges.map((edge) => ({ ...edge, sourceHandle: edge.sourceHandle!, targetHandle: edge.targetHandle! })) }
  const runNodes = new Map(graph.nodes.map((node) => [node.id, node]))
  // Reuse execution planning for paid/local classification and disabled-branch
  // propagation. Missing provider groups are expected in reusable templates.
  const plan = buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, imageModels: [], videoModels: [], textModels: [] })
  const planned = new Map(plan.items.map((item) => [item.nodeId, item]))
  const rows: WorkshopReadinessNode[] = []
  const requestCounts = { image: 0, video: 0, text: 0 }
  const modelNodeCounts = { image: 0, video: 0, text: 0 }
  const inputNotices: string[] = []
  const available = new Map<string, boolean>()
  function potentialOutput(nodeId: string, media: PortKind, visiting = new Set<string>()): boolean {
    const key = `${nodeId}:${media}`
    if (available.has(key)) return available.get(key)!
    const node = byId.get(nodeId), item = planned.get(nodeId)
    if (!node || item?.action === 'skip' || visiting.has(key)) return false
    const next = new Set(visiting).add(key)
    const ports = definition(node)?.ports ?? []
    if (!ports.some((port) => port.direction === 'output' && port.kind === media)) return false
    let result = item?.paid === true || node.kind === `${media}-input`
    if (media === 'text') result ||= Boolean(node.data.prompt.trim())
    if (media === 'image' && (isImageTransformNodeKind(node.kind) || node.kind === 'frame-extract')) result = true
    if (!result) result = edges.some((edge) => edge.target === nodeId && definition(byId.get(edge.source)!)?.ports.some((port) => port.id === edge.sourceHandle && port.kind === media) && potentialOutput(edge.source, media, next))
    available.set(key, result)
    return result
  }
  function sources(node: WorkflowNode, media: PortKind) {
    return edges.filter((edge) => edge.target === node.id && definition(byId.get(edge.source)!)?.ports.some((port) => port.id === edge.sourceHandle && port.kind === media) && potentialOutput(edge.source, media))
  }
  function imageInputs(node: WorkflowNode) {
    return canvasImageInputCardinality(sources(node, 'image').map((edge) => ({ source: edge.source, sourceHandle: edge.sourceHandle! })), runNodes, workflow.edges)
  }
  for (const node of executable) {
    const item = planned.get(node.id)!
    if (item.action === 'skip') continue
    const nodeDefinition = definition(node)!
    const customTitle = node.data.settings?.title
    const title = typeof customTitle === 'string' && customTitle.trim() ? customTitle.trim() : nodeDefinition.title
    const row: WorkshopReadinessNode = { nodeId: node.id, title, kind: node.kind, execution: item.paid ? 'model' : 'local', ...(item.paid && node.data.model ? { modelHint: node.data.model } : {}), requirements: [] }
    function need(kind: WorkshopReadinessRequirement['kind'], message: string, modelPurpose?: WorkshopReadinessRequirement['modelPurpose']) {
      if (!row.requirements.some((entry) => entry.kind === kind && entry.message === message)) row.requirements.push({ nodeId: node.id, nodeTitle: title, kind, message, ...(modelPurpose ? { modelPurpose } : {}) })
    }
    if (item.paid) {
      const purpose = nodeDefinition.ports.find((port) => port.direction === 'output')?.kind
      const modelPurpose = purpose === 'image' || purpose === 'video' ? purpose : 'text'
      const fixedSource = canvasNodeMediaKind(node.kind) === modelPurpose && typeof node.data.group === 'string' && Boolean(node.data.group.trim())
      modelNodeCounts[modelPurpose]++
      try {
        const imageCount = parseImageCandidateCount(node.data.imageCandidateCount, node.kind)
        const videoCount = parseVideoCandidateCount(node.data.videoCandidateCount, node.kind)
        const count = videoCount ?? imageCount ?? 1
        row.maximumRequestCount = count
        requestCounts[modelPurpose] += count
      } catch (error) { need('configuration', error instanceof Error ? error.message : '请核对生成数量') }
      if (node.kind === 'text-generate' && node.data.textWebSearch === true) row.webSearch = true
      const visualInputs = node.kind === 'text-generate' ? workflow.edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:images') : []
      const fixedTextConditions = modelPurpose !== 'text' ? '' : visualInputs.length ? `还需确认来源支持${row.webSearch ? ' Responses 图片输入与联网搜索' : '图片输入'}；最多 ${textImageInputLimits.images} 张图片；` : row.webSearch ? '还需确认来源支持 Responses 联网搜索；' : ''
      need('model', fixedSource ? `进入画布后核对已保存的本人固定${modelPurpose === 'image' ? '图像' : modelPurpose === 'video' ? '视频' : '文字'}来源及模型对当前账号是否可用；${fixedTextConditions}原来源保留，不会自动改用画布默认来源` : visualInputs.length ? `进入画布后重新选择已确认支持图片理解的文字模型，核对当前账号可用模型，并确认来源支持${row.webSearch ? ' Responses 图片输入与联网搜索' : '图片输入'}；最多 ${textImageInputLimits.images} 张图片，模型名不能证明中转来源已接通` : `进入画布后重新选择${modelPurpose === 'image' ? '图像' : modelPurpose === 'video' ? '视频' : '文字'}模型来源，${row.webSearch ? '确认来源支持 Responses 联网搜索，并' : '并'}核对当前账号可用模型`, modelPurpose)
      // A catalog-free preview cannot prove a retained owner route is usable.
      // Keep that verification distinct from replacing a portable source.
      if (modelPurpose === 'text' || node.data.textWebSearch !== undefined) {
        try { validateTextWebSearchConfiguration(node.kind, node.data.model, node.data.textWebSearch) }
        catch (error) { need('configuration', error instanceof Error ? error.message : '请核对联网搜索配置') }
      }
      if (visualInputs.length) {
        const connected = edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:images')
        // Count bindings before availability filtering: an empty branch must not
        // make a reusable vision template look like an ordinary text request.
        const count = canvasImageInputCardinality(connected.map((edge) => ({ source: edge.source, sourceHandle: edge.sourceHandle! })), runNodes, workflow.edges)
        for (const imageCount of [1, count.minimum]) {
          try { validateTextImageInputConfiguration(node.data.model, imageCount) }
          catch (error) { need('configuration', error instanceof Error ? error.message : '请核对视觉文字模型和图片数量') }
        }
        if (connected.length !== visualInputs.length) need('image', '视觉图片连线的来源或端口无效，请重新连接图片来源到文字节点的图像输入')
        if (connected.some((edge) => !potentialOutput(edge.source, 'image'))) need('image', '连接的视觉图片来源没有可用图片输入或输出配置，请补齐该来源；不会跳过缺图后继续生成')
        if (!count.exact) inputNotices.push(`${title}的视觉图片整组数量尚不能确定，进入画布后需核对实际展开数量不超过 ${textImageInputLimits.images} 张；不按旧生成结果推断。`)
        inputNotices.push(`${title}的视觉图片须在画布中重新补齐；工坊不携带原图。运行前还会核对图片归属、格式、像素和字节限制。`)
      }
      if (!node.data.settings?.commerceTask && !node.data.settings?.interiorTask && !node.data.settings?.exteriorTask && !node.data.settings?.storyboardTask && !node.data.prompt.trim() && !sources(node, 'text').length) need('prompt', '填写提示词，或连接有内容的上游文字节点')
      if (node.data.settings?.imageReferenceOrder !== undefined || node.data.settings?.commerceTask !== undefined || node.data.settings?.interiorTask !== undefined || node.data.settings?.exteriorTask !== undefined || node.data.settings?.storyboardTask !== undefined) {
        try { assertImageReferenceRunConfiguration(runNodes.get(node.id)!, graph.edges, runNodes) }
        catch (error) { need('configuration', error instanceof Error ? error.message : '请核对创作任务的参考图角色') }
        if (runNodes.get(node.id)?.data.commerceTask?.kind === 'material-b') need('configuration', '材质优化 B 需重新绑定原图，按实际像素与倍率核对模型精确支持的尺寸；不会改用较低分辨率')
      }
      if (node.kind === 'image-edit' && !sources(node, 'image').length) need('image', '图片编辑需要连接至少一张图片素材')
      if (node.data.settings?.imageEditMask !== undefined) need('configuration', '蒙版配方已保留；连接唯一基图后打开蒙版编辑器，确认适配当前原图，并选择支持蒙版的 GPT Image 模型')
      if (modelPurpose === 'image' && imageInputs(node).minimum > 4) need('configuration', '图片生成或编辑最多接受 4 张参考图片，请减少输入')
      if (modelPurpose === 'video') inputNotices.push(`${title}${fixedSource ? '需核对已保存的固定视频来源协议' : '需要重新确认视频来源协议'}；参考顺序、首尾角色与实际素材数量需在画布核对，保存的模型名不证明来源支持全部模式。`)
      if (modelPurpose === 'video' && node.data.settings?.generateAudio !== undefined) need('model', `已保留生成音频${node.data.settings.generateAudio ? '开启' : '关闭'}设置，${fixedSource ? '请核对已保存的本人固定视频来源是否支持此模型和音频控制' : '请重新选择支持此模型和音频控制的兼容视频来源'}`, 'video')
      if (modelPurpose === 'video' && node.data.model) {
        try {
          const run = runNodes.get(node.id)!
          const count = inspectCanvasVideoInputs(run, graph.edges, runNodes)
          assertCanvasVideoInputCardinality(count)
          // Without an owner catalog, inspect supported protocols without
          // choosing one. A supplied source context must use only its exact
          // protocol; execution still uses the account-bound run preflight.
          const protocols: readonly VideoProtocol[] = context.videoProtocol ? [context.videoProtocol] : ['relay-videos', 'xai-native', 'ark-seedance']
          const errors: string[] = []
          let compatible = false
          for (const videoProtocol of protocols) {
            try { videoRequestParameters({ ...run.data, ...count, videoProtocol, prompt: '准备条件检查' }); compatible = true; break }
            catch (error) { errors.push(error instanceof Error ? error.message : '参数不兼容') }
          }
          if (!compatible) throw new Error(`${context.videoProtocol ? '所选视频来源与配置不兼容' : fixedSource ? '请核对已保存的固定视频来源协议与参数' : '请重新选择兼容视频来源并核对已保存参数'}：${[...new Set(errors)].join('；')}`)
        }
        catch (error) { need('configuration', error instanceof Error ? error.message : '请在画布中核对视频参数和参考素材') }
      }
    } else if (['image-input', 'video-input', 'audio-input'].includes(node.kind)) {
      const media = nodeDefinition.ports[0].kind as 'image' | 'video' | 'audio'
      need(media, `重新上传或选择${media === 'image' ? '图片' : media === 'video' ? '视频' : '音频'}素材；工坊不会携带原素材`)
    } else if (nodeDefinition.executorKind === 'prompt' && !node.data.prompt.trim() && !sources(node, 'text').length) {
      need('prompt', '填写需要传给下游的文字内容')
    }
    let missingLayerSources = false
    if (isImageTransformNodeKind(node.kind)) {
      try {
        const recipe = imageTransformRecipeForNode(node.kind, node.data.settings ?? {})!
        if (node.kind === 'image-tile') assertCanvasTileInput(runNodes.get(node.id)!, graph.edges, runNodes)
        const count = imageInputs(node)
        const requiredLayerSources = recipe.kind === 'layer' ? recipe.layers.reduce((minimum, layer) => layer.content ? minimum : Math.max(minimum, layer.sourceIndex + 1), 0) : 0
        missingLayerSources = requiredLayerSources > 0 && (!count.connections || count.exact && count.minimum < requiredLayerSources)
        if (missingLayerSources) need('image', `至少连接 ${requiredLayerSources} 张图片，并按原图层引用顺序对应；文字、形状等内容图层不占图片来源`)
        else if (imageTransformRecipeNeedsSources(recipe) && !sources(node, 'image').length) need('image', '连接图片素材或能产生图片的上游节点')
        for (const message of canvasImageTransformInputErrors(recipe, count)) {
          if (missingLayerSources && message.startsWith('图层引用')) continue
          if (!row.requirements.some((entry) => entry.kind === 'image') || !/需要连接|请连接/.test(message)) need('configuration', message)
        }
        if (!count.exact) inputNotices.push(`${title}的整组输入数量尚不能确定；补齐上游配置后需在画布核对实际数量，不按旧生成结果推断。`)
      } catch { /* The shared execution preflight supplies the precise error. */ }
    } else if (['image-compare', 'image-panorama'].includes(node.kind) && !sources(node, 'image').length) need('image', '连接图片素材或能产生图片的上游节点')
    else if (node.kind === 'frame-extract' && !sources(node, 'video').length) need('video', '连接一个可读取的视频来源')
    if (item.reasonCode === 'invalid-parameters' && !(row.requirements.some((entry) => ['image', 'video'].includes(entry.kind)) && /需要连接|请连接/.test(item.reason ?? '')) && !(missingLayerSources && item.reason?.startsWith('图层引用'))) need('configuration', item.reason ?? '请检查节点参数')
    if (node.kind === 'drama-shot') need('configuration', '进入画布后重新确认分镜资产与封板状态，并编译提示词')
    rows.push(row)
  }
  const localOnly = modelNodeCounts.image + modelNodeCounts.video + modelNodeCounts.text === 0
  const webSearchCount = rows.filter((row) => row.webSearch).length
  const skippedNodes = plan.items.flatMap((item) => item.action === 'skip' && (item.reasonCode === 'disabled' || item.reasonCode === 'upstream-skip') ? [{ nodeId: item.nodeId, reasonCode: item.reasonCode, message: item.reason ?? '节点不会执行' }] : [])
  return { nodes: rows, requirements: rows.flatMap((row) => row.requirements), localOnly, modelNodeCounts, requestCounts, skippedNodeCount: plan.skippedCount, skippedNodes,
    notices: [localOnly ? '启用节点仅使用本地工具，无需生成模型。' : '最大请求数按启用节点的生成数量累加；每次独立生成按来源计费，具体金额需在画布运行前核对，命中缓存时不会重复生成。', ...(webSearchCount ? [`${webSearchCount} 个节点已启用联网搜索，最多调用 ${webSearchCount} 次搜索；模型生成与搜索费用均按所选来源计费，命中缓存时复用原搜索结果，不代表刚刚联网。`] : []), '模型编号仅是保存时的配置提示，不代表当前账号可用；导入不会自动运行。', ...inputNotices, ...(plan.skippedCount ? [`${plan.skippedCount} 个禁用节点或受其影响的下游节点不会执行。`] : [])] }
}
