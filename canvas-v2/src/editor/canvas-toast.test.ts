import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let effectSource = ''
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes("banner !== '产物已保存'")) effectSource = node.arguments[0].getText(source)
  ts.forEachChild(node, visit)
}
visit(source)
function notification(banner: string | null) {
  if (!effectSource) throw new Error('Missing production success notification effect')
  let current = banner
  const setBanner = vi.fn((update: (value: string | null) => string | null) => { current = update(current) })
  const code = ts.transpileModule(`return (${effectSource});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const effect = new Function('banner', 'setBanner', 'window', code)(banner, setBanner, { setTimeout, clearTimeout }) as () => (() => void) | undefined
  return { effect, setBanner, current: () => current, replace: (value: string | null) => { current = value } }
}

afterEach(() => vi.useRealTimers())

describe('canvas notification hit testing and lifecycle', () => {
  it('lets clicks pass through the message while keeping the dismiss button interactive', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
    expect(css.match(/\.canvas-toast\s*\{([^}]+)\}/)?.[1]).toMatch(/pointer-events:\s*none\s*;/)
    expect(css.match(/\.canvas-toast button\s*\{([^}]+)\}/)?.[1]).toMatch(/pointer-events:\s*auto\s*;/)
  })

  it('dismisses the saved-output success after four seconds without dismissing newer information', () => {
    vi.useFakeTimers()
    const success = notification('产物已保存'); success.effect()
    vi.advanceTimersByTime(3999)
    expect(success.current()).toBe('产物已保存')
    vi.advanceTimersByTime(1)
    expect(success.current()).toBeNull()
    const replaced = notification('产物已保存'); replaced.effect(); replaced.replace('恢复结果未知，请核对原操作')
    vi.advanceTimersByTime(4000)
    expect(replaced.current()).toBe('恢复结果未知，请核对原操作')
  })

  it('clears its timer on unmount or a new banner and leaves actionable notices persistent', () => {
    vi.useFakeTimers()
    const success = notification('产物已保存'), cleanup = success.effect()
    cleanup?.(); vi.advanceTimersByTime(4000)
    expect(success.setBanner).not.toHaveBeenCalled()
    for (const message of ['请确认运行范围和本次额度风险', '输入已变化，旧运行结果保留', null]) {
      const notice = notification(message)
      expect(notice.effect()).toBeUndefined()
      vi.advanceTimersByTime(60_000)
      expect(notice.current()).toBe(message)
      expect(notice.setBanner).not.toHaveBeenCalled()
    }
  })
})
