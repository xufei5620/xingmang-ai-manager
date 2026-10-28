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

export function imageCandidateCountNotice(count: ImageCandidateCount): string {
  return `最多发起 ${count} 次独立生成，按次计费；具体金额以所选服务为准`
}
