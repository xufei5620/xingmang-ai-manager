export const dramaStyleDefault = '3D漫剧写实厚涂风。'

export type DramaAssetKind = 'character' | 'scene' | 'prop'
export type DramaShotGate = 'blocked' | 'ready' | 'stale'
export type DramaAspectRatio = '16:9' | '9:16' | '1:1'

export const maximumDramaNameLength = 64
export const maximumDramaIdLength = 64
export const maximumDramaTextLength = 2_000
export const maximumDramaCharacters = 32
export const maximumDramaScenes = 16
export const maximumDramaProps = 32
export const maximumDramaShots = 80

export interface DramaColorLock {
  entity: string
  hex?: string
  morphology?: string
  rule: string
}

export interface DramaBibleData {
  title?: string
  worldTone?: string
  stylePrompt?: string
  aspectRatio?: DramaAspectRatio
  colorLocks?: DramaColorLock[]
  genreAvoid?: string[]
  defaultImageSize?: string
}

export interface DramaAssetData {
  assetKind: DramaAssetKind
  name: string
  elementId: string
  appearance: string
  hardRules?: string
  promptTags?: string
  sheetPrompt?: string
  locked?: boolean
}

export interface DramaShotData {
  shotId: string
  beat?: string
  framing?: string
  camera?: string
  emotion?: string
  dialogue?: string
  action: string
  compiledImagePrompt?: string
  compiledVideoPrompt?: string
  gate?: DramaShotGate
}

export interface DramaParseCharacter {
  elementId: string
  name: string
  appearance: string
  powerRelation?: string
  colorLock?: string
}

export interface DramaParseScene {
  elementId: string
  name: string
  environment: string
  tone?: string
  needsBlockingBoard?: boolean
}

export interface DramaParseProp {
  elementId: string
  name: string
  morphology: string
  countLock?: string
}

export interface DramaParseShot {
  shotId: string
  timeRange?: string
  sceneId: string
  characterIds: string[]
  propIds?: string[]
  action: string
  framing: string
  camera?: string
  emotion?: string
  dialogue?: string
}

export interface DramaParseTables {
  characters: DramaParseCharacter[]
  scenes: DramaParseScene[]
  props: DramaParseProp[]
  shots: DramaParseShot[]
}

export const dramaSettingsKey = 'drama'

export function isDramaAspectRatio(value: unknown): value is DramaAspectRatio {
  return value === '16:9' || value === '9:16' || value === '1:1'
}

export function isDramaAssetKind(value: unknown): value is DramaAssetKind {
  return value === 'character' || value === 'scene' || value === 'prop'
}

export function isDramaShotGate(value: unknown): value is DramaShotGate {
  return value === 'blocked' || value === 'ready' || value === 'stale'
}
