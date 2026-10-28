import { defaultImageLayerColorDetail, type ImageLayerColorDetail } from './layer-color-detail'
import { defaultImageLayerColorPresence } from './layer-color-presence'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'
import { imageLayerHslChannels, parseImageLayerColorGrade, type ImageLayerColorGrade } from './layer-color-grade'
import { maximumColorGradeXmpBytes, parseColorGradeXmpXml, xmpNamespaces, type ColorGradeXmlElement } from './layer-color-grade-xmp-xml'

export { maximumColorGradeXmpBytes }
export interface ColorGradeXmpDifference { field: string; before: string; after: string }
export interface ColorGradeXmpWarning { field: string; value: string; message: string }
export interface ColorGradeXmpImport { settings: ImageLayerColorGrade; differences: ColorGradeXmpDifference[]; warnings: ColorGradeXmpWarning[]; mappedFields: string[] }
export interface ColorGradeXmpExport { text: string; warnings: ColorGradeXmpWarning[]; mappedFields: string[] }

const scalarFields = [
  ['Exposure2012', 'exposure', '曝光', -4, 4], ['Contrast2012', 'contrast', '对比度', -100, 100],
  ['Highlights2012', 'highlights', '高光', -100, 100], ['Shadows2012', 'shadows', '阴影', -100, 100],
  ['Whites2012', 'whites', '白色色阶', -100, 100], ['Blacks2012', 'blacks', '黑色色阶', -100, 100],
  ['Temperature', 'temperature', '色温', 2000, 10000], ['Tint', 'tint', '色调', -150, 150],
  ['Vibrance', 'vibrance', '自然饱和度', -100, 100], ['Saturation', 'saturation', '饱和度', -100, 100],
  ['PostCropVignetteAmount', 'vignette', '效果晕影', -100, 100], ['GrainAmount', 'grain', '颗粒', 0, 100],
] as const
const curveFields = [['ToneCurvePV2012', 'rgb', 'RGB 曲线'], ['ToneCurvePV2012Red', 'red', '红色曲线'], ['ToneCurvePV2012Green', 'green', '绿色曲线'], ['ToneCurvePV2012Blue', 'blue', '蓝色曲线']] as const
const hslFields = [['HueAdjustment', 'hue', '色相'], ['SaturationAdjustment', 'saturation', '饱和度'], ['LuminanceAdjustment', 'luminance', '明亮度']] as const
const colorLabels = ['红', '橙', '黄', '绿', '青', '蓝', '紫', '洋红']
const splitFields = [['SplitToningShadowHue', 'shadows', 'hue', '阴影色相', 360], ['SplitToningShadowSaturation', 'shadows', 'saturation', '阴影饱和度', 100], ['SplitToningHighlightHue', 'highlights', 'hue', '高光色相', 360], ['SplitToningHighlightSaturation', 'highlights', 'saturation', '高光饱和度', 100]] as const
interface DetailXmpField { field: string; label: string; min: number; max: number; integer: boolean; get(value: ImageLayerColorDetail): number; set(value: ImageLayerColorDetail, next: number): void }
// CRS names/types are also registered by ExifTool's author-maintained XMP.pm.
// Parameters exchange intent; the local spatial kernel is not Adobe's renderer.
const detailFields: readonly DetailXmpField[] = [
  { field: 'Sharpness', label: '锐化数量', min: 0, max: 150, integer: true, get: (v) => v.sharpening.amount, set: (v, n) => { v.sharpening.amount = n } },
  { field: 'SharpenRadius', label: '锐化半径', min: .5, max: 3, integer: false, get: (v) => v.sharpening.radius, set: (v, n) => { v.sharpening.radius = n } },
  { field: 'SharpenDetail', label: '锐化细节', min: 0, max: 100, integer: true, get: (v) => v.sharpening.detail, set: (v, n) => { v.sharpening.detail = n } },
  { field: 'SharpenEdgeMasking', label: '锐化蒙版', min: 0, max: 100, integer: true, get: (v) => v.sharpening.masking, set: (v, n) => { v.sharpening.masking = n } },
  { field: 'LuminanceSmoothing', label: '明亮度降噪', min: 0, max: 100, integer: true, get: (v) => v.luminance.amount, set: (v, n) => { v.luminance.amount = n } },
  { field: 'LuminanceNoiseReductionDetail', label: '明亮度细节', min: 0, max: 100, integer: true, get: (v) => v.luminance.detail, set: (v, n) => { v.luminance.detail = n } },
  { field: 'LuminanceNoiseReductionContrast', label: '明亮度对比度', min: 0, max: 100, integer: true, get: (v) => v.luminance.contrast, set: (v, n) => { v.luminance.contrast = n } },
  { field: 'ColorNoiseReduction', label: '颜色降噪', min: 0, max: 100, integer: true, get: (v) => v.color.amount, set: (v, n) => { v.color.amount = n } },
  { field: 'ColorNoiseReductionDetail', label: '颜色细节', min: 0, max: 100, integer: true, get: (v) => v.color.detail, set: (v, n) => { v.color.detail = n } },
  { field: 'ColorNoiseReductionSmoothness', label: '颜色平滑度', min: 0, max: 100, integer: true, get: (v) => v.color.smoothness, set: (v, n) => { v.color.smoothness = n } },
]
const detailWarning = '交换锐化、明亮度与颜色降噪的数值意图；本地算法、处理顺序与其他软件不同，不保证像素一致。'
const presenceFields = [['Texture', 'texture', '纹理'], ['Clarity2012', 'clarity', '清晰度'], ['Dehaze', 'dehaze', '去除薄雾']] as const
const presenceWarning = '只交换纹理、清晰度与去除薄雾的数值意图；本地算法与其他软件不同，不保证像素一致。'
// Six primary values were observed in an owned export. ShadowTint is a CRS
// integer defined by Adobe's XMPNamespaces/crs.md, not an observed export field.
const calibrationFields = [['ShadowTint', 'shadowTint', '阴影色调'], ['RedHue', 'redHue', '红原色色相'], ['RedSaturation', 'redSaturation', '红原色饱和度'], ['GreenHue', 'greenHue', '绿原色色相'], ['GreenSaturation', 'greenSaturation', '绿原色饱和度'], ['BlueHue', 'blueHue', '蓝原色色相'], ['BlueSaturation', 'blueSaturation', '蓝原色饱和度']] as const
const calibrationWarning = '只交换阴影色调与 RGB 原色校准的数值意图；本地使用独立算法，不模拟 Adobe 处理版本、相机配置文件或保证像素一致。'
const knownFields = new Set<string>([...scalarFields.map(([field]) => field), ...presenceFields.map(([field]) => field), ...calibrationFields.map(([field]) => field), ...detailFields.map(({ field }) => field), ...curveFields.map(([field]) => field), ...splitFields.map(([field]) => field), 'SplitToningBalance', 'ConvertToGrayscale', ...imageLayerHslChannels.flatMap((color) => hslFields.map(([prefix]) => `${prefix}${capitalize(color)}`))])
const whiteBalanceWarning = '按 Kelvin 数值交换；RAW 与 JPEG/TIFF 的白平衡标尺不同，本工具不转换相对色温，渲染效果也不等同 Camera Raw。'

