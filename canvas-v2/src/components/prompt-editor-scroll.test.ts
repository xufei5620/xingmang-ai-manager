import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { synchronizePromptScroll } from './prompt-editor-scroll'

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
function rule(selector: string): string {
  const match = css.indexOf(`${selector} {`)
  if (match < 0) throw new Error(`Missing rule: ${selector}`)
  return css.slice(match, css.indexOf('}', match) + 1)
}

describe('bounded prompt editing viewport', () => {
  it('removes full-text mirror height from node sizing and keeps textarea scrolling bounded', () => {
    expect(rule('.wf-prompt-editor > textarea')).toContain('max-height: 280px')
    expect(rule('.wf-prompt-editor > textarea')).toContain('overflow: auto')
    expect(rule('.wf-prompt-editor > textarea')).toContain('overscroll-behavior: contain')
    expect(rule('.wf-prompt-editor > textarea')).toContain('field-sizing: fixed')
    // The earlier grouped rule sets typography; inspect the absolute rule.
    const mirror = css.slice(css.indexOf('  /* The mirror must not contribute'))
    expect(mirror.slice(0, mirror.indexOf('}'))).toContain('position: absolute')
    expect(mirror.slice(0, mirror.indexOf('}'))).toContain('inset: 0')
    expect(rule('.wf-node-overview')).toContain('position: absolute')
    expect(rule('.wf-node-overview blockquote')).toContain('max-height: 44px')
    expect(rule('.wf-node-overview blockquote')).toContain('overflow: hidden')
  })

  it('keeps a long body scrollable to the final line without losing overlay padding', () => {
    const viewport = { scrollTop: 0, scrollLeft: 0, offsetWidth: 320, clientWidth: 320 }
    const mirror = { scrollTop: 0, scrollLeft: 0, style: { paddingRight: '' } }
    // Scrolling is unbounded by the 280px viewport or the 100k text limit.
    for (const scrollTop of [0, 280, 13_500, 100_000, 0]) {
      synchronizePromptScroll({ ...viewport, scrollTop }, mirror, 10)
      expect(mirror.scrollTop).toBe(scrollTop)
      expect(mirror.style.paddingRight).toBe('10px')
    }
  })

  it('preserves wrapping beside a reserved scrollbar and resynchronizes after resize', () => {
    const mirror = { scrollTop: 0, scrollLeft: 0, style: { paddingRight: '' } }
    synchronizePromptScroll({ scrollTop: 55, scrollLeft: 3, offsetWidth: 320, clientWidth: 305 }, mirror, 10)
    expect(mirror).toEqual({ scrollTop: 55, scrollLeft: 3, style: { paddingRight: '25px' } })
    synchronizePromptScroll({ scrollTop: 23, scrollLeft: 0, offsetWidth: 500, clientWidth: 500 }, mirror, 12)
    expect(mirror).toEqual({ scrollTop: 23, scrollLeft: 0, style: { paddingRight: '12px' } })
  })
})
