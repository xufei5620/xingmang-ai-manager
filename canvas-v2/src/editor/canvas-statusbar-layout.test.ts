import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 检查器或创作库展开时画布变窄、窗口宽度不变，按窗口宽度写的规则管不到状态栏：
// 1280 宽开着检查器，「2 个节点 · 0 条连线」「已自动保存」被拆成两行，右半截压在导航工具下面（#1368 第 13 条）。
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')

function rule(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = source.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]+)\\}`))?.[1]
  if (body === undefined) throw new Error(`Missing CSS rule ${selector}`)
  return body
}

function block(prelude: string): string {
  const start = css.indexOf(prelude)
  if (start < 0) throw new Error(`Missing CSS block ${prelude}`)
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    if (css[index] === '}' && --depth === 0) return css.slice(start, index + 1)
  }
  throw new Error(`Unclosed CSS block ${prelude}`)
}

describe('canvas status bar layout', () => {
  it('queries the canvas width rather than the window width', () => {
    expect(rule('.canvas-flow')).toMatch(/container:\s*canvas-flow\s*\/\s*inline-size\s*;/)
    expect(rule('.canvas-flow')).toMatch(/--canvas-navigation-reserve:\s*\d+px\s*;/)
  })

  it('keeps every part on one line and lets only the generation summary shrink', () => {
    expect(rule('.canvas-statusbar > span')).toMatch(/white-space:\s*nowrap\s*;/)
    expect(rule('.canvas-statusbar > span')).toMatch(/flex:\s*none\s*;/)
    expect(rule('.canvas-statusbar > .canvas-status-media')).toMatch(/min-width:\s*0\s*;/)
    expect(rule('.canvas-statusbar > .canvas-status-media')).toMatch(/flex:\s*0 1 auto\s*;/)
  })

  it('stays clear of the navigation tools whether centred or not', () => {
    expect(rule('.canvas-statusbar')).toMatch(/max-width:\s*calc\(100% - var\(--canvas-floating-panel\) - 2 \* var\(--canvas-navigation-reserve\)\)\s*;/)
    const narrow = block('@container canvas-flow (max-width: 1000px)')
    const statusbar = rule('.canvas-statusbar', narrow)
    expect(statusbar).toMatch(/transform:\s*none\s*;/)
    const left = Number(statusbar.match(/left:\s*(\d+)px\s*;/)?.[1])
    expect(statusbar).toContain(`max-width: calc(100% - ${left}px - var(--canvas-floating-panel) - var(--canvas-navigation-reserve));`)
  })

  it('leaves the phone layout as it was', () => {
    const phone = block('@media (max-width: 760px)')
    expect(rule('.canvas-statusbar', phone)).toMatch(/max-width:\s*none\s*;/)
    expect(phone).toContain('.canvas-statusbar span:nth-child(n+2) { display: none; }')
    // The phone rule must come after the container rule so it still wins on a phone.
    expect(css.indexOf('@media (max-width: 760px)')).toBeGreaterThan(css.indexOf('@container canvas-flow (max-width: 1000px)'))
  })
})
