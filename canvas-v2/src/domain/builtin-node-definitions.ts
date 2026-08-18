import type { WorkflowNodeData } from '../model'
import {
  invalidNodeData,
  validNodeData,
  type LegacyNodeAdapter,
  type NodeDefinition,
  type NodePortDefinition,
} from './node-definition'
import { createNodeRegistry } from './node-registry'

const textInput: NodePortDefinition = { id: 'in:text', label: '文本', direction: 'input', kind: 'text', cardinality: 'many' }
const imageInput: NodePortDefinition = { id: 'in:image', label: '图像', direction: 'input', kind: 'image', cardinality: 'one' }
const imageInputs: NodePortDefinition = { id: 'in:images', label: '图像', direction: 'input', kind: 'image', cardinality: 'many' }
const videoInput: NodePortDefinition = { id: 'in:video', label: '视频', direction: 'input', kind: 'video', cardinality: 'one' }
const videoInputs: NodePortDefinition = { id: 'in:videos', label: '视频', direction: 'input', kind: 'video', cardinality: 'many' }
const audioInput: NodePortDefinition = { id: 'in:audio', label: '音频', direction: 'input', kind: 'audio', cardinality: 'one' }
const audioInputs: NodePortDefinition = { id: 'in:audios', label: '音频', direction: 'input', kind: 'audio', cardinality: 'many' }
const textOutput: NodePortDefinition = { id: 'out:text', label: '文本', direction: 'output', kind: 'text', cardinality: 'many' }
const imageOutput: NodePortDefinition = { id: 'out:image', label: '图像', direction: 'output', kind: 'image', cardinality: 'many' }
const videoOutput: NodePortDefinition = { id: 'out:video', label: '视频', direction: 'output', kind: 'video', cardinality: 'many' }
const audioOutput: NodePortDefinition = { id: 'out:audio', label: '音频', direction: 'output', kind: 'audio', cardinality: 'many' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function validateRecord(data: unknown) {
  return isRecord(data) ? validNodeData() : invalidNodeData('节点数据必须是对象')
}

function mediaDefinition(input: Omit<NodeDefinition, 'validate'>): NodeDefinition {
  return { ...input, validate: validateRecord }
}

export const builtinNodeDefinitions: readonly NodeDefinition[] = [
  mediaDefinition({
    type: 'prompt', version: 1, title: '提示词', description: '为下游节点提供文本', category: 'input',
    ports: [textOutput], dimensions: { width: 288, height: 176 }, defaultData: { prompt: '' },
    executable: true, structural: false, executorKind: 'prompt', capabilities: [{ media: 'text', operation: 'input' }],
  }),
  mediaDefinition({
    type: 'image-input', version: 1, title: '图片素材', description: '引用本地图片资产', category: 'input',
    ports: [imageOutput], dimensions: { width: 280, height: 340 }, defaultData: { assetId: '' },
    executable: true, structural: false, executorKind: 'transform', capabilities: [{ media: 'image', operation: 'input' }],
  }),
  mediaDefinition({
    type: 'video-input', version: 1, title: '视频素材', description: '引用本地视频资产', category: 'input',
    ports: [videoOutput], dimensions: { width: 280, height: 220 }, defaultData: { assetId: '' },
    executable: true, structural: false, executorKind: 'transform', capabilities: [{ media: 'video', operation: 'input' }],
  }),
  mediaDefinition({
    type: 'audio-input', version: 1, title: '音频素材', description: '引用本地音频资产', category: 'input',
    ports: [audioOutput], dimensions: { width: 280, height: 180 }, defaultData: { assetId: '' },
    executable: true, structural: false, executorKind: 'transform', capabilities: [{ media: 'audio', operation: 'input' }],
  }),
  mediaDefinition({
    type: 'image-generate', version: 1, title: '图像生成', description: '根据提示词生成图像', category: 'generation',
    ports: [textInput, imageOutput], dimensions: { width: 304, height: 300 }, defaultData: { prompt: '', model: '', quality: 'low', size: '1024x1024' },
    executable: true, structural: false, executorKind: 'image', capabilities: [{ media: 'image', operation: 'generate' }],
  }),
  mediaDefinition({
    type: 'image-edit', version: 1, title: '图像编辑', description: '使用 1-4 张参考图和指令编辑图像', category: 'transform',
    ports: [textInput, imageInputs, imageOutput], dimensions: { width: 304, height: 360 }, defaultData: { prompt: '', model: '', maskAssetId: '' },
    executable: true, structural: false, executorKind: 'image', capabilities: [{ media: 'image', operation: 'edit' }],
  }),
  mediaDefinition({
    type: 'video-generate', version: 1, title: '视频生成', description: '文生视频或图生视频（支持多前置输入）', category: 'generation',
    ports: [textInput, imageInputs, videoInputs, audioInputs, videoOutput], dimensions: { width: 304, height: 480 }, defaultData: { prompt: '', model: '', seconds: '5', size: '1280x720' },
    executable: true, structural: false, executorKind: 'video', capabilities: [{ media: 'video', operation: 'generate' }],
  }),
  mediaDefinition({
    type: 'frame-extract', version: 1, title: '视频抽帧', description: '从视频中提取指定帧', category: 'transform',
    ports: [videoInput, imageOutput], dimensions: { width: 260, height: 190 }, defaultData: { timestampSeconds: 0 },
    executable: true, structural: false, executorKind: 'transform', capabilities: [{ media: 'video', operation: 'extract' }],
  }),
  mediaDefinition({
    type: 'router', version: 1, title: '路由', description: '按媒体类型分流', category: 'flow',
    ports: [textInput, imageInputs, videoInputs, audioInputs, textOutput, imageOutput, videoOutput, audioOutput], dimensions: { width: 224, height: 182 }, defaultData: { strategy: 'first-available' },
    executable: true, structural: false, executorKind: 'flow', capabilities: [{ media: 'text', operation: 'route' }],
  }),
  mediaDefinition({
    type: 'gallery', version: 1, title: '候选画廊', description: '汇总并挑选多个生成结果', category: 'flow',
    ports: [imageInputs, videoInputs, audioInputs, imageOutput, videoOutput, audioOutput], dimensions: { width: 360, height: 300 }, defaultData: { adoptedAssetId: '' },
    executable: true, structural: false, executorKind: 'flow', capabilities: [{ media: 'image', operation: 'collect' }],
  }),
  mediaDefinition({
    type: 'output', version: 1, title: '输出', description: '标记工作流的最终产物', category: 'output',
    ports: [textInput, imageInput, videoInput, audioInput], dimensions: { width: 240, height: 182 }, defaultData: { label: '最终产物' },
    executable: true, structural: false, executorKind: 'output', capabilities: [{ media: 'image', operation: 'output' }],
  }),
  mediaDefinition({
    type: 'group', version: 1, title: '分组', description: '组织画布节点', category: 'structural',
    ports: [], dimensions: { width: 560, height: 360 }, defaultData: { title: '新建分组' },
    executable: false, structural: true,
  }),
  mediaDefinition({
    type: 'note', version: 1, title: '便签', description: '记录画布说明', category: 'structural',
    ports: [], dimensions: { width: 260, height: 180 }, defaultData: { text: '' },
    executable: false, structural: true,
  }),
  mediaDefinition({
    type: 'unknown', version: 1, title: '未知节点', description: '当前版本无法识别的节点占位符', category: 'structural',
    ports: [], dimensions: { width: 260, height: 140 }, defaultData: { originalType: '', message: '节点类型未安装' },
    executable: false, structural: true,
  }),
  // Legacy aliases keep the current App and execution engine operational.
  mediaDefinition({
    type: 'text', version: 1, title: '文本', description: '旧版提示词节点', category: 'input',
    ports: [textOutput], dimensions: { width: 240, height: 180 }, defaultData: { prompt: '', model: '', status: 'idle' },
    executable: true, structural: false, executorKind: 'prompt', capabilities: [{ media: 'text', operation: 'input' }],
  }),
  mediaDefinition({
    type: 'image', version: 1, title: '图像生成', description: '旧版图像节点', category: 'generation',
    ports: [textInput, imageOutput], dimensions: { width: 240, height: 300 }, defaultData: { prompt: '', model: '', status: 'idle' },
    executable: true, structural: false, executorKind: 'image', capabilities: [{ media: 'image', operation: 'generate' }],
  }),
  mediaDefinition({
    type: 'video', version: 1, title: '视频生成', description: '旧版视频节点', category: 'generation',
    ports: [textInput, imageInputs, videoInputs, audioInputs, videoOutput], dimensions: { width: 240, height: 420 }, defaultData: { prompt: '', model: '', status: 'idle' },
    executable: true, structural: false, executorKind: 'video', capabilities: [{ media: 'video', operation: 'generate' }],
  }),
]

export const builtinNodeRegistry = createNodeRegistry(builtinNodeDefinitions)

export const legacyNodeAdapters: readonly LegacyNodeAdapter[] = [
  { legacyType: 'text', definitionType: 'prompt', toDefinitionData: (data) => ({ prompt: data.prompt }) },
  {
    legacyType: 'image', definitionType: 'image-generate',
    toDefinitionData: (data: WorkflowNodeData) => ({ prompt: data.prompt, model: data.model, quality: data.quality, size: data.size }),
  },
  {
    legacyType: 'video', definitionType: 'video-generate',
    toDefinitionData: (data: WorkflowNodeData) => ({ prompt: data.prompt, model: data.model }),
  },
]

export function resolveLegacyDefinitionType(type: string): string {
  return legacyNodeAdapters.find((entry) => entry.legacyType === type)?.definitionType ?? type
}
