import type {
  CanvasTemplate,
  CanvasTemplateIndustry,
  CanvasTemplateRequirement,
  TemplateEdge,
  TemplateNode,
  TemplateVariable,
} from '../template-types'
import { builtinNodeRegistry } from '../../domain/builtin-node-definitions'

type ImageOperation = 'image-generate' | 'image-edit'

interface BranchTemplateSpec {
  id: string
  name: string
  description: string
  industry: CanvasTemplateIndustry
  deliverable: string
  tags: readonly string[]
  operation: ImageOperation
  branches: number
  variants: number
  promptDefaults: readonly string[]
  assetLabel?: string
  secondAssetLabel?: string
  sizes?: readonly string[]
  disclaimer?: string
  featured?: boolean
  videoSeconds?: string
  videoSize?: string
}

function node(id: string, type: string, x: number, y: number, config: Record<string, unknown> = {}): TemplateNode {
  return { id, type, definitionVersion: 1, position: { x, y }, config }
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): TemplateEdge {
  return { id, source, sourceHandle, target, targetHandle }
}

function createBranchTemplate(spec: BranchTemplateSpec): CanvasTemplate {
  const nodes: TemplateNode[] = []
  const edges: TemplateEdge[] = []
  const variables: TemplateVariable[] = []
  const promptX = spec.assetLabel ? 420 : 0
  const operationX = promptX + 420
  const galleryX = operationX + (spec.variants * 360) + 40
  const videoX = galleryX + 440
  const rowGap = Math.max(
    420,
    spec.videoSeconds ? builtinNodeRegistry.require('video-generate').dimensions.height + 60 : 0,
  )

  if (spec.assetLabel) {
    nodes.push(node('asset', 'image-input', 0, 0))
    variables.push({ id: 'asset', label: spec.assetLabel, type: 'asset', required: true, target: { nodeId: 'asset', path: 'assetId' } })
  }
  if (spec.secondAssetLabel) {
    nodes.push(node('asset-2', 'image-input', 0, 420))
    variables.push({ id: 'asset-2', label: spec.secondAssetLabel, type: 'asset', required: true, target: { nodeId: 'asset-2', path: 'assetId' } })
  }

  for (let branch = 0; branch < spec.branches; branch += 1) {
    const suffix = String(branch + 1)
    const y = branch * rowGap
    const promptId = `prompt-${suffix}`
    const promptDefault = spec.promptDefaults[branch] ?? spec.promptDefaults[0] ?? ''
    nodes.push(node(promptId, 'prompt', promptX, y, { prompt: promptDefault }))
    variables.push({
      id: `prompt-${suffix}`,
      label: spec.branches === 1 ? '创作要求' : `第 ${suffix} 组创作要求`,
      type: 'text',
      required: true,
      defaultValue: promptDefault,
      target: { nodeId: promptId, path: 'prompt' },
    })

    const operationIds: string[] = []
    for (let variant = 0; variant < spec.variants; variant += 1) {
      const operationId = `${spec.operation === 'image-edit' ? 'edit' : 'image'}-${suffix}-${variant + 1}`
      operationIds.push(operationId)
      nodes.push(node(operationId, spec.operation, operationX + (variant * 360), y, {
        quality: 'low',
        ...(spec.sizes?.[branch] ? { size: spec.sizes[branch] } : {}),
      }))
      edges.push(edge(`${promptId}-${operationId}`, promptId, 'out:text', operationId, 'in:text'))
      if (spec.assetLabel) edges.push(edge(`asset-${operationId}`, 'asset', 'out:image', operationId, 'in:images'))
      if (spec.secondAssetLabel) edges.push(edge(`asset-2-${operationId}`, 'asset-2', 'out:image', operationId, 'in:images'))
    }

    const galleryId = `gallery-${suffix}`
    nodes.push(node(galleryId, 'gallery', galleryX, y))
    for (const operationId of operationIds) {
      edges.push(edge(`${operationId}-${galleryId}`, operationId, 'out:image', galleryId, 'in:images'))
    }

    if (spec.videoSeconds) {
      const videoId = `video-${suffix}`
      nodes.push(node(videoId, 'video-generate', videoX, y, { seconds: spec.videoSeconds, size: spec.videoSize ?? '1280x720' }))
      edges.push(edge(`${promptId}-${videoId}`, promptId, 'out:text', videoId, 'in:text'))
      edges.push(edge(`${operationIds[0]}-${videoId}`, operationIds[0], 'out:image', videoId, 'in:images'))
    }
  }

  const requirements: CanvasTemplateRequirement[] = [{
    media: 'image',
    operation: spec.operation === 'image-edit' ? 'edit' : 'generate',
    options: ['quality', ...(spec.sizes?.length ? ['size' as const] : [])],
  }]
  if (spec.videoSeconds) requirements.push({ media: 'video', operation: 'generate' })
  return {
    id: spec.id,
    version: 1,
    name: spec.name,
    description: spec.description,
    category: spec.videoSeconds ? 'video' : 'image',
    industry: spec.industry,
    deliverable: spec.deliverable,
    ...(spec.disclaimer ? { disclaimer: spec.disclaimer } : {}),
    ...(spec.featured ? { featured: true } : {}),
    requirements,
    tags: spec.tags,
    thumbnail: { kind: 'color', value: industryColor[spec.industry] },
    requiredNodeTypes: [...new Set(nodes.map((entry) => entry.type))],
    workflow: { nodes, edges },
    variables,
    provenance: { kind: 'xingmang-original' },
  }
}

