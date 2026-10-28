import type { ColorLutTable, ColorLutWorkOptions } from './layer-color-lut'

export interface LayerColorLutPreset {
  readonly id: string
  readonly version: 1
  readonly name: string
  readonly description: string
}

type PresetKind = 'movie-tone' | 'retro-film' | 'soft-film' | 'contrast-film' | 'cream-tone' | 'cool-tone' | 'japanese-fresh' | 'soft-forest' | 'clear-texture' | 'enhanced-contrast' | 'brightness-contrast' | 'distinct-tones' | 'exposure-up' | 'exposure-down' | 'high-saturation' | 'vivid-colors' | 'soft-colors' | 'low-saturation'
interface PresetDefinition extends LayerColorLutPreset { readonly kind: PresetKind }
type Color = [number, number, number]

// These are original encoded-RGB looks, not copies of another application's
// LUTs. Version 1 fixes the formulas as well as their stable catalogue IDs.
const definitions: readonly PresetDefinition[] = [
  { id: 'xm-lut-movie-tone-v1', version: 1, kind: 'movie-tone', name: '电影色调', description: '轻微压缩色彩，冷调暗部与暖调亮部形成层次。' },
  { id: 'xm-lut-retro-film-v1', version: 1, kind: 'retro-film', name: '复古胶片', description: '抬起黑位、收敛蓝色亮部，形成温和褪色倾向。' },
  { id: 'xm-lut-soft-film-v1', version: 1, kind: 'soft-film', name: '柔和胶片', description: '压缩明暗范围，柔化色彩并略微保留暖色暗部。' },
  { id: 'xm-lut-contrast-film-v1', version: 1, kind: 'contrast-film', name: '对比胶片', description: '加强明暗和色彩对比，保留少量冷暗暖亮倾向。' },
  { id: 'xm-lut-cream-tone-v1', version: 1, kind: 'cream-tone', name: '奶油色调', description: '柔和低对比与暖色亮部，减少鲜艳色彩的冲突。' },
  { id: 'xm-lut-cool-tone-v1', version: 1, kind: 'cool-tone', name: '清冷色调', description: '收敛红色并提起蓝色，营造清冷的色彩方向。' },
  { id: 'xm-lut-japanese-fresh-v1', version: 1, kind: 'japanese-fresh', name: '日式清新', description: '轻亮中间调，柔化饱和度并略偏青绿。' },
  { id: 'xm-lut-soft-forest-v1', version: 1, kind: 'soft-forest', name: '柔和森系', description: '低饱和柔和底色，单独强化偏绿颜色的层次。' },
  { id: 'xm-lut-clear-texture-v1', version: 1, kind: 'clear-texture', name: '通透质感', description: '微调中间调对比与色彩，不进行空间锐化或增加细节。' },
  { id: 'xm-lut-enhanced-contrast-v1', version: 1, kind: 'enhanced-contrast', name: '增强对比', description: '围绕中灰拉开明暗，保持中性灰的颜色关系。' },
  { id: 'xm-lut-brightness-contrast-v1', version: 1, kind: 'brightness-contrast', name: '亮度对比度', description: '小幅提亮并增加对比，适合继续手动调整。' },
  { id: 'xm-lut-distinct-tones-v1', version: 1, kind: 'distinct-tones', name: '泾渭分明', description: '连续曲线拉开亮暗区域，并增强色彩区分。' },
  { id: 'xm-lut-exposure-up-v1', version: 1, kind: 'exposure-up', name: '曝光加强', description: '提高中间调亮度并保留白色端点，不代表相机曝光档位。' },
  { id: 'xm-lut-exposure-down-v1', version: 1, kind: 'exposure-down', name: '曝光压制', description: '降低中间调亮度并保留黑白端点，不代表相机曝光档位。' },
  { id: 'xm-lut-high-saturation-v1', version: 1, kind: 'high-saturation', name: '高饱和', description: '以亮度为中心扩展色彩，保持中性灰。' },
  { id: 'xm-lut-vivid-colors-v1', version: 1, kind: 'vivid-colors', name: '鲜艳色彩', description: '优先加强原本较柔和的颜色，再轻微拉开对比。' },
  { id: 'xm-lut-soft-colors-v1', version: 1, kind: 'soft-colors', name: '柔和色彩', description: '降低饱和度、轻抬暗部并收敛明暗跨度。' },
  { id: 'xm-lut-low-saturation-v1', version: 1, kind: 'low-saturation', name: '低饱和', description: '明显减少色彩强度，保留亮度与少量原色。' },
]

/** Metadata only: opening a menu must not allocate eighteen 431244-byte tables. */
export const layerColorLutPresets: readonly LayerColorLutPreset[] = Object.freeze(definitions.map((entry) => Object.freeze({ id: entry.id, version: entry.version, name: entry.name, description: entry.description })))

function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
function luminance(color: Color): number { return color[0] * .2126 + color[1] * .7152 + color[2] * .0722 }
function saturation(color: Color, amount: number): Color {
  const gray = luminance(color)
  return [gray + (color[0] - gray) * amount, gray + (color[1] - gray) * amount, gray + (color[2] - gray) * amount]
}
function contrast(value: number, amount: number): number { return .5 + (value - .5) * amount }
function gentleCurve(value: number): number { return value + .12 * (value - .5) * 4 * value * (1 - value) }

