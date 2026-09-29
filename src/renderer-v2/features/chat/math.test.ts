import { describe, expect, it } from 'vitest'
import { prepareChatMath, readChatMath, renderChatMath } from './math'

function formulas(content: string) {
  const prepared = prepareChatMath(content)
  return [...prepared.matchAll(/(`+) (\uE000.*?) \1(?!`)/g)].map((match) => readChatMath(match[2]))
}

describe('chat math', () => {
  it('finds inline and display formulas in every common spelling', () => {
    expect(formulas('能量 $E=mc^2$ 守恒').map((math) => math?.tex)).toEqual(['E=mc^2'])
    expect(formulas('$$\\frac{a}{b}$$')).toMatchObject([{ kind: 'display', tex: '\\frac{a}{b}', display: true }])
    expect(formulas('用 \\(x_1 + x_2\\) 表示')).toMatchObject([{ kind: 'paren', tex: 'x_1 + x_2', display: false }])
    expect(formulas('\\[\n\\sum_{i=1}^n i\n\\]')).toMatchObject([{ kind: 'bracket', tex: '\\sum_{i=1}^n i', display: true }])
  })

  it('leaves money amounts alone', () => {
    for (const text of ['余额只剩 $5，充 $10', '$5 到 $10', '花了 $5，又花了$10', '价格 $ 5 和 $ 6', 'costs $$$ and $$$ more', 'US$20']) expect(prepareChatMath(text)).toBe(text)
    expect(formulas('$5 and $x$').map((math) => math?.tex)).toEqual(['x'])
  })

  it('does not touch code blocks, inline code or escaped dollars', () => {
    const text = 'Run `echo $HOME$` then:\n\n```bash\necho $PATH$x$\n```\n\n    ```\n    $a$\n    ```\n\nPrice \\$5 and \\$6'
    expect(prepareChatMath(text)).toBe(text)
    const unfinished = '```\n$a$\n'
    expect(prepareChatMath(unfinished)).toBe(unfinished)
  })

  it('does not join formulas across paragraphs or unfinished streams', () => {
    expect(prepareChatMath('$a\n\nb$')).toBe('$a\n\nb$')
    expect(prepareChatMath('$$a\n\nb$$')).toBe('$$a\n\nb$$')
    expect(prepareChatMath('正在写 $\\frac{a')).toBe('正在写 $\\frac{a')
  })

  it('keeps multi-line display math on one line so markdown cannot read it as a list', () => {
    const prepared = prepareChatMath('$$\na = b\n- c\n$$')
    expect(prepared.split('\n')).toHaveLength(1)
    expect(formulas('$$\na = b\n- c\n$$')[0]?.tex).toBe('a = b - c')
  })

  it('wraps formulas containing backticks in a longer fence', () => {
    expect(formulas('\\(a`b\\)')[0]?.tex).toBe('a`b')
  })

  it('leaves replies that already carry the marker untouched', () => {
    expect(prepareChatMath('\uE000 $x$')).toBe('\uE000 $x$')
    expect(readChatMath('plain code')).toBeNull()
    expect(readChatMath(['x'])).toBeNull()
  })

  it('renders MathML and keeps the source when a formula cannot be read', () => {
    const html = renderChatMath({ kind: 'dollar', tex: '\\frac{a}{b}', display: false, source: '$\\frac{a}{b}$' })
    expect(html).toContain('<math')
    expect(html).toContain('<mfrac>')
    expect(html).not.toContain('katex-html')
    expect(renderChatMath({ kind: 'dollar', tex: '\\frac{a', display: false, source: '$\\frac{a$' })).toBeNull()
  })

  it('never emits links or raw markup from formula text', () => {
    const html = renderChatMath({ kind: 'dollar', tex: '\\href{javascript:alert(1)}{x} <img src=x onerror=alert(1)>', display: false, source: '' }) ?? ''
    expect(html).not.toMatch(/href="|<img|<a[ >]/i)
    expect(renderChatMath({ kind: 'dollar', tex: '\\htmlClass{x}{y}', display: false, source: '' }) ?? '').not.toContain('class="x"')
  })
})
