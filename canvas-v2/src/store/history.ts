import { commandMergeKey, type CanvasCommand } from './canvas-command'
import { reduceCanvasDocument } from './canvas-reducer'
import type { CanvasDocumentState } from './canvas-state'

export interface CanvasHistoryState {
  past: CanvasDocumentState[]
  present: CanvasDocumentState
  future: CanvasDocumentState[]
  lastMergeKey: string | null
  lastCommandAt: number
}

/**
 * Editing the same node after this long counts as a new edit, even though the
 * merge key is unchanged. Deliberately generous: with a Chinese IME each
 * committed word is one command and the pauses between words are long, so a
 * typical 500ms window would shatter a single sentence into many undo steps.
 */
export const canvasHistoryMergeWindowMs = 2_500

export function createCanvasHistory(document: CanvasDocumentState): CanvasHistoryState {
  return { past: [], present: document, future: [], lastMergeKey: null, lastCommandAt: 0 }
}

export function applyCanvasCommand(
  history: CanvasHistoryState,
  command: CanvasCommand,
  maximumEntries = 50,
  now: number = Date.now(),
): CanvasHistoryState {
  const present = reduceCanvasDocument(history.present, command)
  if (present === history.present) return history
  if (command.type === 'set-viewport') {
    const viewport = { ...present.viewport }
    return {
      past: history.past.map((document) => ({ ...document, viewport: { ...viewport } })),
      present,
      future: history.future.map((document) => ({ ...document, viewport: { ...viewport } })),
      lastMergeKey: null,
      lastCommandAt: now,
    }
  }
  const mergeKey = commandMergeKey(command)
  const continuesTransaction = Boolean(
    mergeKey
    && mergeKey === history.lastMergeKey
    && history.future.length === 0
    && now - history.lastCommandAt <= canvasHistoryMergeWindowMs,
  )
  const past = continuesTransaction
    ? history.past
    : [...history.past, history.present].slice(-maximumEntries)
  return { past, present, future: [], lastMergeKey: mergeKey, lastCommandAt: now }
}

export function undoCanvasHistory(history: CanvasHistoryState): CanvasHistoryState {
  const previous = history.past.at(-1)
  if (!previous) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastMergeKey: null,
    lastCommandAt: history.lastCommandAt,
  }
}

export function redoCanvasHistory(history: CanvasHistoryState): CanvasHistoryState {
  const next = history.future[0]
  if (!next) return history
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
    lastMergeKey: null,
    lastCommandAt: history.lastCommandAt,
  }
}
