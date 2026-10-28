/** Undefined preserves the provider default; false is an explicit silent-video request. */
export function parseVideoGenerateAudio(value: unknown, kind: string): boolean | undefined {
  if (value === undefined) return undefined
  if (kind !== 'video' && kind !== 'video-generate') throw new Error('只有视频生成节点支持生成音频设置')
  if (typeof value !== 'boolean') throw new Error('生成音频设置必须为开启或关闭')
  return value
}
