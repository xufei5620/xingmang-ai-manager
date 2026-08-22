export function composePropSheetPrompt(input: {
  morphology: string
  countLock?: string
  style?: string
}): string {
  const morphology = input.morphology.trim()
  const countLock = input.countLock?.trim()
  const style = input.style?.trim()
  return [
    '单体道具设定图，灰底或纯色背景，居中展示完整形态命门。',
    '不要出现人物、手、字幕或水印。',
    morphology,
    ...(countLock ? [`数量锁：${countLock}。`] : []),
    ...(style ? [style] : []),
  ].join('\n\n')
}
