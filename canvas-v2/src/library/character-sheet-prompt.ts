export const characterSheetLayoutPrompt = [
  '生成角色的多视图；上下板块展示，上方板块占画面1/3，纯色背景。',
  '上方板块：展示角色头部肖像特写三视图（正面、半侧面、背面）；',
  '下方板块：展示角色脖子以下站立三视图（正面、半侧面、背面），严禁展示头部，仅展示脖子到鞋这部分区域站立三视图。',
  '同一角色身份、发型、服装、配色在六视图中完全一致。柔和均匀柔光。不生成文字、标注、水印、装饰分割线。',
].join('\n')

export const defaultCharacterSheetStyle = '3D漫剧写实厚涂风。'

export const exampleCharacterAppearance = [
  '韩系年轻少女，浅金色凌乱短发，发丝柔软蓬松，几缕碎发自然贴在脸颊，淡骨相韩式脸型，无辜大圆灰瞳眼睛，水光冷白皮，韩式水光肌，面部精细水光高光，鼻梁高光、鼻尖高光、面中苹果肌高光、唇珠高光，淡韩式伪素颜妆容，淡腮红，精致洋娃娃五官。',
  '身穿长款淡黄色小鸡毛绒连帽卫衣，帽子带有鸡嘴巴造型，帽内衬白色毛绒，脚踝穿着堆堆袜，小黄鸭拖鞋。纯白色背景。',
].join('')

export function composeCharacterSheetPrompt(input: {
  appearance: string
  style?: string
  layout?: string
}): string {
  const layout = (input.layout ?? characterSheetLayoutPrompt).trim()
  const appearance = input.appearance.trim()
  const style = (input.style ?? defaultCharacterSheetStyle).trim()
  if (!appearance) return [layout, style].filter(Boolean).join('\n\n')
  return [layout, appearance, style].filter(Boolean).join('\n\n')
}

export const defaultCharacterSheetPrompt = composeCharacterSheetPrompt({
  appearance: exampleCharacterAppearance,
})
