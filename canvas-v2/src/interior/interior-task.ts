import type { ImageReferenceOrder } from '../commerce/image-reference-order'
import type { ImageRequestParametersInput } from '../runtime/image-request-parameters'

export type InteriorWeather = 'none' | 'overcast' | 'sunny' | 'rainy'
export type InteriorTime = 'none' | 'dawn' | 'noon-sun' | 'noon-overcast' | 'evening' | 'night'
export type InteriorExterior = 'none' | 'sea' | 'river' | 'mountain' | 'garden' | 'city' | 'town' | 'snow-mountain' | 'street'
export type InteriorFilter = 'none' | 'airy-japanese' | 'cool-nordic' | 'soft-cream' | 'teal-orange' | 'dramatic' | 'film'
export interface InteriorTask {
  version: 1
  kind: 'interior-render'
  addDecor: boolean
  addPeople: boolean
  enclosedSpace: boolean
  interiorLighting: boolean
  weather: InteriorWeather
  time: InteriorTime
  exterior: InteriorExterior
  filter: InteriorFilter
}
export const interiorTaskToggleOptions: readonly { key: 'addDecor' | 'addPeople' | 'enclosedSpace' | 'interiorLighting'; label: string; instruction: string }[] = [
  { key: 'addDecor', label: '增加摆件', instruction: '加入与空间尺度、用途协调的少量室内摆件。' },
  { key: 'addPeople', label: '增加人物', instruction: '加入尺度和透视合理的自然人物，不遮挡空间主体。' },
  { key: 'enclosedSpace', label: '封闭空间', instruction: '以封闭室内空间呈现，保留建筑围合关系，不主动拆除墙面或顶棚。' },
  { key: 'interiorLighting', label: '室内灯光', instruction: '加入合理的室内人工照明，保持灯光方向、阴影和空间关系协调。' },
]
export const interiorWeatherOptions: readonly { value: InteriorWeather; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, { value: 'overcast', label: '阴天', instruction: '室外为阴天，使用柔和漫射自然光。' },
  { value: 'sunny', label: '晴天', instruction: '室外为晴天，自然光与所选时段协调。' }, { value: 'rainy', label: '雨天', instruction: '室外为雨天，窗外环境与室内反射体现湿润天气。' },
]
export const interiorTimeOptions: readonly { value: InteriorTime; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, { value: 'dawn', label: '清晨', instruction: '以清晨的环境亮度与光色呈现。' },
  { value: 'noon-sun', label: '正午（有太阳）', instruction: '以正午直射日光呈现，光线仅从合理的开口进入。' },
  { value: 'noon-overcast', label: '正午（无太阳）', instruction: '以正午亮度呈现，避免明显的直射阳光光斑。' },
  { value: 'evening', label: '傍晚', instruction: '以傍晚的环境亮度与暖色天光呈现。' }, { value: 'night', label: '深夜', instruction: '以深夜的窗外亮度和室内外光照关系呈现。' },
]
export const interiorExteriorOptions: readonly { value: InteriorExterior; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, { value: 'sea', label: '海景', instruction: '可见的窗外景观采用海景。' },
  { value: 'river', label: '江景', instruction: '可见的窗外景观采用江河景观。' }, { value: 'mountain', label: '山景', instruction: '可见的窗外景观采用山景。' },
  { value: 'garden', label: '庭院', instruction: '可见的窗外景观采用庭院。' }, { value: 'city', label: '城市', instruction: '可见的窗外景观采用城市景观。' },
  { value: 'town', label: '小镇', instruction: '可见的窗外景观采用小镇。' }, { value: 'snow-mountain', label: '雪山', instruction: '可见的窗外景观采用雪山。' },
  { value: 'street', label: '街景', instruction: '可见的窗外景观采用街景。' },
]
export const interiorFilterOptions: readonly { value: InteriorFilter; label: string; instruction: string }[] = [
  { value: 'none', label: '无', instruction: '' }, { value: 'airy-japanese', label: '日式清新明亮', instruction: '视觉方向为日式清新明亮，克制配色与柔和质感。' },
  { value: 'cool-nordic', label: '北欧清冷蓝调', instruction: '视觉方向为北欧清冷蓝调，干净明暗与低饱和冷色。' },
  { value: 'soft-cream', label: '柔和奶油色调', instruction: '视觉方向为柔和奶油色调，温润浅色与柔和明暗。' },
  { value: 'teal-orange', label: '青橙电影色调', instruction: '视觉方向为克制的青橙电影色调，保持室内材质可辨。' },
  { value: 'dramatic', label: '高对比戏剧光', instruction: '视觉方向为高对比戏剧光，保留阴影中的空间细节。' },
  { value: 'film', label: '复古胶片质感', instruction: '视觉方向为复古胶片质感与自然色层。' },
]

