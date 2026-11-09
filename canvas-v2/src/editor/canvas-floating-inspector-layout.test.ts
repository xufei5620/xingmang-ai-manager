import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 窗口 761～1180px 宽时检查器浮在画布右边，原来把右下角导航工具、缩略图盖住，选中工具条也居中压到检查器上
// （1280 宽的桌面窗口就落在这一档）。画布记下浮层盖住的宽度，角落的工具都让开它。
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const toolbarCss = readFileSync(new URL('../components/selection-toolbar.css', import.meta.url), 'utf8')

function rule(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = source.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]+)\\}`))?.[1]
  if (body === undefined) throw new Error(`Missing CSS rule ${selector}`)
  return body
}

function block(prelude: string, source = css): string {
  const start = source.indexOf(prelude)
  if (start < 0) throw new Error(`Missing CSS block ${prelude}`)
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`Unclosed CSS block ${prelude}`)
}

const floating = block('@media (min-width: 761px) and (max-width: 1180px)')

describe('canvas corner tools beside a floating inspector', () => {
  it('covers nothing until an inspector floats over the canvas', () => {
    expect(rule('.canvas-flow')).toMatch(/--canvas-floating-panel:\s*0px\s*;/)
    expect(rule('.canvas-workspace:has(.canvas-inspector) .canvas-flow', floating))
      .toMatch(/--canvas-floating-panel:\s*max\(220px, min\(292px, calc\(100vw - 190px\)\)\)\s*;/)
  })

  it('matches the floating inspector width', () => {
    const inspector = rule('.canvas-inspector', block('@media (max-width: 1180px) {\n  .canvas-workspace { position: relative; }'))
    expect(inspector).toMatch(/position:\s*absolute\s*;/)
    expect(inspector).toMatch(/width:\s*min\(292px, calc\(100vw - 190px\)\)\s*;/)
    expect(inspector).toMatch(/min-width:\s*220px\s*;/)
  })

  it('moves the navigation tools, the minimap and the selection toolbar out from under it', () => {
    expect(rule('.canvas-navigation-tools')).toMatch(/right:\s*calc\(12px \+ var\(--canvas-floating-panel\)\)\s*;/)
    expect(css).toMatch(/\.react-flow__minimap \{[^}]*right:\s*calc\(12px \+ var\(--canvas-floating-panel\)\) !important;/)
    const toolbar = rule('.canvas-selection-toolbar', toolbarCss)
    expect(toolbar).toMatch(/left:\s*calc\(\(100% - var\(--canvas-floating-panel, 0px\)\) \/ 2\)\s*;/)
    expect(toolbar).toMatch(/max-width:\s*calc\(100% - var\(--canvas-floating-panel, 0px\) - 16px\)\s*;/)
  })

  it('keeps the status bar between the zoom controls and the navigation tools', () => {
    const statusbar = rule('.canvas-workspace:has(.canvas-inspector) .canvas-statusbar', floating)
    expect(statusbar).toMatch(/transform:\s*none\s*;/)
    expect(statusbar).toContain('max-width: calc(100% - 120px - var(--canvas-floating-panel) - var(--canvas-navigation-reserve));')
  })

  it('stacks the navigation tools and the minimap above the status bar when one row is too narrow', () => {
    const narrow = block('@container canvas-flow (max-width: 1000px)', floating)
    expect(rule('.canvas-workspace:has(.canvas-inspector) .canvas-navigation-tools', narrow)).toMatch(/bottom:\s*54px\s*;/)
    expect(rule('.canvas-workspace:has(.canvas-inspector) .react-flow__minimap', narrow)).toMatch(/bottom:\s*96px !important\s*;/)
    expect(rule('.canvas-workspace:has(.canvas-inspector) .canvas-statusbar', narrow))
      .toContain('max-width: calc(100% - 120px - var(--canvas-floating-panel) - 12px);')
  })

  it('leaves the phone layout alone', () => {
    expect(css.indexOf('@media (max-width: 760px)')).toBeGreaterThan(css.indexOf('@media (min-width: 761px) and (max-width: 1180px)'))
    expect(rule('.canvas-statusbar', block('@media (max-width: 760px)'))).toMatch(/left:\s*58px\s*;/)
  })
})
