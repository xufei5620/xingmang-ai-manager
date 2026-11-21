import { ChevronDown } from 'lucide-react'
import type { ImageModelCapability } from '../../../../electron/ai-chat-protocol'
import { Button, ChoiceMenu, Input } from '../../ui'
import type { ImageOptionValues } from './image-settings'
import type { ChatSettings } from './state'
// 宽高那两格的样子在 chat.css 里；视频工作台的出图框单独摆着时（没有对话页）也要带上它。
import './chat.css'

export const imageQualityNames: Record<ChatSettings['quality'], string> = { low: '低', medium: '中', high: '高', auto: '自动' }

const commonImageSizes = ['1024x1024', '1536x1024', '1024x1536']

/** 尺寸菜单里列哪几个：只能挑的型号列它自己那几个；按倍数算的型号列三个常用的和手上这个，不合它规矩的不列。 */
export function imageSizeChoices(capability: ImageModelCapability, current: string): string[] {
  const policy = capability.sizePolicy
  if (policy.kind === 'allow-list') return [...policy.values]
  return [...new Set([...commonImageSizes, current])].filter((size) => size.split('x').every((part) => Number(part) >= policy.min && Number(part) <= policy.max && Number(part) % policy.divisor === 0))
}

export function imageSizeLabel(size: string): string {
  return size === 'auto' ? '自动尺寸' : size.replace('x', ' × ')
}

/**
 * 出图的那一排：尺寸、画质、分辨率，按倍数算尺寸的型号多一个「自定义尺寸」和宽高两格。对话里「生成图片」那一档和
 * 视频工作台「AI 生成图片」的出图框用的是这同一排（融合第 4 步），两边选项一样、字一样。testIdPrefix 分开两边的
 * 测试标记：对话里是 chat-image（老标记照留）。
 */
export function ImageOptionMenus({ capability, values, customSize, onCustomSize, onChange, onLeaveCustomSize, sizeRuleId, testIdPrefix }: {
  capability: ImageModelCapability
  values: ImageOptionValues
  /** 正在手填宽高。 */
  customSize: boolean
  onCustomSize(custom: boolean): void
  onChange(patch: Partial<ImageOptionValues>): void
  /** 焦点离开宽高两格：这时候才说填得不合规矩。 */
  onLeaveCustomSize?: () => void
  /** 那句规矩正露着时它的 id，给读屏软件连上。 */
  sizeRuleId?: string
  testIdPrefix: string
}) {
  const policy = capability.sizePolicy
  const [width = '', height = ''] = values.size.split('x')
  return <>
    <ChoiceMenu label="尺寸" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="尺寸" data-value={customSize ? 'custom' : values.size} testId={`${testIdPrefix}-size`}>{customSize ? '自定义尺寸' : imageSizeLabel(values.size)}</Button>} sections={[{ label: '尺寸', value: customSize ? 'custom' : values.size, options: [...imageSizeChoices(capability, values.size).map((size) => ({ value: size, label: imageSizeLabel(size) })), ...(policy.kind === 'divisible' ? [{ value: 'custom', label: '自定义尺寸' }] : [])], onChange: (value) => { onCustomSize(value === 'custom'); if (value !== 'custom') onChange({ size: value }) } }]} />
    {capability.qualities.length > 0 && <ChoiceMenu label="画质" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="画质" data-value={values.quality} testId={`${testIdPrefix}-quality`}>画质：{imageQualityNames[values.quality]}</Button>} sections={[{ label: '画质', value: values.quality, options: capability.qualities.map((quality) => ({ value: quality, label: imageQualityNames[quality] })), onChange: (value) => { const quality = capability.qualities.find((item) => item === value); if (quality) onChange({ quality }) } }]} />}
    {capability.resolutions.length > 1 && <ChoiceMenu label="分辨率" align="start" anchor={<Button variant="ghost" size="sm" iconRight={ChevronDown} title="分辨率" data-value={values.imageResolution} testId={`${testIdPrefix}-resolution`}>分辨率：{values.imageResolution}</Button>} sections={[{ label: '分辨率', value: values.imageResolution, options: capability.resolutions.map((resolution) => ({ value: resolution, label: resolution })), onChange: (value) => { const imageResolution = capability.resolutions.find((item) => item === value); if (imageResolution) onChange({ imageResolution }) } }]} />}
    {customSize && policy.kind === 'divisible' && <span className="chat-image-custom" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onLeaveCustomSize?.() }}><Input type="number" aria-label="图片宽度" min={policy.min} max={policy.max} step={policy.divisor} value={width} onChange={(event) => onChange({ size: `${event.target.value}x${height}` })} aria-describedby={sizeRuleId} testId={`${testIdPrefix}-width`} /><span>×</span><Input type="number" aria-label="图片高度" min={policy.min} max={policy.max} step={policy.divisor} value={height} onChange={(event) => onChange({ size: `${width}x${event.target.value}` })} aria-describedby={sizeRuleId} testId={`${testIdPrefix}-height`} /></span>}
  </>
}