function capitalize(value: string): string { return value[0].toUpperCase() + value.slice(1) }
function fail(message: string): never { throw new Error(`XMP ${message}；当前调整未改变`) }
function numeric(value: string, field: string, min: number, max: number): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) fail(`${field} 不是有效数值`)
  const result = Number(value)
  if (!Number.isFinite(result) || result < min || result > max) fail(`${field} 超出本地支持范围 ${min}–${max}，不会自动裁剪`)
  return result
}
function describe(value: unknown): string { return typeof value === 'boolean' ? value ? '开启' : '关闭' : typeof value === 'number' ? String(Number(value.toFixed(6))) : JSON.stringify(value) }
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
function warning(field: string, value: string, message: string): ColorGradeXmpWarning { return { field, value, message } }
function summary(element: ColorGradeXmlElement): string { return [element.text.trim(), ...element.attributes.map((entry) => `${entry.local}=${entry.value}`), ...element.children.map((child) => `${child.local}: ${summary(child)}`)].filter(Boolean).join(' · ') }

function readProperties(text: string): Map<string, string | ColorGradeXmlElement> {
  const root = parseColorGradeXmpXml(text)
  const rdf = root.uri === xmpNamespaces.x && root.local === 'xmpmeta' ? root.children : [root]
  if (root.attributes.some((entry) => !(entry.uri === xmpNamespaces.x && entry.local === 'xmptk')) || root.text.trim() || rdf.length !== 1 || rdf[0].uri !== xmpNamespaces.rdf || rdf[0].local !== 'RDF') fail('需要标准 xmpmeta / RDF 结构')
  const container = rdf[0]
  if (container.attributes.length || container.text.trim() || !container.children.length) fail('RDF 结构无效')
  const properties = new Map<string, string | ColorGradeXmlElement>()
  function add(uri: string, local: string, value: string | ColorGradeXmlElement) {
    if (uri !== xmpNamespaces.crs && knownFields.has(local)) fail(`${local} 使用了混淆的 Camera Raw 命名空间`)
    const key = uri === xmpNamespaces.crs ? local : `{${uri}}${local}`
    if (properties.has(key)) fail(`参数 ${local} 重复，不能判断应采用哪个值`)
    properties.set(key, value)
  }
  for (const description of container.children) {
    if (description.uri !== xmpNamespaces.rdf || description.local !== 'Description' || description.text.trim()) fail('仅支持 RDF Description 参数包')
    for (const attribute of description.attributes) {
      if (attribute.uri === xmpNamespaces.rdf && attribute.local === 'about' && attribute.value === '') continue
      add(attribute.uri, attribute.local, attribute.value)
    }
    for (const child of description.children) add(child.uri, child.local, child)
  }
  return properties
}

