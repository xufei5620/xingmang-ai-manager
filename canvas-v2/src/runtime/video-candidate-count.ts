export type VideoCandidateCount = 1 | 2 | 3 | 4

export const videoCandidateCounts: readonly VideoCandidateCount[] = [1, 2, 3, 4]

export function supportsVideoCandidateCount(kind: string): boolean {
  return kind === 'video' || kind === 'video-generate'
}

/** Independent durable video tasks; no upstream batch/count parameter. */
export function parseVideoCandidateCount(value: unknown, kind: string): VideoCandidateCount | undefined {
  if (value === undefined) return undefined
  if (!supportsVideoCandidateCount(kind)) throw new Error('此节点不支持视频生成数量')
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) throw new Error('视频生成数量必须为 1 到 4 的整数')
  return value as VideoCandidateCount
}

export function videoCandidateCountNotice(count: VideoCandidateCount): string {
  return `最多依次提交 ${count} 个独立视频任务，按次计费；具体金额以所选服务为准`
}
