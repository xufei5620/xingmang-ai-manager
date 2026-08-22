import {
  maximumDramaCharacters,
  maximumDramaIdLength,
  maximumDramaNameLength,
  maximumDramaProps,
  maximumDramaScenes,
  maximumDramaShots,
  maximumDramaTextLength,
  type DramaParseCharacter,
  type DramaParseProp,
  type DramaParseScene,
  type DramaParseShot,
  type DramaParseTables,
} from './drama-model'

export interface DramaParseResult {
  tables: DramaParseTables
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stripControls(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, '').trim()
}

function boundedString(value: unknown, maximum: number): { text: string; truncated: boolean } | null {
  if (typeof value !== 'string') return null
  const text = stripControls(value)
  if (!text) return { text: '', truncated: false }
  if (text.length <= maximum) return { text, truncated: false }
  return { text: text.slice(0, maximum), truncated: true }
}

function requiredId(value: unknown, label: string): string {
  const parsed = boundedString(value, maximumDramaIdLength)
  if (!parsed || !parsed.text) throw new Error(`${label}缺少有效标识`)
  if (parsed.truncated) throw new Error(`${label}标识超出 ${maximumDramaIdLength} 字`)
  return parsed.text
}

function optionalText(value: unknown, maximum = maximumDramaTextLength): { text?: string; truncated: boolean } {
  if (value === undefined || value === null || value === '') return { truncated: false }
  const parsed = boundedString(value, maximum)
  if (!parsed) return { truncated: false }
  return parsed.text ? { text: parsed.text, truncated: parsed.truncated } : { truncated: parsed.truncated }
}

function requiredText(value: unknown, label: string, maximum = maximumDramaTextLength): { text: string; truncated: boolean } {
  const parsed = boundedString(value, maximum)
  if (!parsed || !parsed.text) throw new Error(`${label}不能为空`)
  return parsed
}