function transform(kind: PresetKind, red: number, green: number, blue: number): Color {
  const color: Color = [red, green, blue], light = luminance(color)
  switch (kind) {
    case 'movie-tone': {
      const base = saturation(color, .94), shadow = (1 - light) ** 2, highlight = light ** 2
      return [contrast(base[0], 1.08) + .045 * highlight - .02 * shadow, contrast(base[1], 1.08) + .015 * highlight + .005 * shadow, contrast(base[2], 1.08) - .025 * highlight + .04 * shadow]
    }
    case 'retro-film': {
      const base = saturation(color, .82)
      return [.06 + .9 * clamp(base[0]) ** .96, .045 + .89 * clamp(base[1]) ** 1.02, .07 + .79 * clamp(base[2]) ** 1.1]
    }
    case 'soft-film': {
      const base = saturation(color, .9)
      return [.04 + .92 * base[0] + .012 * (1 - light), .04 + .92 * base[1], .04 + .92 * base[2] - .012 * light]
    }
    case 'contrast-film': {
      const base = saturation(color, 1.08)
      return [contrast(base[0], 1.28) + .025 * light, contrast(base[1], 1.28), contrast(base[2], 1.28) + .02 * (1 - light)]
    }
    case 'cream-tone': {
      const base = saturation(color, .82)
      return [(.06 + .92 * clamp(base[0]) ** .96) * 1.02, (.06 + .92 * clamp(base[1]) ** .96) * 1.01, (.06 + .92 * clamp(base[2]) ** .96) * .94]
    }
    case 'cool-tone': {
      const base = saturation(color, .9)
      return [contrast(base[0], 1.02) * .92, contrast(base[1], 1.02) * 1.01, contrast(base[2], 1.02) * 1.05 + .015 * (1 - light)]
    }
    case 'japanese-fresh': {
      const base = saturation(color, .85)
      return [contrast(base[0], .93) + .04 * (1 - base[0]), contrast(base[1], .93) + .04 * (1 - base[1]) + .02, contrast(base[2], .93) + .04 * (1 - base[2]) + .01]
    }
    case 'soft-forest': {
      const base = saturation(color, .78), foliage = Math.max(0, green - (red + blue) / 2)
      return [.025 + .94 * base[0] - .02 * foliage, .025 + .94 * base[1] + .02 * (1 - light) + .03 * foliage, .025 + .94 * base[2] - .02 * light]
    }
    case 'clear-texture': {
      const base = saturation(color, 1.05)
      return [gentleCurve(clamp(base[0])), gentleCurve(clamp(base[1])), gentleCurve(clamp(base[2]))]
    }
    case 'enhanced-contrast': return [contrast(red, 1.25), contrast(green, 1.25), contrast(blue, 1.25)]
    case 'brightness-contrast': return [contrast(red, 1.08) + .04, contrast(green, 1.08) + .04, contrast(blue, 1.08) + .04]
    case 'distinct-tones': {
      const base = saturation(color, 1.16).map(clamp)
      return [base[0] ** 2 * (3 - 2 * base[0]), base[1] ** 2 * (3 - 2 * base[1]), base[2] ** 2 * (3 - 2 * base[2])]
    }
    case 'exposure-up': return [1 - (1 - red) ** 1.2, 1 - (1 - green) ** 1.2, 1 - (1 - blue) ** 1.2]
    case 'exposure-down': return [red ** 1.2, green ** 1.2, blue ** 1.2]
    case 'high-saturation': return saturation(color, 1.45)
    case 'vivid-colors': {
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue), base = saturation(color, 1.15 + .18 * (1 - chroma))
      return [contrast(clamp(base[0]) ** .98, 1.08), contrast(clamp(base[1]) ** .98, 1.08), contrast(clamp(base[2]) ** .98, 1.08)]
    }
    case 'soft-colors': {
      const base = saturation(color, .72)
      return [.025 + .94 * base[0], .025 + .94 * base[1], .025 + .94 * base[2]]
    }
    case 'low-saturation': return saturation(color, .35)
  }
}

function checkWork(options: ColorLutWorkOptions): void {
  if (options.signal?.aborted) { const error = new Error('已取消内置 LUT 创建，原调整保留'); error.name = 'AbortError'; throw error }
  if (options.deadline !== undefined && Date.now() >= options.deadline) throw new Error('内置 LUT 创建超时，请重试')
}

/** Fresh, bounded F32 RGB samples. Red changes fastest, then green, then blue. */
export function createLayerColorLutPreset(id: string, options: ColorLutWorkOptions = {}): ColorLutTable {
  const preset = definitions.find((entry) => entry.id === id)
  if (!preset) throw new Error('内置 LUT 预设不存在或版本不受支持，请重新选择')
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline < 0)) throw new Error('内置 LUT 创建时间限制无效')
  checkWork(options)
  const size = 33, data = new Float32Array(size ** 3 * 3)
  for (let blue = 0; blue < size; blue++) for (let green = 0; green < size; green++) {
    checkWork(options)
    for (let red = 0; red < size; red++) {
      const color = transform(preset.kind, red / 32, green / 32, blue / 32), offset = (red + size * (green + size * blue)) * 3
      data[offset] = clamp(color[0]); data[offset + 1] = clamp(color[1]); data[offset + 2] = clamp(color[2])
    }
  }
  checkWork(options)
  return { version: 1, size: 33, domainMin: [0, 0, 0], domainMax: [1, 1, 1], data, name: preset.name }
}
