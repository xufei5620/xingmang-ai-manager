import { describe, expect, it } from 'vitest'
import { positionSelectionMenu, selectionMenuKey, selectionToolbarActions, type SelectionMenuRect, type SelectionMenuViewport, type SelectionToolbarState } from './selection-toolbar-model'

const state: SelectionToolbarState = { count: 14, canGroup: true, canUngroup: true, allLocked: false, canToggleDisabled: true, allDisabled: false, canSaveWorkshop: true }
function inside(anchor: SelectionMenuRect, viewport: SelectionMenuViewport, height: number) {
  const result = positionSelectionMenu(anchor, viewport, height)
  expect(result.left).toBeGreaterThanOrEqual(viewport.left)
  expect(result.top).toBeGreaterThanOrEqual(viewport.top)
  expect(result.left + result.width).toBeLessThanOrEqual(viewport.left + viewport.width)
  expect(result.top + Math.min(height, result.maxHeight)).toBeLessThanOrEqual(viewport.top + viewport.height)
  expect(result.maxHeight).toBeGreaterThan(0)
  return result
}

describe('selection toolbar action directory', () => {
  it('retains every original action behind two explicit menus', () => {
    const actions = [...selectionToolbarActions(state, 'layout'), ...selectionToolbarActions(state, 'more')]
    expect(actions.map((item) => item.id)).toEqual(['align:left', 'align:horizontal-center', 'align:right', 'align:top', 'align:vertical-center', 'align:bottom', 'distribute:horizontal', 'distribute:vertical', 'inspect', 'focus', 'copy', 'duplicate', 'save', 'lock', 'disable', 'group', 'ungroup', 'delete'])
    expect(actions.every((item) => item.label && item.ariaLabel)).toBe(true)
  })
  it('keeps unavailable actions visible with specific reasons without enabling them', () => {
    const single = { ...state, count: 1, canGroup: false, canUngroup: false, canToggleDisabled: false }
    const layout = selectionToolbarActions(single, 'layout')
    expect(layout).toHaveLength(8)
    expect(layout.every((item) => item.disabledReason)).toBe(true)
    expect(layout[0].disabledReason).toContain('2 个独立节点')
    expect(layout[6].disabledReason).toContain('3 个独立节点')
    const more = selectionToolbarActions(single, 'more')
    expect(more.find((item) => item.id === 'group')?.disabledReason).toContain('同一父级')
    expect(more.find((item) => item.id === 'ungroup')?.disabledReason).toContain('选中一个分组')
    expect(more.find((item) => item.id === 'disable')?.disabledReason).toContain('可切换运行状态')
  })
  it('uses actual parent-provided group eligibility instead of treating count as eligibility', () => {
    expect(selectionToolbarActions({ ...state, count: 14, canGroup: false }, 'more').find((item) => item.id === 'group')?.disabledReason).toBeTruthy()
    expect(selectionToolbarActions({ ...state, count: 2 }, 'layout').filter((item) => item.disabledReason).map((item) => item.id)).toEqual(['distribute:horizontal', 'distribute:vertical'])
  })
  it('preserves checked lock and run states and optional host capability', () => {
    const more = selectionToolbarActions({ ...state, allLocked: true, allDisabled: true, canSaveWorkshop: false }, 'more')
    expect(more.find((item) => item.id === 'lock')).toMatchObject({ checked: true, label: '解锁位置' })
    expect(more.find((item) => item.id === 'disable')).toMatchObject({ checked: true, label: '启用节点运行' })
    expect(more.some((item) => item.id === 'save')).toBe(false)
  })
})

describe('selection menu viewport placement', () => {
  it.each([390, 768, 1440])('keeps the complete menu within a %s px viewport even with an offscreen legacy trigger', (width) => {
    const result = inside({ left: -82.24, right: 520.24, top: 100, bottom: 142 }, { left: 0, top: 0, width, height: 844 }, 780)
    expect(result.width).toBeLessThanOrEqual(304)
    expect(result.maxHeight).toBeLessThan(780)
  })
  it('follows collapsed and expanded sidebar trigger positions independently of window width', () => {
    const view = { left: 0, top: 0, width: 768, height: 1024 }
    const a = inside({ left: 400, right: 454, top: 72, bottom: 106 }, view, 480)
    const b = inside({ left: 600, right: 654, top: 72, bottom: 106 }, view, 480)
    expect(b.left - a.left).toBe(200)
  })
  it('opens above a low trigger and uses bounded overlay with a keyboard-reduced viewport', () => {
    expect(inside({ left: 200, right: 254, top: 650, bottom: 684 }, { left: 0, top: 0, width: 390, height: 720 }, 400).top).toBe(244)
    const keyboard = inside({ left: 300, right: 354, top: 190, bottom: 224 }, { left: 40, top: 90, width: 350, height: 240 }, 680)
    expect(keyboard).toMatchObject({ top: 98, maxHeight: 224 })
  })
  it('handles very small viewports without negative panel dimensions', () => {
    inside({ left: 10, right: 40, top: -10, bottom: 15 }, { left: 0, top: 0, width: 80, height: 40 }, 600)
  })
})

describe('selection menu keyboard navigation', () => {
  it('wraps all items including disabled explanatory rows and handles empty menus', () => {
    expect(selectionMenuKey('ArrowDown', 7, 8)).toEqual({ kind: 'focus', index: 0 })
    expect(selectionMenuKey('ArrowUp', 0, 8)).toEqual({ kind: 'focus', index: 7 })
    expect(selectionMenuKey('ArrowUp', -1, 8)).toEqual({ kind: 'focus', index: 7 })
    expect(selectionMenuKey('Home', 5, 8)).toEqual({ kind: 'focus', index: 0 })
    expect(selectionMenuKey('End', 0, 8)).toEqual({ kind: 'focus', index: 7 })
    expect(selectionMenuKey('ArrowDown', 0, 0)).toBeNull()
  })
  it('distinguishes native activation and Tab traversal from Escape dismissal', () => {
    expect(selectionMenuKey('Escape', 0, 8)).toEqual({ kind: 'close' })
    expect(selectionMenuKey('Tab', 0, 8)).toEqual({ kind: 'tab' })
    for (const key of ['Enter', ' ', 'Delete', 'Backspace', 'a', 'z']) expect(selectionMenuKey(key, 0, 8)).toBeNull()
  })
})