interface DirectVideoSpec {
  id: string
  name: string
  description: string
  industry: CanvasTemplateIndustry
  deliverable: string
  tags: readonly string[]
  seconds: string
  size: string
  prompt: string
  disclaimer?: string
}

function createDirectVideoTemplate(spec: DirectVideoSpec): CanvasTemplate {
  const nodes = [
    node('asset', 'image-input', 0, 0),
    node('prompt', 'prompt', 420, 0, { prompt: spec.prompt }),
    node('video', 'video-generate', 840, 0, { seconds: spec.seconds, size: spec.size }),
    node('gallery', 'gallery', 1240, 0),
  ]
  return {
    id: spec.id, version: 1, name: spec.name, description: spec.description, category: 'video',
    industry: spec.industry, deliverable: spec.deliverable, ...(spec.disclaimer ? { disclaimer: spec.disclaimer } : {}),
    requirements: [{ media: 'video', operation: 'generate' }], tags: spec.tags,
    thumbnail: { kind: 'color', value: industryColor[spec.industry] },
    requiredNodeTypes: ['image-input', 'prompt', 'video-generate', 'gallery'],
    workflow: {
      nodes,
      edges: [
        edge('asset-video', 'asset', 'out:image', 'video', 'in:images'),
        edge('prompt-video', 'prompt', 'out:text', 'video', 'in:text'),
        edge('video-gallery', 'video', 'out:video', 'gallery', 'in:videos'),
      ],
    },
    variables: [
      { id: 'asset', label: '起始画面', type: 'asset', required: true, target: { nodeId: 'asset', path: 'assetId' } },
      { id: 'prompt', label: '镜头运动', type: 'text', required: true, defaultValue: spec.prompt, target: { nodeId: 'prompt', path: 'prompt' } },
    ],
    provenance: { kind: 'xingmang-original' },
  }
}

const industryColor: Record<CanvasTemplateIndustry, string> = {
  story: '#8B5CF6', commerce: '#0EA5E9', architecture: '#14B8A6', 'social-media': '#F97316',
  education: '#EAB308', game: '#EC4899', 'marketing-film': '#EF4444',
}

const complete = (subject: string) => `${subject}；主体清晰，构图完整，光影自然，保持参考图中的关键身份与结构特征。`

