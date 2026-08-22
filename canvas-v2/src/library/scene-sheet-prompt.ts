export function composeSceneSheetPrompt(input: {
  environment: string
  tone?: string
  style?: string
}): string {
  const environment = input.environment.trim()
  const tone = input.tone?.trim()
  const style = input.style?.trim()
  return [
    '场景底板，纯环境无人。锁建筑结构、陈设位置、色调和光源方向。',
    '不要出现可辨认人脸、字幕或水印。柔和均匀或与基调匹配的光线。',
    environment,
    ...(tone ? [tone] : []),
    ...(style ? [style] : []),
  ].join('\n\n')
}
