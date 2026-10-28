import type { ImageLayerTextContent, ImageLayerTypography, ImageLayerTextWeight, ImageLayerTextWarpStyle } from './recipe'
import { defaultImageLayerTypography, parseImageLayerTypography } from './layer-text-layout'

export function parseLayerTextNumberDraft(value: string, min: number, max: number, step: number): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null
  const rounded = Number((Math.round(parsed / step) * step).toFixed(3))
  return rounded >= min && rounded <= max ? rounded : null
}

export function patchLayerTextTypography(content: ImageLayerTextContent, patch: Partial<ImageLayerTypography>): ImageLayerTextContent {
  const current = content.typography ?? defaultImageLayerTypography()
  const typography = parseImageLayerTypography({ ...current, ...patch })
  if (JSON.stringify(current) === JSON.stringify(typography)) return content
  return { ...content, typography }
}

export function setLayerTextWeight(content: ImageLayerTextContent, fontWeight: ImageLayerTextWeight): ImageLayerTextContent {
  if ((content.typography?.fontWeight ?? content.fontWeight) === fontWeight) return content
  if (!content.typography && (fontWeight === 400 || fontWeight === 700)) return { ...content, fontWeight }
  return patchLayerTextTypography(content, { fontWeight })
}

export function setLayerTextWarp(content: ImageLayerTextContent, style: ImageLayerTextWarpStyle | 'none'): ImageLayerTextContent {
  if (style === 'none') {
    if (!content.typography?.warp) return content
    const { warp: _warp, ...typography } = content.typography
    return { ...content, typography }
  }
  return patchLayerTextTypography(content, { warp: { style, bend: content.typography?.warp?.bend ?? 50 } })
}

export function setLayerTextGenericFont(content: ImageLayerTextContent, fontFamily: ImageLayerTextContent['fontFamily']): ImageLayerTextContent {
  if (!content.typography?.fontFamily) return content.fontFamily === fontFamily ? content : { ...content, fontFamily }
  const { fontFamily: _family, fontSource: _source, ...typography } = content.typography
  return { ...content, fontFamily, typography }
}

export function resetLayerTextTypography(content: ImageLayerTextContent): ImageLayerTextContent {
  if (!content.typography) return content
  const { typography: _typography, ...original } = content
  return original
}
