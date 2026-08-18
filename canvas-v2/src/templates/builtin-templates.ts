import type { CanvasTemplate } from './template-types'

const quickImage: CanvasTemplate = {
  id: 'xingmang-quick-image',
  version: 1,
  name: '快速文生图',
  description: '从一段提示词生成一张图像结果。',
  category: 'image',
  tags: ['文生图', '候选'],
  thumbnail: { kind: 'color', value: '#315B9A' },
  requiredNodeTypes: ['prompt', 'image-generate', 'gallery', 'output'],
  workflow: {
    nodes: [
      { id: 'prompt', type: 'prompt', definitionVersion: 1, position: { x: 40, y: 140 }, config: { prompt: '' } },
      { id: 'generate', type: 'image-generate', definitionVersion: 1, position: { x: 340, y: 120 }, config: {} },
      { id: 'gallery', type: 'gallery', definitionVersion: 1, position: { x: 650, y: 100 }, config: {} },
      { id: 'output', type: 'output', definitionVersion: 1, position: { x: 960, y: 130 }, config: {} },
    ],
    edges: [
      { id: 'prompt-generate', source: 'prompt', sourceHandle: 'out:text', target: 'generate', targetHandle: 'in:text' },
      { id: 'generate-gallery', source: 'generate', sourceHandle: 'out:image', target: 'gallery', targetHandle: 'in:images' },
      { id: 'gallery-output', source: 'gallery', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' },
    ],
  },
  variables: [
    { id: 'prompt', label: '画面描述', type: 'text', required: true, target: { nodeId: 'prompt', path: 'prompt' } },
  ],
  provenance: { kind: 'xingmang-original' },
}

const referenceEdit: CanvasTemplate = {
  id: 'xingmang-reference-edit',
  version: 1,
  name: '参考图改图',
  description: '导入参考图并描述修改要求，生成一张编辑结果。',
  category: 'image',
  tags: ['图生图', '编辑'],
  thumbnail: { kind: 'color', value: '#34775C' },
  requiredNodeTypes: ['image-input', 'prompt', 'image-edit', 'gallery', 'output'],
  workflow: {
    nodes: [
      { id: 'image', type: 'image-input', definitionVersion: 1, position: { x: 40, y: 60 }, config: {} },
      { id: 'prompt', type: 'prompt', definitionVersion: 1, position: { x: 40, y: 280 }, config: { prompt: '' } },
      { id: 'edit', type: 'image-edit', definitionVersion: 1, position: { x: 360, y: 140 }, config: {} },
      { id: 'gallery', type: 'gallery', definitionVersion: 1, position: { x: 680, y: 120 }, config: {} },
      { id: 'output', type: 'output', definitionVersion: 1, position: { x: 990, y: 150 }, config: {} },
    ],
    edges: [
      { id: 'image-edit', source: 'image', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:images' },
      { id: 'prompt-edit', source: 'prompt', sourceHandle: 'out:text', target: 'edit', targetHandle: 'in:text' },
      { id: 'edit-gallery', source: 'edit', sourceHandle: 'out:image', target: 'gallery', targetHandle: 'in:images' },
      { id: 'gallery-output', source: 'gallery', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' },
    ],
  },
  variables: [
    { id: 'reference', label: '参考图', type: 'asset', required: true, target: { nodeId: 'image', path: 'assetId' } },
    { id: 'prompt', label: '修改要求', type: 'text', required: true, target: { nodeId: 'prompt', path: 'prompt' } },
  ],
  provenance: { kind: 'xingmang-original' },
}

const productVideo: CanvasTemplate = {
  id: 'xingmang-product-video',
  version: 1,
  name: '产品图生成短视频',
  description: '使用产品图和镜头描述生成短视频候选。',
  category: 'video',
  tags: ['图生视频', '产品'],
  thumbnail: { kind: 'color', value: '#8A543D' },
  requiredNodeTypes: ['image-input', 'prompt', 'video-generate', 'gallery', 'output'],
  workflow: {
    nodes: [
      { id: 'image', type: 'image-input', definitionVersion: 1, position: { x: 40, y: 60 }, config: {} },
      { id: 'prompt', type: 'prompt', definitionVersion: 1, position: { x: 40, y: 280 }, config: { prompt: '' } },
      { id: 'generate', type: 'video-generate', definitionVersion: 1, position: { x: 360, y: 140 }, config: { seconds: '5' } },
      { id: 'gallery', type: 'gallery', definitionVersion: 1, position: { x: 680, y: 120 }, config: {} },
      { id: 'output', type: 'output', definitionVersion: 1, position: { x: 990, y: 150 }, config: {} },
    ],
    edges: [
      { id: 'image-generate', source: 'image', sourceHandle: 'out:image', target: 'generate', targetHandle: 'in:images' },
      { id: 'prompt-generate', source: 'prompt', sourceHandle: 'out:text', target: 'generate', targetHandle: 'in:text' },
      { id: 'generate-gallery', source: 'generate', sourceHandle: 'out:video', target: 'gallery', targetHandle: 'in:videos' },
      { id: 'gallery-output', source: 'gallery', sourceHandle: 'out:video', target: 'output', targetHandle: 'in:video' },
    ],
  },
  variables: [
    { id: 'product', label: '产品图', type: 'asset', required: true, target: { nodeId: 'image', path: 'assetId' } },
    { id: 'prompt', label: '镜头描述', type: 'text', required: true, target: { nodeId: 'prompt', path: 'prompt' } },
  ],
  provenance: { kind: 'xingmang-original' },
}

export const builtinCanvasTemplates: readonly CanvasTemplate[] = [quickImage, referenceEdit, productVideo]
