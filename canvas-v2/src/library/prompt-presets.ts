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
  {
    id: 'xingmang-commerce-white-background', title: '电商纯白底', description: '商品居中、白底、保留真实细节。',
    prompt: '严格保持商品外形、颜色、材质、标签与比例，将背景替换为纯白色 #FFFFFF，商品居中占画面约 80%，边缘干净，无道具、无文字、无额外装饰，保留自然轻微接地阴影。',
    tags: ['电商', '白底图', '商品'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-commerce-home-scene', title: '原木家居场景', description: '温暖自然的商品生活方式图。',
    prompt: '保持商品主体完全一致，放置在温暖原木家居桌面场景中，晨间自然光，背景简洁，空间透视与接地阴影真实，画面适合电商生活方式展示。',
    tags: ['电商', '场景图', '家居'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-interior-cream', title: '奶油风样板间', description: '保持房间结构的奶油风软硬装。',
    prompt: '严格保持原房间墙体、门窗位置、梁柱、层高、镜头视角和透视完全不变，仅更新为柔和奶油风软硬装，米白与暖灰配色，圆润家具，真实自然采光。',
    tags: ['家装', '奶油风', '样板间'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-interior-wood', title: '原木风样板间', description: '保持结构的自然原木空间。',
    prompt: '严格保持原房间结构、门窗位置和透视不变，仅加入自然原木、亚麻与米色材质，简洁收纳，柔和日光，形成安静克制的原木风室内概念效果图。',
    tags: ['家装', '原木风', '室内'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-interior-italian', title: '意式极简样板间', description: '深浅材质对比的意式极简空间。',
    prompt: '保持原始结构、门窗、尺度与视角，使用意式极简语言重做软硬装：低饱和石材、深色木饰面、线性灯光和低矮家具，材质真实，空间克制高级。',
    tags: ['家装', '意式极简', '室内'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-interior-chinese', title: '新中式样板间', description: '现代比例与东方材质结合。',
    prompt: '保持房间结构、门窗和透视不变，以现代简洁比例结合木格栅、浅木、石材和克制东方陈设，形成明亮雅致的新中式概念空间。',
    tags: ['家装', '新中式', '室内'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-lineart-cel-color', title: '赛璐璐线稿上色', description: '保持线条和构图的干净上色。',
    prompt: '完全保持原线稿轮廓、构图、人物比例和表情，仅进行干净的赛璐璐风格上色，色块边界清晰，高光与阴影方向统一，不添加或删除线条。',
    tags: ['漫画', '线稿', '上色'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-social-cover-base', title: '社交封面底图', description: '视觉焦点明确并预留标题区域。',
    prompt: '生成 3:4 竖版社交媒体封面底图，主体清晰，色彩统一，构图有强视觉焦点，在画面上方或左侧预留干净标题区域，不生成任何文字、字母、Logo 或水印。',
    tags: ['自媒体', '封面', '底图'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-story-character-card', title: '叙事角色定妆', description: '稳定身份特征的角色设定卡。',
    prompt: '全身角色设定卡，纯色背景，人物正面站姿，清晰展示脸部、发型、服装、鞋履和标志性配饰，身份特征明确，比例自然，画风统一，不生成文字。',
    tags: ['漫剧', '角色', '定妆'], provenance: 'xingmang-original',
  },
  {
    id: 'xingmang-game-icon-anchor', title: '同风格道具图标', description: '沿用锚图的视角、材质与光影。',
    prompt: '严格沿用参考图标的镜头视角、轮廓语言、材质表现、边缘光和阴影方向，生成新的单体道具图标，主体居中，背景简洁，不生成文字和额外装饰。',
    tags: ['游戏', '图标', '道具'], provenance: 'xingmang-original',
  },
]

export function searchPromptPresets(query: string): readonly CanvasPromptPreset[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return builtinPromptPresets
  return builtinPromptPresets.filter((preset) => (
    `${preset.title} ${preset.description} ${preset.tags.join(' ')}`.toLocaleLowerCase('zh-CN').includes(normalized)
  ))
}