/** Import merges only explicit supported properties. No missing XMP value resets the draft. */
export function parseColorGradeXmp(text: string, current: ImageLayerColorGrade): ColorGradeXmpImport {
  const settings = parseImageLayerColorGrade(current), properties = readProperties(text), differences: ColorGradeXmpDifference[] = [], warnings: ColorGradeXmpWarning[] = [], mappedFields: string[] = []
  function difference(field: string, before: unknown, after: unknown) { if (JSON.stringify(before) !== JSON.stringify(after)) differences.push({ field, before: describe(before), after: describe(after) }) }
  function scalar(field: string): string | undefined {
    const raw = properties.get(field)
    if (raw === undefined) return undefined
    if (typeof raw === 'string') return raw
    if (raw.children.length || raw.attributes.length) fail(`${field} 需要单一参数值`)
    return raw.text.trim()
  }
  for (const [field, key, label, min, max] of scalarFields) {
    const raw = scalar(field)
    if (raw === undefined) continue
    const value = numeric(raw, field, min, max)
    difference(label, settings[key], value); settings[key] = value; mappedFields.push(field)
  }
  let importedPresence = false
  for (const [field, key, label] of presenceFields) {
    const raw = scalar(field)
    if (raw === undefined) continue
    const value = numeric(raw, field, -100, 100), presence = settings.presence ?? defaultImageLayerColorPresence()
    difference(label, presence[key], value); presence[key] = value; settings.presence = presence
    mappedFields.push(field); importedPresence = true
  }
  if (importedPresence) {
    warnings.push(warning('纹理、清晰度与去除薄雾', '', presenceWarning))
    warnings.push(warning('质感与去雾开关', settings.presence!.enabled ? '启用' : '停用', current.presence === undefined ? '原草稿没有质感与去雾配置；确认后将创建并启用，全部为 0 时不改变像素。XMP 不携带本工具的启用开关，完整状态请用 JSON 预设。' : 'XMP 仅更新提供的数值，当前质感与去雾开关与未提供的参数保持原样；完整状态请用 JSON 预设。'))
  }
  let importedCalibration = false
  for (const [field, key, label] of calibrationFields) {
    const raw = scalar(field)
    if (raw === undefined) continue
    const value = numeric(raw, field, -100, 100)
    if (!Number.isInteger(value)) fail(`${field} 需要整数，不能无损映射；当前参数未改变`)
    const calibration = settings.calibration ?? defaultImageLayerColorCalibration()
    difference(label, calibration[key], value); calibration[key] = value; settings.calibration = calibration
    mappedFields.push(field); importedCalibration = true
  }
  if (importedCalibration) {
    warnings.push(warning('校准', '', calibrationWarning))
    warnings.push(warning('校准开关', settings.calibration!.enabled ? '启用' : '停用', current.calibration === undefined ? '原草稿没有校准配置；确认后将创建并启用，全部为 0 时不改变像素。XMP 不携带本工具的校准启用开关，完整状态请用 JSON 预设。' : 'XMP 仅更新提供的数值，当前校准开关与未提供的参数保持原样；完整状态请用 JSON 预设。'))
  }
  let importedDetail = false
  for (const mapping of detailFields) {
    const raw = scalar(mapping.field)
    if (raw === undefined) continue
    const value = numeric(raw, mapping.field, mapping.min, mapping.max)
    if (mapping.integer && !Number.isInteger(value)) fail(`${mapping.field} 需要整数，不能无损映射；当前参数未改变`)
    const detail = settings.detail ?? defaultImageLayerColorDetail()
    difference(mapping.label, mapping.get(detail), value); mapping.set(detail, value); settings.detail = detail
    mappedFields.push(mapping.field); importedDetail = true
  }
  if (importedDetail) {
    warnings.push(warning('细节与降噪', '', detailWarning))
    warnings.push(warning('细节开关', settings.detail!.enabled ? '启用' : '停用', current.detail === undefined ? '原草稿没有细节配置；确认后将创建并启用本地细节与降噪，数量为 0 的组不改变像素。XMP 不携带本工具的分节启用开关，完整状态请用 JSON 预设。' : 'XMP 仅更新提供的数值，当前细节开关与未提供的参数保持原样；完整开关和潜伏参数请用 JSON 预设。'))
  }
  const blackWhite = scalar('ConvertToGrayscale')
  if (blackWhite !== undefined) {
    if (!['True', 'False', 'true', 'false', '1', '0'].includes(blackWhite)) fail('ConvertToGrayscale 需要布尔值')
    const value = blackWhite === 'True' || blackWhite === 'true' || blackWhite === '1'
    difference('黑白', settings.blackWhite, value); settings.blackWhite = value; mappedFields.push('ConvertToGrayscale')
  }
  for (const [at, channel] of imageLayerHslChannels.entries()) for (const [prefix, key, label] of hslFields) {
    const field = `${prefix}${capitalize(channel)}`, raw = scalar(field)
    if (raw === undefined) continue
    const value = numeric(raw, field, -100, 100)
    difference(`${colorLabels[at]}色${label}`, settings.hsl[channel][key], value); settings.hsl[channel][key] = value; mappedFields.push(field)
  }
  for (const [field, channel, label] of curveFields) {
    const raw = properties.get(field)
    if (raw === undefined) continue
    if (typeof raw === 'string' || raw.attributes.length || raw.text.trim() || raw.children.length !== 1) fail(`${field} 需要 RDF Seq 控制点`)
    const sequence = raw.children[0]
    if (sequence.uri !== xmpNamespaces.rdf || sequence.local !== 'Seq' || sequence.attributes.length || sequence.text.trim() || sequence.children.length < 2 || sequence.children.length > 16) fail(`${field} 本地仅支持 2–16 个点，不会丢弃多余控制点`)
    const points = sequence.children.map((entry) => {
      if (entry.uri !== xmpNamespaces.rdf || entry.local !== 'li' || entry.attributes.length || entry.children.length) fail(`${field} 控制点格式无效`)
      const parts = entry.text.trim().split(',')
      if (parts.length !== 2) fail(`${field} 控制点需要输入、输出两个坐标`)
      return { x: numeric(parts[0], field, 0, 255) / 255, y: numeric(parts[1], field, 0, 255) / 255 }
    })
    if (points[0].x !== 0 || points.at(-1)!.x !== 1 || points.some((point, at) => at > 0 && point.x <= points[at - 1].x)) fail(`${field} 需要严格递增横坐标和 0、255 端点`)
    difference(label, settings.curves[channel], points); settings.curves[channel] = points; mappedFields.push(field)
  }
  for (const [field, tone, key, label, max] of splitFields) {
    const raw = scalar(field)
    if (raw === undefined) continue
    const value = numeric(raw, field, 0, max)
    difference(label, settings.colorGrading[tone][key], value); settings.colorGrading[tone][key] = value; mappedFields.push(field)
  }
  const balance = scalar('SplitToningBalance')
  if (balance !== undefined) { const value = numeric(balance, 'SplitToningBalance', -100, 100); difference('分级平衡', settings.colorGrading.balance, value); settings.colorGrading.balance = value; mappedFields.push('SplitToningBalance') }
  for (const [field, raw] of properties) if (!knownFields.has(field)) {
    const value = typeof raw === 'string' ? raw : summary(raw)
    if (/^[+-]?(?:nan|infinity)$/i.test(value.trim())) fail(`${field} 含非有限数值`)
    warnings.push(warning(field, value, '不支持此字段，确认后也不会应用；现有对应调整保持原样。'))
  }
  if (!mappedFields.length) fail('没有本工具可映射的 Camera Raw 调整参数')
  if (properties.has('Temperature') || properties.has('Tint')) warnings.push(warning('白平衡', '', whiteBalanceWarning))
  if (mappedFields.some((field) => field.startsWith('SplitToning'))) warnings.push(warning('分离色调', '', '只应用阴影/高光色相、饱和度和平衡；本地中间调、亮度、混合保持原样，与旧版 Split Toning 的混合方式不等价。'))
  if (properties.has('GrainAmount') || properties.has('PostCropVignetteAmount')) warnings.push(warning('效果', '', '仅交换颗粒/效果晕影强度意图；颗粒尺寸、粗糙度、晕影样式等不在本地参数范围，算法不等同 Adobe。'))
  if (settings.blackWhite && (['shadows', 'midtones', 'highlights'] as const).some((key) => settings.colorGrading[key].saturation > 0)) warnings.push(warning('黑白与分级', '', '本工具在分级后转为黑白，会去掉分级色彩；与 Adobe 黑白着色顺序不同。'))
  if (settings.lut !== undefined) warnings.push(warning('LUT 调色', settings.lut.source.kind === 'asset' ? settings.lut.source.name : '原创内置预设', '本次 XMP 参数导入不包含 LUT，当前 LUT、开关与强度均保留。交换完整 LUT 请使用带资源的 JSON 调整预设。'))
  return { settings: parseImageLayerColorGrade(settings), differences, warnings, mappedFields }
}

