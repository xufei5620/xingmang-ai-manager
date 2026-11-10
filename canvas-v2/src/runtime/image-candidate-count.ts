export type ImageCandidateCount = 1 | 2 | 3 | 4

export const imageCandidateCounts: readonly ImageCandidateCount[] = [1, 2, 3, 4]

export function supportsImageCandidateCount(kind: string): boolean {
  return kind === 'image' || kind === 'image-generate' || kind === 'image-edit'
}

/** Application-level independent requests; this never changes upstream n. */
export function parseImageCandidateCount(value: unknown, kind: string): ImageCandidateCount | undefined {
  if (value === undefined) return undefined
  if (!supportsImageCandidateCount(kind)) throw new Error('此节点不支持图像生成数量')
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) throw new Error('图像生成数量必须为 1 到 4 的整数')
  return value as ImageCandidateCount
}

/** Plain-language billing note: each candidate is its own paid request, so a batch of N costs N single images. */
export function imageCandidateCountNotice(count: ImageCandidateCount): string {
  return count > 1 ? `一次出 ${count} 张挑着用，每张单独扣一次费` : '想一次多出几张挑着用，选 ×2～×4，每张单独扣一次费'
}
