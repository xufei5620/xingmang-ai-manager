export type ImageCollageTemplateLayout = 'template-balanced' | 'template-stacked' | 'template-sidebar' | 'template-banner' | 'template-feature' | 'template-l'

export interface ImageCollageTemplate {
  layout: ImageCollageTemplateLayout
  title: string
  inputCount: 2 | 3
  description: string
  direction: 'horizontal' | 'vertical'
  weights: readonly [number, number]
  secondaryDirection?: 'horizontal' | 'vertical'
}

/** Fixed proportions are independent of the input images and the legacy hero layouts. */
export const imageCollageTemplates: readonly ImageCollageTemplate[] = [
  { layout: 'template-balanced', title: '双栏平衡', inputCount: 2, description: '左右均分，适合并列展示。', direction: 'horizontal', weights: [1, 1] },
  { layout: 'template-stacked', title: '上下分屏', inputCount: 2, description: '上下均分，适合纵向叙事。', direction: 'vertical', weights: [1, 1] },
  { layout: 'template-sidebar', title: '主图侧栏', inputCount: 2, description: '主图占左侧 65%，细节置于右侧。', direction: 'horizontal', weights: [65, 35] },
  { layout: 'template-banner', title: '横幅主图', inputCount: 3, description: '上方主图占一半，下方双图并列。', direction: 'vertical', weights: [1, 1], secondaryDirection: 'horizontal' },
  { layout: 'template-feature', title: '左主右辅', inputCount: 3, description: '左侧主图占 60%，右侧双图上下排列。', direction: 'horizontal', weights: [60, 40], secondaryDirection: 'vertical' },
  { layout: 'template-l', title: 'L 型分区', inputCount: 3, description: '左右各占一半，右侧双图上下排列。', direction: 'horizontal', weights: [1, 1], secondaryDirection: 'vertical' },
]

export function resolveImageCollageTemplate(layout: unknown): ImageCollageTemplate | undefined {
  return imageCollageTemplates.find((template) => template.layout === layout)
}
