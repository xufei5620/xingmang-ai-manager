import {
  dramaStyleDefault,
  isDramaAspectRatio,
  isDramaAssetKind,
  isDramaShotGate,
  type DramaAssetData,
  type DramaAssetKind,
  type DramaBibleData,
  type DramaShotData,
} from './drama-model'

function textField(settings: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = settings?.[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function boolField(settings: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = settings?.[key]
  return typeof value === 'boolean' ? value : undefined
}

export function readDramaBible(settings: Record<string, unknown> | undefined, prompt = ''): DramaBibleData {
  const stylePrompt = textField(settings, 'stylePrompt') || prompt.trim() || dramaStyleDefault
  const genreAvoid = Array.isArray(settings?.genreAvoid)
    ? settings.genreAvoid.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : undefined
  const aspectRatio = isDramaAspectRatio(settings?.aspectRatio) ? settings.aspectRatio : undefined
  return {
    ...(textField(settings, 'title') ? { title: textField(settings, 'title') } : {}),
    ...(textField(settings, 'worldTone') ? { worldTone: textField(settings, 'worldTone') } : {}),
    stylePrompt,
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(genreAvoid && genreAvoid.length > 0 ? { genreAvoid } : {}),
    ...(textField(settings, 'defaultImageSize') ? { defaultImageSize: textField(settings, 'defaultImageSize') } : {}),
  }
}

export function readDramaAsset(settings: Record<string, unknown> | undefined, fallbackKind: DramaAssetKind, prompt = ''): DramaAssetData {
  const assetKind = isDramaAssetKind(settings?.assetKind) ? settings.assetKind : fallbackKind
  return {
    assetKind,
    name: textField(settings, 'name') || (assetKind === 'character' ? '角色' : assetKind === 'scene' ? '场景' : '道具'),
    elementId: textField(settings, 'elementId') || '',
    appearance: textField(settings, 'appearance') || prompt,
    ...(textField(settings, 'hardRules') ? { hardRules: textField(settings, 'hardRules') } : {}),
    ...(textField(settings, 'promptTags') ? { promptTags: textField(settings, 'promptTags') } : {}),
    ...(textField(settings, 'sheetPrompt') ? { sheetPrompt: textField(settings, 'sheetPrompt') } : {}),
    locked: boolField(settings, 'locked') === true,
  }
}

export function readDramaShot(settings: Record<string, unknown> | undefined, prompt = ''): DramaShotData {
  const gate = isDramaShotGate(settings?.gate) ? settings.gate : undefined
  return {
    shotId: textField(settings, 'shotId') || '',
    action: textField(settings, 'action') || prompt,
    ...(textField(settings, 'beat') ? { beat: textField(settings, 'beat') } : {}),
    ...(textField(settings, 'framing') ? { framing: textField(settings, 'framing') } : {}),
    ...(textField(settings, 'camera') ? { camera: textField(settings, 'camera') } : {}),
    ...(textField(settings, 'emotion') ? { emotion: textField(settings, 'emotion') } : {}),
    ...(textField(settings, 'dialogue') ? { dialogue: textField(settings, 'dialogue') } : {}),
    ...(textField(settings, 'compiledImagePrompt') ? { compiledImagePrompt: textField(settings, 'compiledImagePrompt') } : {}),
    ...(textField(settings, 'compiledVideoPrompt') ? { compiledVideoPrompt: textField(settings, 'compiledVideoPrompt') } : {}),
    ...(gate ? { gate } : {}),
  }
}

export function dramaAssetSettings(asset: DramaAssetData): Record<string, unknown> {
  return {
    assetKind: asset.assetKind,
    name: asset.name,
    elementId: asset.elementId,
    appearance: asset.appearance,
    ...(asset.hardRules ? { hardRules: asset.hardRules } : {}),
    ...(asset.promptTags ? { promptTags: asset.promptTags } : {}),
    ...(asset.sheetPrompt ? { sheetPrompt: asset.sheetPrompt } : {}),
    locked: asset.locked === true,
  }
}

export function dramaShotSettings(shot: DramaShotData): Record<string, unknown> {
  return {
    shotId: shot.shotId,
    action: shot.action,
    ...(shot.beat ? { beat: shot.beat } : {}),
    ...(shot.framing ? { framing: shot.framing } : {}),
    ...(shot.camera ? { camera: shot.camera } : {}),
    ...(shot.emotion ? { emotion: shot.emotion } : {}),
    ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
    ...(shot.compiledImagePrompt ? { compiledImagePrompt: shot.compiledImagePrompt } : {}),
    ...(shot.compiledVideoPrompt ? { compiledVideoPrompt: shot.compiledVideoPrompt } : {}),
    ...(shot.gate ? { gate: shot.gate } : {}),
  }
}

export function dramaBibleSettings(bible: DramaBibleData): Record<string, unknown> {
  return {
    ...(bible.title ? { title: bible.title } : {}),
    ...(bible.worldTone ? { worldTone: bible.worldTone } : {}),
    stylePrompt: bible.stylePrompt || dramaStyleDefault,
    ...(bible.aspectRatio ? { aspectRatio: bible.aspectRatio } : {}),
    ...(bible.genreAvoid && bible.genreAvoid.length > 0 ? { genreAvoid: bible.genreAvoid } : {}),
    ...(bible.defaultImageSize ? { defaultImageSize: bible.defaultImageSize } : {}),
  }
}

export function isDramaAssetNodeType(type: string | undefined): type is 'drama-character' | 'drama-scene' | 'drama-prop' {
  return type === 'drama-character' || type === 'drama-scene' || type === 'drama-prop'
}

export function dramaAssetKindForType(type: string): DramaAssetKind {
  if (type === 'drama-scene') return 'scene'
  if (type === 'drama-prop') return 'prop'
  return 'character'
}
