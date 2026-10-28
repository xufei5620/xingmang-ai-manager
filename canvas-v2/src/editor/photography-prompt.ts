export interface PhotographyDraft {
  camera: string
  lens: string
  aperture: string
  shutter: string
  iso: string
  angle: string
  lighting: string
  material: string
  focus: string
}

export const photographyFields: readonly { key: keyof PhotographyDraft; label: string; options: readonly string[] }[] = [
  { key: 'camera', label: '相机风格', options: ['全画幅摄影', '中画幅商业摄影', '胶片摄影', '电影摄影', '手机纪实'] },
  { key: 'lens', label: '焦距', options: ['14mm 超广角', '24mm 广角', '35mm 环境视角', '50mm 标准视角', '85mm 人像', '100mm 微距', '135mm 长焦'] },
  { key: 'aperture', label: '光圈', options: ['f/1.4', 'f/2.8', 'f/4', 'f/5.6', 'f/8', 'f/11', 'f/16'] },
  { key: 'shutter', label: '快门表现', options: ['1/1000 秒凝固动作', '1/250 秒清晰抓拍', '1/60 秒自然动态', '1/15 秒动态拖影', '长曝光光轨'] },
  { key: 'iso', label: '感光表现', options: ['ISO 100 细腻低噪点', 'ISO 400 自然质感', 'ISO 1600 颗粒感', 'ISO 3200 强颗粒'] },
  { key: 'angle', label: '拍摄角度', options: ['平视', '45 度俯拍', '正上方俯拍', '低机位仰拍', '侧面视角', '等距视角'] },
  { key: 'lighting', label: '灯光', options: ['柔和自然光', '影棚柔光箱', '侧逆光', '黄金时刻暖光', '电影感明暗对比', '均匀无影光', '霓虹夜景'] },
  { key: 'material', label: '材质重点', options: ['保留真实材质', '磨砂表面', '金属反射', '玻璃通透感', '织物纹理', '木质肌理', '陶瓷釉面'] },
  { key: 'focus', label: '焦点与景深', options: ['主体清晰，背景柔和虚化', '全景深，前后景清晰', '微距细节，浅景深', '前景虚化，焦点在主体', '焦点在画面中心'] },
]

export const photographyPresets: readonly { name: string; values: Partial<PhotographyDraft> }[] = [
  { name: '电商棚拍', values: { camera: '中画幅商业摄影', lens: '85mm 人像', aperture: 'f/8', iso: 'ISO 100 细腻低噪点', angle: '45 度俯拍', lighting: '影棚柔光箱', material: '保留真实材质', focus: '全景深，前后景清晰' } },
  { name: '自然生活', values: { camera: '全画幅摄影', lens: '35mm 环境视角', aperture: 'f/2.8', angle: '平视', lighting: '柔和自然光', focus: '主体清晰，背景柔和虚化' } },
  { name: '电影画面', values: { camera: '电影摄影', lens: '50mm 标准视角', aperture: 'f/1.4', shutter: '1/60 秒自然动态', lighting: '电影感明暗对比', focus: '主体清晰，背景柔和虚化' } },
  { name: '建筑空间', values: { camera: '全画幅摄影', lens: '24mm 广角', aperture: 'f/11', angle: '平视', lighting: '黄金时刻暖光', focus: '全景深，前后景清晰' } },
]

const startMarker = '【摄影设定】'
const endMarker = '【摄影设定结束】'
const blockPattern = /【摄影设定】\n([\s\S]*?)\n【摄影设定结束】/g

export function emptyPhotographyDraft(): PhotographyDraft {
  return { camera: '', lens: '', aperture: '', shutter: '', iso: '', angle: '', lighting: '', material: '', focus: '' }
}

export function photographyPromptBlock(draft: PhotographyDraft): string {
  const lines: string[] = []
  for (const field of photographyFields) {
    const value = draft[field.key]
    if (!value) continue
    if (!field.options.includes(value)) throw new Error(`请重新选择${field.label}`)
    lines.push(`${field.label}：${value}`)
  }
  return lines.length ? `${startMarker}\n${lines.join('\n')}\n${endMarker}` : ''
}

/** Only replace a complete block that this control could have authored. */
function photographyBlock(prompt: string): { start: number; text: string; draft: PhotographyDraft } | null {
  const blocks = [...prompt.matchAll(blockPattern)]
  if (blocks.length !== 1) return null
  const block = blocks[0]
  const draft = emptyPhotographyDraft()
  for (const line of block[1].split('\n')) {
    const field = photographyFields.find((entry) => line.startsWith(`${entry.label}：`))
    if (!field || draft[field.key]) return null
    const value = line.slice(field.label.length + 1)
    if (!field.options.includes(value)) return null
    draft[field.key] = value
  }
  return { start: block.index!, text: block[0], draft }
}

export function readPhotographyDraft(prompt: string): PhotographyDraft | null {
  return photographyBlock(prompt)?.draft ?? null
}

export function applyPhotographyPrompt(prompt: string, draft: PhotographyDraft, maximumLength = 10_000): string {
  const existing = photographyBlock(prompt)
  if (!existing && (prompt.includes(startMarker) || prompt.includes(endMarker))) throw new Error('摄影设定已被手动修改，请先整理提示词中的摄影设定，再应用。')
  const block = photographyPromptBlock(draft)
  let next: string
  if (existing) {
    const before = prompt.slice(0, existing.start)
    const after = prompt.slice(existing.start + existing.text.length)
    next = block ? `${before}${block}${after}` : `${before.replace(/\n{1,2}$/, '')}${after}`
  } else next = block ? `${prompt}${prompt ? '\n\n' : ''}${block}` : prompt
  if (next.length > maximumLength) throw new Error(`应用后超过 ${maximumLength} 字，请先缩短提示词。`)
  return next
}
