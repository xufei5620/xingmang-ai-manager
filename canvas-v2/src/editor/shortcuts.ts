export type CanvasShortcut =
  | 'undo' | 'redo' | 'select-all' | 'copy' | 'paste' | 'duplicate'
  | 'delete' | 'save' | 'open' | 'run' | 'group' | 'ungroup' | 'layout' | 'quick-insert'

export interface CanvasShortcutEvent {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  isComposing?: boolean
  target?: unknown
}

function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
  return element.isContentEditable === true || tagName === 'input' || tagName === 'textarea' || tagName === 'select'
}

export function resolveCanvasShortcut(event: CanvasShortcutEvent): CanvasShortcut | null {
  if (event.isComposing || event.altKey || isEditableTarget(event.target)) return null
  const modifier = Boolean(event.ctrlKey || event.metaKey)
  const key = event.key.toLowerCase()
  if (!modifier) return key === 'delete' || key === 'backspace' ? 'delete' : null
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y') return 'redo'
  if (key === 'a') return 'select-all'
  if (key === 'c') return 'copy'
  if (key === 'v') return 'paste'
  if (key === 'd') return 'duplicate'
  if (key === 's') return 'save'
  if (key === 'o') return 'open'
  if (key === 'enter') return 'run'
  if (key === 'g') return event.shiftKey ? 'ungroup' : 'group'
  if (key === 'l') return 'layout'
  if (key === 'k') return 'quick-insert'
  return null
}
