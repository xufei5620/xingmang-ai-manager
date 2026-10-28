import { finishLayerEditorTransaction, type LayerEditorState } from './layer-editor-state'
import type { LayerCanvasSelection } from './layer-paint-state'

/** Preview changes stay outside history. A completed gesture restores its
 * original selection before committing once, sharing chronological undo with
 * paint and mask edits without adding anything to ImageLayerRecipe. */
export function updateEditorCanvasSelection(state: LayerEditorState, selection: LayerCanvasSelection | null, remember = false, recordEqual = false): LayerEditorState {
  const current = remember ? finishLayerEditorTransaction(state) : state
  const previous = current.present.canvasSelection ?? null
  if (!recordEqual && JSON.stringify(previous) === JSON.stringify(selection)) return current
  const present = { ...current.present, canvasSelection: selection }
  if (!remember) return { ...current, present }
  return { ...current, present, past: [...current.past.slice(-59), current.present], future: [] }
}
