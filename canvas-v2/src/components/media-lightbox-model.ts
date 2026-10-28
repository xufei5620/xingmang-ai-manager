export interface PreviewDimensions {
  width: number
  height: number
}

export function mediaPreviewFitZoom(image: PreviewDimensions, viewport: PreviewDimensions): number {
  if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return 1
  return Math.min(1, viewport.width / image.width, viewport.height / image.height)
}

export function mediaPreviewStepZoom(current: number, direction: -1 | 1): number {
  return Math.min(4, Math.max(0.01, current * (direction > 0 ? 1.25 : 0.8)))
}

/** Return a wrap target only at the modal boundary; native Tab handles the rest. */
export function mediaPreviewFocusIndex(count: number, activeIndex: number, backwards: boolean): number | null {
  if (count === 0) return null
  if (activeIndex < 0) return backwards ? count - 1 : 0
  if (backwards && activeIndex === 0) return count - 1
  if (!backwards && activeIndex === count - 1) return 0
  return null
}
