import { composeCharacterSheetPrompt, defaultCharacterSheetStyle } from './character-sheet-prompt'
import type { DramaAssetData, DramaBibleData, DramaShotData } from './drama-model'
import { composePropSheetPrompt } from './prop-sheet-prompt'
import { composeSceneSheetPrompt } from './scene-sheet-prompt'
import { composeShotFramePrompt } from './shot-frame-prompt'

export interface DramaCompileAsset extends DramaAssetData {
  referenceLabel?: string
}

export function compileCharacterSheetFromAsset(asset: DramaAssetData, bible?: DramaBibleData): string {
  return composeCharacterSheetPrompt({
    appearance: asset.appearance,
    style: bible?.stylePrompt || defaultCharacterSheetStyle,
  })
}

export function compileAssetSheetPrompt(asset: DramaAssetData, bible?: DramaBibleData): string {
  const style = bible?.stylePrompt || defaultCharacterSheetStyle
  if (asset.assetKind === 'character') return compileCharacterSheetFromAsset(asset, bible)
  if (asset.assetKind === 'scene') return composeSceneSheetPrompt({ environment: asset.appearance, style })
  return composePropSheetPrompt({ morphology: asset.appearance, style })
}

export function compileShotImagePrompt(input: {
  bible?: DramaBibleData
  assets: readonly DramaCompileAsset[]
  shot: DramaShotData
}): string {
  const { bible, assets, shot } = input
  const frame = composeShotFramePrompt({
    action: shot.action,
    framing: shot.framing,
    camera: shot.camera,
  })
  const references = assets.map((asset, index) => {
    const duty = asset.assetKind === 'character'
      ? `仅锁定「${asset.name}」的身份、发型与服装，不提供姿势`
      : asset.assetKind === 'scene'
        ? `仅锁定场景「${asset.name}」的环境结构与色调，不提供人物`
        : `仅锁定道具「${asset.name}」的形态`
    const extras = [asset.promptTags, asset.hardRules].filter(Boolean).join('；')
    return `Image ${index + 1}（${asset.referenceLabel || asset.name}）：${duty}。${asset.appearance}${extras ? ` ${extras}` : ''}`
  })
  const avoid = [
    'faces swapped or merged',
    '字幕、片名、水印',
    ...(bible?.genreAvoid ?? []),
  ]
  return [
    frame,
    ...(shot.dialogue ? [`台词氛围：${shot.dialogue}`] : []),
    ...(shot.emotion ? [`情绪：${shot.emotion}`] : []),
    ...(references.length > 0 ? ['参考图职责：', ...references] : []),
    `风格：${bible?.stylePrompt || defaultCharacterSheetStyle}`,
    ...(bible?.worldTone ? [`世界观：${bible.worldTone}`] : []),
    `Avoid：${avoid.join('；')}`,
  ].join('\n')
}