export const industryCanvasTemplates: readonly CanvasTemplate[] = [
  createBranchTemplate({ id: 'xingmang-drama-character-sheet', name: '角色设定卡', description: '生成四张可复用的角色定妆候选。', industry: 'story', deliverable: '角色定妆候选', tags: ['漫剧', '角色', '定妆'], operation: 'image-generate', branches: 1, variants: 4, promptDefaults: [complete('全身角色设定卡，纯色背景，正面立绘')], sizes: ['1024x1536'], featured: true }),
  createBranchTemplate({ id: 'xingmang-drama-shot-frame', name: '分镜一致性出图', description: '结合角色与场景参考生成四张分镜候选。', industry: 'story', deliverable: '竖屏分镜候选', tags: ['漫剧', '分镜', '一致性'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('竖屏剧情分镜，明确景别、动作和光影')], assetLabel: '角色参考图', secondAssetLabel: '场景参考图', sizes: ['1024x1536'] }),
  createDirectVideoTemplate({ id: 'xingmang-drama-shot-video', name: '镜头图生视频', description: '把单张分镜变成 8 秒竖屏动态镜头。', industry: 'story', deliverable: '8 秒竖屏镜头', tags: ['漫剧', '图生视频'], seconds: '8', size: '720x1280', prompt: '保持人物身份与画面结构，轻微推近，动作自然，镜头稳定。' }),
  createBranchTemplate({ id: 'xingmang-drama-episode-6', name: '漫剧单集六镜骨架', description: '六条镜头生产线，共 24 个图片请求和 6 个视频请求。', industry: 'story', deliverable: '六镜漫剧素材骨架', tags: ['漫剧', '六镜', '生产'], operation: 'image-edit', branches: 6, variants: 4, promptDefaults: Array.from({ length: 6 }, (_, index) => complete(`第 ${index + 1} 镜剧情画面与运镜`)), assetLabel: '角色定妆图', sizes: Array(6).fill('1024x1536'), videoSeconds: '6', videoSize: '720x1280', disclaimer: 'Gallery 只汇总候选；每镜第一个候选作为当前视频节点输入。' }),
  createBranchTemplate({ id: 'xingmang-comic-strip-6', name: '六格不崩脸条漫', description: '六格并行创作，每格提供四张候选。', industry: 'story', deliverable: '六格条漫画面素材', tags: ['漫画', '条漫', '角色一致'], operation: 'image-edit', branches: 6, variants: 4, promptDefaults: Array.from({ length: 6 }, (_, index) => complete(`第 ${index + 1} 格条漫画面`)), assetLabel: '角色定妆图', sizes: Array(6).fill('1024x1536'), disclaimer: '长条拼接和文字排版需在外部工具完成。' }),
  createBranchTemplate({ id: 'xingmang-comic-lineart-color', name: '线稿上色翻新', description: '保持线条与构图，输出四张上色候选。', industry: 'story', deliverable: '线稿上色候选', tags: ['漫画', '线稿', '上色'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('保持线条和构图不变，赛璐璐风格上色')], assetLabel: '线稿图片', sizes: ['1024x1536'] }),
  createBranchTemplate({ id: 'xingmang-picturebook-12', name: '十二页绘本流水线', description: '十二页双候选生产骨架，共 24 个图片请求。', industry: 'education', deliverable: '十二页绘本画面素材', tags: ['绘本', '十二页', '角色一致'], operation: 'image-edit', branches: 12, variants: 2, promptDefaults: Array.from({ length: 12 }, (_, index) => complete(`绘本第 ${index + 1} 页场景与动作`)), assetLabel: '主角定妆图', sizes: Array(12).fill('1024x1536'), disclaimer: '分页、文字、印刷色彩与配音需在外部工具完成。' }),
  createBranchTemplate({ id: 'xingmang-edu-courseware-4', name: '课件插图四连', description: '四个知识点各生成两张横版插图。', industry: 'education', deliverable: '八张课件插图', tags: ['教育', '课件', 'PPT'], operation: 'image-generate', branches: 4, variants: 2, promptDefaults: ['教学示意图，结构清楚，适合课件', '卡通教学场景，人物动作明确', '知识流程图式插画，留出标注空间', '知识点拟人插画，儿童友好'], sizes: Array(4).fill('1536x1152') }),
  createBranchTemplate({ id: 'xingmang-ec-white-bg', name: '白底图速产', description: '一张商品实拍生成四张白底候选。', industry: 'commerce', deliverable: '电商白底图候选', tags: ['电商', '白底图', '商品'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('商品居中，纯白背景，无文字无道具，保留真实细节')], assetLabel: '商品实拍', sizes: ['1024x1024'], featured: true, disclaimer: '生成结果需与真实商品核对后再用于销售页面。' }),
  createBranchTemplate({ id: 'xingmang-ec-scene-3', name: '场景图三连拍', description: '同一商品生成三种场景，每种两张候选。', industry: 'commerce', deliverable: '六张商品场景图', tags: ['电商', '场景图'], operation: 'image-edit', branches: 3, variants: 2, promptDefaults: [complete('原木家居桌面商品场景'), complete('自然户外生活方式商品场景'), complete('红金促销氛围商品场景')], assetLabel: '商品图片', sizes: Array(3).fill('1024x1024') }),
  createBranchTemplate({ id: 'xingmang-ec-size-trio', name: '主图规格三连', description: '为方形、竖版和横版各生成两张主图。', industry: 'commerce', deliverable: '六张多规格主图', tags: ['电商', '多规格', '主图'], operation: 'image-edit', branches: 3, variants: 2, promptDefaults: [complete('方形电商主图'), complete('竖版电商主图'), complete('横版电商主图')], assetLabel: '商品图片', sizes: ['1024x1024', '1152x1536', '1280x720'] }),
  createBranchTemplate({ id: 'xingmang-home-rough-6', name: '毛坯房秒变样板间', description: '六种风格各两张概念效果图，共 12 个图片请求。', industry: 'architecture', deliverable: '十二张家装概念效果图', tags: ['家装', '毛坯房', '样板间'], operation: 'image-edit', branches: 6, variants: 2, promptDefaults: ['奶油风软硬装，保持门窗与透视', '原木风软硬装，保持门窗与透视', '意式极简软硬装，保持门窗与透视', '新中式软硬装，保持门窗与透视', '法式奶油软硬装，保持门窗与透视', '黑白灰现代软硬装，保持门窗与透视'], assetLabel: '毛坯房实拍', sizes: Array(6).fill('1536x1152'), featured: true, disclaimer: '仅用于概念沟通，不是施工图或材料承诺。' }),
  createBranchTemplate({ id: 'xingmang-arch-mass-render', name: '体块草模转效果图', description: '把体块草模生成四张方案概念效果图。', industry: 'architecture', deliverable: '建筑方案概念图', tags: ['建筑', '体块', '效果图'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('严格保持建筑体量和视角，补充材质、环境与光影')], assetLabel: '体块草模截图', sizes: ['1536x1152'], disclaimer: '用于概念汇报，不替代建筑深化与施工图。' }),
  createBranchTemplate({ id: 'xingmang-arch-renewal', name: '旧改立面焕新对比', description: '基于现场图生成四张旧改概念候选。', industry: 'architecture', deliverable: '旧改概念对比图', tags: ['建筑', '旧改', '立面'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('保留主体结构，更新立面材料、门窗和公共空间')], assetLabel: '现场原图', sizes: ['1536x1152'], disclaimer: '仅作改造概念沟通，实际工程需专业复核。' }),
  createBranchTemplate({ id: 'xingmang-media-xhs-cover', name: '小红书封面四连拍', description: '生成四张 3:4 社交封面底图候选。', industry: 'social-media', deliverable: '四张封面底图', tags: ['自媒体', '封面', '小红书'], operation: 'image-generate', branches: 1, variants: 4, promptDefaults: [complete('社交媒体封面底图，视觉焦点明确，预留标题区域')], sizes: ['1152x1536'], featured: true, disclaimer: '只生成底图，不保证文字排版；标题需在外部工具完成。' }),
  createBranchTemplate({ id: 'xingmang-media-broll-3', name: '口播 B-roll 素材包', description: '三段竖屏空镜，各生成一张首帧和一段 6 秒视频。', industry: 'social-media', deliverable: '三段竖屏 B-roll', tags: ['自媒体', 'B-roll', '口播'], operation: 'image-generate', branches: 3, variants: 1, promptDefaults: [complete('口播第一段辅助空镜'), complete('口播第二段辅助空镜'), complete('口播第三段辅助空镜')], sizes: Array(3).fill('720x1280'), videoSeconds: '6', videoSize: '720x1280' }),
  createBranchTemplate({ id: 'xingmang-game-icon-set', name: '道具图标套系', description: '参考既有图标生成四张同风格道具候选。', industry: 'game', deliverable: '四张道具图标候选', tags: ['游戏', '图标', '道具'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('同视角同材质风格的新道具图标')], assetLabel: '风格锚图标', sizes: ['1024x1024'], disclaimer: '透明背景不作保证，交付前需检查抠图。' }),
  createBranchTemplate({ id: 'xingmang-game-variant', name: '角色立绘差分工厂', description: '保持身份不变生成四张表情或服装差分。', industry: 'game', deliverable: '四张角色立绘差分', tags: ['游戏', '角色', '立绘'], operation: 'image-edit', branches: 1, variants: 4, promptDefaults: [complete('保持长相发型与姿势，仅改变指定表情或服装细节')], assetLabel: '角色定稿', sizes: ['1024x1536'] }),
  createBranchTemplate({ id: 'xingmang-ad-ab-pair', name: '信息流 AB 素材产线', description: 'A/B 两条支路各生成一张图片和一段 5 秒视频。', industry: 'marketing-film', deliverable: '两组信息流图片与视频', tags: ['广告', 'AB', '信息流'], operation: 'image-generate', branches: 2, variants: 1, promptDefaults: [complete('卖点 A 的竖屏视觉脚本'), complete('卖点 B 的竖屏视觉脚本')], sizes: Array(2).fill('720x1280'), videoSeconds: '5', videoSize: '720x1280' }),
  createDirectVideoTemplate({ id: 'xingmang-film-animatic', name: '分镜帧转动态预演', description: '把静态分镜转成 5 秒横屏动态预演。', industry: 'marketing-film', deliverable: '5 秒动态分镜', tags: ['影视', '分镜', '预演'], seconds: '5', size: '1280x720', prompt: '固定机位，轻微推近，保持构图与人物身份。', disclaimer: '当前不支持尾帧约束；结果用于提案预演。' }),
]
