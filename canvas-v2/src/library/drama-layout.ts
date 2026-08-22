import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { compileAssetSheetPrompt } from './drama-compile'
import { dramaShotGate } from './drama-gate'
import { dramaStyleDefault, type DramaParseTables } from './drama-model'
import { dramaAssetSettings, dramaBibleSettings, dramaShotSettings } from './drama-settings'

export interface DramaLayoutIds {
  createId(): string
}

export interface DramaConfirmSelection {
  characterIds: readonly string[]
  sceneIds: readonly string[]
  propIds: readonly string[]
  shotIds: readonly string[]
  renamed?: Record<string, string>
}

export function defaultDramaConfirmSelection(tables: DramaParseTables): DramaConfirmSelection {
  return {
    characterIds: tables.characters.map((row) => row.elementId),
    sceneIds: tables.scenes.map((row) => row.elementId),
    propIds: tables.props.map((row) => row.elementId),
    shotIds: tables.shots.map((row) => row.shotId),
  }
}

function nodeRecord(
  id: string,
  type: string,
  position: { x: number; y: number },
  config: Record<string, unknown>,
): EditorNodeRecord {
  const definition = builtinNodeRegistry.require(type)
  const known = new Set(['prompt', 'model', 'quality', 'size', 'imageResolution', 'seconds', 'status', 'result', 'assetId'])
  const settings = Object.fromEntries(Object.entries(config).filter(([key]) => !known.has(key)))
  return {
    id,
    type,
    definitionVersion: definition.version,
    position,
    width: definition.dimensions.width,
    height: definition.dimensions.height,
    data: {
      prompt: typeof config.prompt === 'string' ? config.prompt : '',
      model: typeof config.model === 'string' ? config.model : '',
      status: 'idle',
      ...(Object.keys(settings).length > 0 ? { settings } : {}),
    },
  }
}

export function buildDramaNodesFromTables(
  tables: DramaParseTables,
  options: DramaLayoutIds & {
    origin?: { x: number; y: number }
    includeBible?: boolean
    bibleId?: string
    selection?: DramaConfirmSelection
  },
): { nodes: EditorNodeRecord[]; edges: EditorEdgeRecord[] } {
  const origin = options.origin ?? { x: 80, y: 80 }
  const selection = options.selection ?? defaultDramaConfirmSelection(tables)
  const renamed = selection.renamed ?? {}
  const nodes: EditorNodeRecord[] = []
  const edges: EditorEdgeRecord[] = []
  const assetIds = new Map<string, string>()
  const bibleId = options.bibleId ?? (options.includeBible === false ? undefined : options.createId())
  if (bibleId && options.includeBible !== false && !options.bibleId) {
    nodes.push(nodeRecord(bibleId, 'drama-bible', origin, {
      prompt: dramaStyleDefault,
      ...dramaBibleSettings({ stylePrompt: dramaStyleDefault, aspectRatio: '16:9' }),
    }))
  }

  const selectedCharacters = tables.characters.filter((row) => selection.characterIds.includes(row.elementId))
  const selectedScenes = tables.scenes.filter((row) => selection.sceneIds.includes(row.elementId))
  const selectedProps = tables.props.filter((row) => selection.propIds.includes(row.elementId))
  const selectedShots = tables.shots.filter((row) => selection.shotIds.includes(row.shotId))

  selectedCharacters.forEach((row, index) => {
    const id = options.createId()
    assetIds.set(row.elementId, id)
    const name = renamed[row.elementId] || row.name
    const appearance = row.appearance
    const sheetPrompt = compileAssetSheetPrompt({
      assetKind: 'character', name, elementId: row.elementId, appearance,
    })
    nodes.push(nodeRecord(id, 'drama-character', { x: origin.x + 340, y: origin.y + index * 340 }, {
      prompt: sheetPrompt,
      ...dramaAssetSettings({
        assetKind: 'character', name, elementId: row.elementId, appearance, sheetPrompt, locked: false,
      }),
    }))
  })
  selectedScenes.forEach((row, index) => {
    const id = options.createId()
    assetIds.set(row.elementId, id)
    const name = renamed[row.elementId] || row.name
    const sheetPrompt = compileAssetSheetPrompt({
      assetKind: 'scene', name, elementId: row.elementId, appearance: row.environment,
    })
    nodes.push(nodeRecord(id, 'drama-scene', { x: origin.x + 680, y: origin.y + index * 320 }, {
      prompt: sheetPrompt,
      ...dramaAssetSettings({
        assetKind: 'scene', name, elementId: row.elementId, appearance: row.environment, sheetPrompt, locked: false,
      }),
    }))
  })
  selectedProps.forEach((row, index) => {
    const id = options.createId()
    assetIds.set(row.elementId, id)
    const name = renamed[row.elementId] || row.name
    const sheetPrompt = compileAssetSheetPrompt({
      assetKind: 'prop', name, elementId: row.elementId, appearance: row.morphology,
    })
    nodes.push(nodeRecord(id, 'drama-prop', { x: origin.x + 1020, y: origin.y + index * 300 }, {
      prompt: sheetPrompt,
      ...dramaAssetSettings({
        assetKind: 'prop', name, elementId: row.elementId, appearance: row.morphology, sheetPrompt, locked: false,
      }),
    }))
  })

  selectedShots.forEach((row, index) => {
    const id = options.createId()
    const referenced = [
      ...row.characterIds,
      row.sceneId,
      ...(row.propIds ?? []),
    ].flatMap((elementId) => {
      const nodeId = assetIds.get(elementId)
      return nodeId ? [{ elementId, nodeId }] : []
    })
    const gate = dramaShotGate(referenced.map((entry) => ({
      assetKind: 'character' as const,
      name: entry.elementId,
      elementId: entry.elementId,
      appearance: '',
      locked: false,
    })))
    nodes.push(nodeRecord(id, 'drama-shot', { x: origin.x + 1360, y: origin.y + index * 300 }, {
      prompt: '',
      ...dramaShotSettings({
        shotId: row.shotId,
        action: row.action,
        framing: row.framing,
        camera: row.camera,
        emotion: row.emotion,
        dialogue: row.dialogue,
        beat: row.timeRange,
        gate,
      }),
    }))
    if (bibleId) {
      edges.push({
        id: options.createId(),
        source: bibleId,
        sourceHandle: 'out:text',
        target: id,
        targetHandle: 'in:text',
      })
    }
    for (const reference of referenced) {
      edges.push({
        id: options.createId(),
        source: reference.nodeId,
        sourceHandle: 'out:image',
        target: id,
        targetHandle: 'in:images',
      })
    }
  })

  return { nodes, edges }
}
