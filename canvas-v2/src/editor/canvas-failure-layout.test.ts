import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 生成失败后的三处排版（#1368 第 10 条）：检查器里「重试到此节点」「从此向后重试」是没样式的系统按钮；
// 节点占位字「生成未完成 / 检查失败原因后重试」两个字一折行；失败卡压住右下角的「耗时」。
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
const nodes = readFileSync(new URL('../theme/editor-nodes.css', import.meta.url), 'utf8')

function rule(selector: string, source: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = source.match(new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]+)\\}`))?.[1]
  if (body === undefined) throw new Error(`Missing CSS rule ${selector}`)
  return body
}

describe('failed run layout', () => {
  it('gives the inspector retry commands the inspector button look', () => {
    expect(styles).toMatch(/\.run-history-tools button,\s*\.run-error-action button\s*\{[^}]*min-height:\s*28px;[^}]*border-radius:\s*var\(--radius-control\)/)
    expect(styles).toMatch(/\.run-error-action button:hover[^{]*\{[^}]*background:\s*var\(--surface-hover\)/)
    const row = rule('div.run-error-action', styles)
    expect(row).toMatch(/display:\s*flex\s*;/)
    expect(row).toMatch(/flex-wrap:\s*wrap\s*;/)
  })

  it('sizes the placeholder column by the node, not by the placeholder', () => {
    const pending = [...styles.matchAll(/\.wf-media-bound \.wf-drop-target\.is-pending\s*\{([^}]+)\}/g)].map((match) => match[1]).join('\n')
    expect(pending).toMatch(/display:\s*grid\s*;/)
    expect(pending).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)\s*;/)
  })

  it('moves the elapsed time clear of the failure card', () => {
    expect(rule('.wf-editor-node .wf-media-failure', nodes)).toMatch(/bottom:\s*8px\s*;/)
    const moved = rule('.wf-editor-node:has(.wf-media-failure) .wf-media-readouts', nodes)
    expect(moved).toMatch(/bottom:\s*auto\s*;/)
    const top = Number(moved.match(/top:\s*(\d+)px\s*;/)?.[1])
    // Below the type chip row (10px from the top, about 22px tall).
    expect(top).toBeGreaterThanOrEqual(36)
    expect(rule('.wf-editor-node .wf-media-chips', nodes)).toMatch(/top:\s*10px\s*;/)
  })
})
