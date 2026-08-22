export function composeShotFramePrompt(input: {
  action: string
  framing?: string
  camera?: string
}): string {
  const framing = input.framing?.trim() || '中景'
  const camera = input.camera?.trim() || '固定'
  const action = input.action.trim() || '角色停留在画面中'
  return [
    '单张剧情关键帧，不是设定图。',
    `景别：${framing}。运镜感觉：${camera}。`,
    `画面里谁在哪做什么：${action}。`,
    '身份与服装只以参考图为准，prompt 不重写五官。',
    '与项目风格一致。不生成字幕、片名、水印。',
  ].join('\n')
}
