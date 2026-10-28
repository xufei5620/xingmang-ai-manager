export interface PromptMenuRect { left: number; top: number; right: number; bottom: number; width: number }
export interface PromptMenuViewport { left: number; top: number; width: number; height: number }
export interface PromptMenuPosition { left: number; top: number; width: number; maxHeight: number; side: 'above' | 'below' | 'overlay' }

/** Anchor rectangles already include canvas zoom. The portal uses viewport
 * pixels so its controls never inherit the diagram's scale or clipping. */
export function positionPromptMenu(anchor: PromptMenuRect, viewport: PromptMenuViewport, height = 430): PromptMenuPosition {
  const margin = 8, gap = 8
  const width = Math.max(1, Math.min(420, Math.max(320, anchor.width), viewport.width - margin * 2))
  const availableHeight = Math.max(1, viewport.height - margin * 2)
  const above = Math.max(0, Math.min(availableHeight, anchor.top - viewport.top - margin - gap))
  const below = Math.max(0, Math.min(availableHeight, viewport.top + viewport.height - margin - anchor.bottom - gap))
  const side = Math.max(above, below) < Math.min(240, availableHeight) ? 'overlay' : above >= Math.min(430, availableHeight) || above >= below ? 'above' : 'below'
  const maxHeight = Math.max(1, Math.min(560, side === 'overlay' ? availableHeight : side === 'above' ? above : below))
  const actualHeight = Math.min(Math.max(1, height), maxHeight)
  const preferredTop = side === 'above' ? anchor.top - gap - actualHeight : side === 'below' ? anchor.bottom + gap : viewport.top + margin
  return {
    left: Math.max(viewport.left + margin, Math.min(anchor.left, viewport.left + viewport.width - margin - width)),
    top: Math.max(viewport.top + margin, Math.min(preferredTop, viewport.top + viewport.height - margin - actualHeight)),
    width, maxHeight, side,
  }
}

export function promptShortcutOwnsFocus(owner: string, target: { closest(selector: string): { getAttribute(name: string): string | null } | null } | null): boolean {
  return target?.closest('[data-prompt-shortcut-owner]')?.getAttribute('data-prompt-shortcut-owner') === owner
}

export function promptShortcutShouldDismiss(owner: string, event: 'blur' | 'pointer', target: Parameters<typeof promptShortcutOwnsFocus>[1], insideEditor: boolean): boolean {
  // Disabling or removing a focused form control emits a blur without a new
  // target. It is not evidence of leaving the menu; outside pointer events
  // still close it even when the clicked surface cannot receive focus.
  return !insideEditor && !promptShortcutOwnsFocus(owner, target) && (event === 'pointer' || target !== null)
}