function uniqueOrThrow(ids: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${label}「${id}」重复`)
    seen.add(id)
  }
}

function parseCharacter(raw: unknown, index: number): { row: DramaParseCharacter; warnings: string[] } {
  if (!isRecord(raw)) throw new Error(`角色第 ${index + 1} 行格式错误`)
  const warnings: string[] = []
  const name = requiredText(raw.name, `角色第 ${index + 1} 行名称`, maximumDramaNameLength)
  const appearance = requiredText(raw.appearance, `角色「${name.text}」外貌`)
  const power = optionalText(raw.powerRelation)
  const color = optionalText(raw.colorLock, maximumDramaNameLength)
  if (name.truncated || appearance.truncated || power.truncated || color.truncated) {
    warnings.push(`角色「${name.text}」有字段被截断`)
  }
  return {
    row: {
      elementId: requiredId(raw.elementId, `角色「${name.text}」`),
      name: name.text,
      appearance: appearance.text,
      ...(power.text ? { powerRelation: power.text } : {}),
      ...(color.text ? { colorLock: color.text } : {}),
    },
    warnings,
  }
}

function parseScene(raw: unknown, index: number): { row: DramaParseScene; warnings: string[] } {
  if (!isRecord(raw)) throw new Error(`场景第 ${index + 1} 行格式错误`)
  const warnings: string[] = []
  const name = requiredText(raw.name, `场景第 ${index + 1} 行名称`, maximumDramaNameLength)
  const environment = requiredText(raw.environment, `场景「${name.text}」环境`)
  const tone = optionalText(raw.tone)
  if (name.truncated || environment.truncated || tone.truncated) warnings.push(`场景「${name.text}」有字段被截断`)
  return {
    row: {
      elementId: requiredId(raw.elementId, `场景「${name.text}」`),
      name: name.text,
      environment: environment.text,
      ...(tone.text ? { tone: tone.text } : {}),
      ...(raw.needsBlockingBoard === true ? { needsBlockingBoard: true } : {}),
    },
    warnings,
  }
}

function parseProp(raw: unknown, index: number): { row: DramaParseProp; warnings: string[] } {
  if (!isRecord(raw)) throw new Error(`道具第 ${index + 1} 行格式错误`)
  const warnings: string[] = []
  const name = requiredText(raw.name, `道具第 ${index + 1} 行名称`, maximumDramaNameLength)
  const morphology = requiredText(raw.morphology, `道具「${name.text}」形态`)
  const countLock = optionalText(raw.countLock, maximumDramaNameLength)
  if (name.truncated || morphology.truncated || countLock.truncated) warnings.push(`道具「${name.text}」有字段被截断`)
  return {
    row: {
      elementId: requiredId(raw.elementId, `道具「${name.text}」`),
      name: name.text,
      morphology: morphology.text,
      ...(countLock.text ? { countLock: countLock.text } : {}),
    },
    warnings,
  }
}

function parseShot(raw: unknown, index: number): { row: DramaParseShot; warnings: string[] } {
  if (!isRecord(raw)) throw new Error(`镜头第 ${index + 1} 行格式错误`)
  const warnings: string[] = []
  const shotId = requiredId(raw.shotId, `镜头第 ${index + 1} 行`)
  const action = requiredText(raw.action, `镜头「${shotId}」动作`)
  const framing = requiredText(raw.framing, `镜头「${shotId}」景别`, maximumDramaNameLength)
  const timeRange = optionalText(raw.timeRange, maximumDramaNameLength)
  const camera = optionalText(raw.camera, maximumDramaNameLength)
  const emotion = optionalText(raw.emotion, maximumDramaNameLength)
  const dialogue = optionalText(raw.dialogue)
  if (action.truncated || framing.truncated || timeRange.truncated || camera.truncated || emotion.truncated || dialogue.truncated) {
    warnings.push(`镜头「${shotId}」有字段被截断`)
  }
  const characterIds = Array.isArray(raw.characterIds)
    ? raw.characterIds.map((id, offset) => requiredId(id, `镜头「${shotId}」角色 ${offset + 1}`))
    : []
  const propIds = Array.isArray(raw.propIds)
    ? raw.propIds.map((id, offset) => requiredId(id, `镜头「${shotId}」道具 ${offset + 1}`))
    : undefined
  return {
    row: {
      shotId,
      sceneId: requiredId(raw.sceneId, `镜头「${shotId}」场景`),
      characterIds,
      action: action.text,
      framing: framing.text,
      ...(timeRange.text ? { timeRange: timeRange.text } : {}),
      ...(camera.text ? { camera: camera.text } : {}),
      ...(emotion.text ? { emotion: emotion.text } : {}),
      ...(dialogue.text ? { dialogue: dialogue.text } : {}),
      ...(propIds && propIds.length > 0 ? { propIds } : {}),
    },
    warnings,
  }
}

export function validateDramaParseTables(raw: unknown): DramaParseResult {
  if (!isRecord(raw)) throw new Error('剧本解析结果必须是对象')
  if (!Array.isArray(raw.characters) || !Array.isArray(raw.scenes) || !Array.isArray(raw.props) || !Array.isArray(raw.shots)) {
    throw new Error('剧本解析结果缺少角色、场景、道具或镜头表')
  }
  if (raw.characters.length > maximumDramaCharacters) throw new Error(`角色不能超过 ${maximumDramaCharacters} 个`)
  if (raw.scenes.length > maximumDramaScenes) throw new Error(`场景不能超过 ${maximumDramaScenes} 个`)
  if (raw.props.length > maximumDramaProps) throw new Error(`道具不能超过 ${maximumDramaProps} 个`)
  if (raw.shots.length > maximumDramaShots) throw new Error(`镜头不能超过 ${maximumDramaShots} 个`)

  const warnings: string[] = []
  const characters = raw.characters.map((entry, index) => {
    const parsed = parseCharacter(entry, index)
    warnings.push(...parsed.warnings)
    return parsed.row
  })
  const scenes = raw.scenes.map((entry, index) => {
    const parsed = parseScene(entry, index)
    warnings.push(...parsed.warnings)
    return parsed.row
  })
  const props = raw.props.map((entry, index) => {
    const parsed = parseProp(entry, index)
    warnings.push(...parsed.warnings)
    return parsed.row
  })
  const shots = raw.shots.map((entry, index) => {
    const parsed = parseShot(entry, index)
    warnings.push(...parsed.warnings)
    return parsed.row
  })

  uniqueOrThrow(characters.map((row) => row.elementId), '角色标识')
  uniqueOrThrow(scenes.map((row) => row.elementId), '场景标识')
  uniqueOrThrow(props.map((row) => row.elementId), '道具标识')
  uniqueOrThrow(shots.map((row) => row.shotId), '镜头标识')

  const characterIds = new Set(characters.map((row) => row.elementId))
  const sceneIds = new Set(scenes.map((row) => row.elementId))
  const propIds = new Set(props.map((row) => row.elementId))
  for (const shot of shots) {
    if (!sceneIds.has(shot.sceneId)) throw new Error(`镜头「${shot.shotId}」引用了不存在的场景「${shot.sceneId}」`)
    for (const characterId of shot.characterIds) {
      if (!characterIds.has(characterId)) throw new Error(`镜头「${shot.shotId}」引用了不存在的角色「${characterId}」`)
    }
    for (const propId of shot.propIds ?? []) {
      if (!propIds.has(propId)) throw new Error(`镜头「${shot.shotId}」引用了不存在的道具「${propId}」`)
    }
  }

  return { tables: { characters, scenes, props, shots }, warnings }
}

export function parseDramaTablesJson(text: string): DramaParseResult {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('剧本解析没有返回有效 JSON')
  let raw: unknown
  try {
    raw = JSON.parse(candidate.slice(start, end + 1))
  } catch {
    throw new Error('剧本解析返回的 JSON 无法读取')
  }
  return validateDramaParseTables(raw)
}

export const danyinTwoShotFixture: DramaParseTables = {
  characters: [
    {
      elementId: 'yuwan',
      name: '虞晚',
      appearance: '红衣金饰半褪露肩，发间金钗流苏，红唇，手持血丹。',
      powerRelation: '试探主导',
    },
    {
      elementId: 'xielin',
      name: '谢凛',
      appearance: '黑衣湿发，立于屏风旁，肩背挺直。',
      powerRelation: '沉默受压',
    },
  ],
  scenes: [
    {
      elementId: 'warm-chamber',
      name: '暖阁内室',
      environment: '暗调暖光内室，帷帐烛火，窗格一线冷白月光。',
      tone: '暧昧蓄力',
      needsBlockingBoard: true,
    },
  ],
  props: [
    {
      elementId: 'blood-pill',
      name: '血丹',
      morphology: '血色丹珠，珠内血丝如活物游移。',
      countLock: '一枚',
    },
  ],
  shots: [
    {
      shotId: 's01',
      timeRange: '00:00.0-00:08.0',
      sceneId: 'warm-chamber',
      characterIds: ['yuwan'],
      propIds: ['blood-pill'],
      action: '虞晚斜倚锦榻，指尖旋动血丹至眼前。',
      framing: '大特写',
      camera: '极缓推',
      emotion: '暧昧蓄力',
      dialogue: '血丹...成色不错呢。',
    },
    {
      shotId: 's02',
      timeRange: '00:08.0-00:12.0',
      sceneId: 'warm-chamber',
      characterIds: ['yuwan'],
      action: '丹珠滑落锦被，虞晚抬眸直视画外。',
      framing: '特写',
      camera: '微推',
      emotion: '暧昧蓄力升级',
    },
  ],
}