export function defaultInteriorTask(): InteriorTask {
  return { version: 1, kind: 'interior-render', addDecor: false, addPeople: false, enclosedSpace: false, interiorLighting: false, weather: 'sunny', time: 'noon-overcast', exterior: 'none', filter: 'none' }
}

export function parseInteriorTask(value: unknown): InteriorTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('室内创作配置格式不正确')
  const raw = value as Record<string, unknown>
  const keys = ['version', 'kind', ...interiorTaskToggleOptions.map((option) => option.key), 'weather', 'time', 'exterior', 'filter']
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some((key) => !keys.includes(key))) throw new Error('室内创作包含未知或缺少必要配置，请重新读取')
  if (raw.version !== 1 || raw.kind !== 'interior-render') throw new Error('室内创作版本或类型不受支持')
  if (interiorTaskToggleOptions.some((option) => typeof raw[option.key] !== 'boolean')) throw new Error('室内创作开关必须为明确的开启或关闭状态')
  if (!interiorWeatherOptions.some((option) => option.value === raw.weather) || !interiorTimeOptions.some((option) => option.value === raw.time)
    || !interiorExteriorOptions.some((option) => option.value === raw.exterior) || !interiorFilterOptions.some((option) => option.value === raw.filter)) throw new Error('室内创作的天气、时间、外景或滤镜方向不受支持')
  return { version: 1, kind: 'interior-render', addDecor: raw.addDecor as boolean, addPeople: raw.addPeople as boolean, enclosedSpace: raw.enclosedSpace as boolean, interiorLighting: raw.interiorLighting as boolean, weather: raw.weather as InteriorWeather, time: raw.time as InteriorTime, exterior: raw.exterior as InteriorExterior, filter: raw.filter as InteriorFilter }
}

export function parseNodeInteriorTask(kind: string, value: unknown): InteriorTask {
  if (!['image', 'image-generate', 'image-edit'].includes(kind)) throw new Error('此节点不支持室内渲染任务')
  return parseInteriorTask(value)
}

/** Disabled options add no instruction: they never request removal of existing scene content. */
export function buildInteriorTaskPrompt(value: InteriorTask, supplement: string): string {
  const task = parseInteriorTask(value)
  const lines = ['【室内渲染】', '第 1 张参考图是唯一室内原图。保留原图的空间结构、门窗位置、透视和主要构图，完成室内视觉渲染。']
  for (const option of interiorTaskToggleOptions) if (task[option.key]) lines.push(option.instruction)
  for (const [key, options] of [['weather', interiorWeatherOptions], ['time', interiorTimeOptions], ['exterior', interiorExteriorOptions], ['filter', interiorFilterOptions]] as const) {
    const instruction = options.find((option) => option.value === task[key])?.instruction
    if (instruction) lines.push(instruction)
  }
  lines.push('以上选项通过文字指令表达，不是模型原生灯光、天气或本地像素滤镜参数。关闭或未指定的选项不要求删除原有场景内容。')
  if (supplement.trim()) lines.push('补充要求：', supplement)
  return lines.join('\n')
}

export function resolveInteriorImageRequest(value: InteriorTask, input: ImageRequestParametersInput): ImageRequestParametersInput {
  return { ...input, prompt: buildInteriorTaskPrompt(value, input.prompt) }
}

export function assertInteriorTaskConfiguration(task: InteriorTask | undefined, order: ImageReferenceOrder | undefined, commerceTask?: unknown): void {
  if (task === undefined) return
  parseInteriorTask(task)
  if (commerceTask !== undefined) throw new Error('室内创作与商品创作不能同时配置在同一节点')
  if (!order || order.slots.length !== 1 || order.slots[0].role !== 'source') throw new Error('室内渲染需要明确绑定唯一原图，请打开室内配置核对')
}