/** Standard CRS properties only; unsupported local settings are reported before download. */
export function serializeColorGradeXmp(name: string, value: ImageLayerColorGrade): ColorGradeXmpExport {
  const settings = parseImageLayerColorGrade(value), title = name.trim(), warnings: ColorGradeXmpWarning[] = [], mappedFields: string[] = [], attributes: string[] = []
  if (!title || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title)) fail('预设名称需要 1–80 个有效字符')
  function attribute(field: string, value: number | boolean) { attributes.push(`   crs:${field}="${typeof value === 'boolean' ? value ? 'True' : 'False' : value}"`); mappedFields.push(field) }
  for (const [field, key] of scalarFields) attribute(field, settings[key])
  if (settings.presence) {
    for (const [field, key] of presenceFields) attribute(field, settings.presence[key])
    warnings.push(warning('纹理、清晰度与去除薄雾', '', presenceWarning))
    warnings.push(warning('质感与去雾开关', settings.presence.enabled ? '启用' : '停用', settings.presence.enabled ? 'XMP 不携带本工具的质感与去雾启用开关；完整参数与开关请另外保存 JSON 预设。' : '当前质感与去雾已停用，但 XMP 会导出保留的全部数值，不携带停用开关；在其他软件导入可能启用效果。保留完整停用状态请保存 JSON 预设。'))
  }
  if (settings.calibration) {
    for (const [field, key] of calibrationFields) {
      if (!Number.isInteger(settings.calibration[key])) fail(`${field} 只能导出整数；为保留完整精度请保存 JSON 预设`)
      attribute(field, settings.calibration[key])
    }
    warnings.push(warning('校准', '', calibrationWarning))
    warnings.push(warning('校准开关', settings.calibration.enabled ? '启用' : '停用', settings.calibration.enabled ? 'XMP 不携带本工具的校准启用开关；完整参数与开关请另外保存 JSON 预设。' : '当前校准已停用，但 XMP 会导出保留的全部数值，不携带停用开关；在其他软件导入可能启用效果。保留完整停用状态请保存 JSON 预设。'))
  }
  if (settings.detail) {
    for (const mapping of detailFields) {
      const value = mapping.get(settings.detail)
      if (mapping.integer && !Number.isInteger(value)) fail(`${mapping.field} 只能导出整数；为保留完整精度请保存 JSON 预设`)
      attribute(mapping.field, value)
    }
    warnings.push(warning('细节与降噪', '', detailWarning))
    warnings.push(warning('细节开关', settings.detail.enabled ? '启用' : '停用', settings.detail.enabled ? 'XMP 不携带本工具的细节启用开关；导入时使用目标软件的开关状态。完整参数与开关请另外保存 JSON 预设。' : '当前细节已停用，但 XMP 会导出保留的全部数值，不携带停用开关；在其他软件导入可能启用效果。保留完整停用状态请保存 JSON 预设。'))
  }
  attribute('ConvertToGrayscale', settings.blackWhite)
  for (const channel of imageLayerHslChannels) for (const [prefix, key] of hslFields) attribute(`${prefix}${capitalize(channel)}`, settings.hsl[channel][key])
  for (const [field, tone, key] of splitFields) attribute(field, settings.colorGrading[tone][key])
  attribute('SplitToningBalance', settings.colorGrading.balance)
  const curves = curveFields.map(([field, channel, label]) => {
    const points = settings.curves[channel].map((point) => ({ x: Math.round(point.x * 255), y: Math.round(point.y * 255) }))
    if (points.some((point, at) => at > 0 && point.x <= points[at - 1].x)) fail(`${label} 转为 0–255 整数坐标后会重合，请拉开曲线点或使用 JSON 保存完整精度`)
    if (settings.curves[channel].some((point, at) => Math.abs(point.x * 255 - points[at].x) > 1e-8 || Math.abs(point.y * 255 - points[at].y) > 1e-8)) warnings.push(warning(field, '', '曲线坐标将四舍五入到 0–255 整数，可能有细微精度变化；JSON 可保存原精度。'))
    mappedFields.push(field)
    return `   <crs:${field}><rdf:Seq>${points.map((point) => `<rdf:li>${point.x}, ${point.y}</rdf:li>`).join('')}</rdf:Seq></crs:${field}>`
  })
  warnings.push(warning('白平衡', '', whiteBalanceWarning))
  warnings.push(warning('分级参数', `中间调 ${describe(settings.colorGrading.midtones)}；阴影亮度 ${settings.colorGrading.shadows.luminance}；高光亮度 ${settings.colorGrading.highlights.luminance}；混合 ${settings.colorGrading.blending}`, 'XMP 仅导出已确认的旧分离色调五字段；中间调、三路亮度和混合不写入。完整设置请另外保存 JSON。'))
  warnings.push(warning('颗粒与晕影', '', '只导出强度，不包含 Adobe 的尺寸、粗糙度、晕影样式；渲染不保证像素一致。'))
  if (settings.blackWhite && [settings.colorGrading.shadows, settings.colorGrading.midtones, settings.colorGrading.highlights].some((tone) => tone.saturation)) warnings.push(warning('黑白与分级', '', '本工具先分级后黑白，与 Adobe 黑白着色顺序不同。'))
  if (settings.lut !== undefined) warnings.push(warning('LUT 调色', settings.lut.source.kind === 'asset' ? settings.lut.source.name : '原创内置预设', '本工具的 XMP 参数交换不携带 LUT、开关或强度，不会写入伪造的 Adobe LUT 字段。请另外保存完整 JSON 调整预设以携带调色表。'))
  const text = `<?xml version="1.0" encoding="UTF-8"?>\n<x:xmpmeta xmlns:x="${xmpNamespaces.x}">\n <rdf:RDF xmlns:rdf="${xmpNamespaces.rdf}">\n  <rdf:Description rdf:about="" xmlns:crs="${xmpNamespaces.crs}" xmlns:dc="http://purl.org/dc/elements/1.1/"\n${attributes.join('\n')}>\n   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title)}</rdf:li></rdf:Alt></dc:title>\n${curves.join('\n')}\n  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n`
  if (new TextEncoder().encode(text).length > maximumColorGradeXmpBytes) fail('导出文件超过 64 KiB')
  parseColorGradeXmpXml(text)
  return { text, warnings, mappedFields }
}
