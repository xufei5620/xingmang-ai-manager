export interface CanvasPromptPreset {
  id: string
  title: string
  description: string
  prompt: string
  tags: readonly string[]
  provenance: 'xingmang-original'
}

export const builtinPromptPresets: readonly CanvasPromptPreset[] = [
  {
    id: 'xingmang-product-studio',
    title: '商品棚拍',
    description: '干净布光和可控背景，适合产品主图。',
    prompt: '保持产品外形、材质和品牌细节准确，使用专业棚拍布光，背景简洁，主体边缘清晰，阴影自然，无多余文字和水印。',
    tags: ['商品', '棚拍', '主图'],
    provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-scene-relight',
    title: '场景换光',
    description: '保留构图与主体，重新设计光影氛围。',
    prompt: '保留原图的主体、镜头视角和构图关系，将光线调整为戏剧化的黄金时刻侧逆光，统一色温和阴影方向，保持细节真实。',
    tags: ['光影', '氛围', '改图'],
    provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-portrait-editorial',
    title: '人像编辑',
    description: '自然肤感与杂志级人像光线。',
    prompt: '保留人物身份特征和自然肤感，使用克制的杂志编辑布光，眼神清晰，发丝边缘自然，色彩统一，避免过度磨皮和夸张五官。',
    tags: ['人像', '编辑', '摄影'],
    provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-background-replace',
    title: '背景替换',
    description: '维持主体比例，让新背景的透视与光影匹配。',
    prompt: '精确保留前景主体的轮廓、比例和纹理，替换背景后匹配镜头透视、景深、色温、环境反射和接地阴影，不增加无关物体。',
    tags: ['背景', '合成', '改图'],
    provenance: 'xingmang-original',
  },
]

export function searchPromptPresets(query: string): readonly CanvasPromptPreset[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return builtinPromptPresets
  return builtinPromptPresets.filter((preset) => (
    `${preset.title} ${preset.description} ${preset.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(normalized)
  ))
}
