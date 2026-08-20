import { describe, expect, it } from 'vitest'
import { canvasContextMenuItems, type CanvasContextMenuInput } from './context-menu'

function input(overrides: Partial<CanvasContextMenuInput> = {}): CanvasContextMenuInput {
  return {
    target: 'node',
    selectionCount: 1,
    executable: true,
    running: false,
    hasGroup: false,
    allLocked: false,
    allDisabled: false,
    canDisable: true,
    ...overrides,
  }
}

function actions(overrides: Partial<CanvasContextMenuInput> = {}) {
  return canvasContextMenuItems(input(overrides)).map((item) => item.action)
}

describe('canvasContextMenuItems', () => {
  it('offers single-node actions only for a single node', () => {
    expect(actions()).toContain('run')
    expect(actions()).toContain('locate')
    expect(actions({ target: 'selection', selectionCount: 3 })).not.toContain('run')
    expect(actions({ target: 'selection', selectionCount: 3 })).not.toContain('locate')
  })

  it('hides run for a node that cannot execute', () => {
    expect(actions({ executable: false })).not.toContain('run')
  })

  it('offers grouping only when more than one node is selected', () => {
    expect(actions({ selectionCount: 1 })).not.toContain('group')
    expect(actions({ target: 'selection', selectionCount: 2 })).toContain('group')
  })

  it('offers ungroup only when a group is in the selection', () => {
    expect(actions({ hasGroup: false })).not.toContain('ungroup')
    expect(actions({ hasGroup: true })).toContain('ungroup')
  })

  it('flips lock and disable to their inverse when already applied', () => {
    expect(actions({ allLocked: false })).toContain('lock')
    expect(actions({ allLocked: true })).toContain('unlock')
    expect(actions({ allDisabled: false })).toContain('disable')
    expect(actions({ allDisabled: true })).toContain('enable')
  })

  it('omits the disable toggle when nothing in the selection can be disabled', () => {
    const result = actions({ canDisable: false })
    expect(result).not.toContain('disable')
    expect(result).not.toContain('enable')
  })

  it('always ends with a destructive delete', () => {
    for (const overrides of [{}, { target: 'selection' as const, selectionCount: 4 }, { executable: false }]) {
      const items = canvasContextMenuItems(input(overrides))
      expect(items.at(-1)).toMatchObject({ action: 'delete', danger: true })
    }
  })

  it('never starts with a separator', () => {
    for (const overrides of [{}, { executable: false }, { target: 'selection' as const, selectionCount: 5 }]) {
      expect(canvasContextMenuItems(input(overrides))[0].separatorBefore).toBeFalsy()
    }
  })
})
