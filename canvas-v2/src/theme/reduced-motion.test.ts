import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// 「减少动画」那两条规则原来写 transition-duration: 0.01ms。transition-property 默认是 all，
// 所以本来没有过渡的元素也给每个属性开了一段过渡：换一次皮肤几百段一起跑，换完马上读到的
// 底色还是上一套，平移画布时位置晚两帧左右才画上。桌面的换皮肤用例因此时红时绿（底色一个
// 跟上了、一个没跟上），见桌面 docs/CI-RERUN-LEDGER.md 2026-11-20、11-21 两行。
const kernelRoot = path.join(import.meta.dirname, '..', '..')

// 只扫内核自己的 src/ 和 shared/：同步到桌面后这一层可能还有 node_modules 之类，不归内核管。
function kernelStyleSheets(): Array<{ file: string; source: string }> {
  return ['src', 'shared'].flatMap((directory) => fs.readdirSync(path.join(kernelRoot, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.css'))
    .map((file) => path.join(directory, file)))
    .sort()
    .map((file) => ({ file: file.replaceAll('\\', '/'), source: fs.readFileSync(path.join(kernelRoot, file), 'utf8') }))
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

// Innermost rule blocks only: an @media wrapper is skipped and its inner rules
// are matched on their own, which is all this check needs.
function rules(source: string): Array<{ selectors: string[]; body: string }> {
  return [...withoutComments(source).matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()).filter(Boolean),
    body: match[2],
  }))
}

// A selector whose subject is the universal selector reaches every element of
// the page, e.g. `*`, `*::before` or `[data-reduced-motion='true'] *::after`.
function targetsEveryElement(selector: string): boolean {
  return /(^|[\s>+~])\*(::?[\w-]+)?$/.test(selector)
}

function universalRules() {
  return kernelStyleSheets().flatMap(({ file, source }) => rules(source)
    .filter((rule) => rule.selectors.some(targetsEveryElement))
    .map((rule) => ({ file, ...rule })))
}

describe('reduced motion', () => {
  it('never switches on transitions for every element', () => {
    const offenders = universalRules()
      .filter((rule) => /transition-(duration|delay|property)\s*:/.test(rule.body))
      .map((rule) => `${rule.file}: ${rule.selectors.join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('turns transitions off and shortens animations for both the host switch and the system setting', () => {
    const reduced = universalRules().filter((rule) => /animation-duration\s*:\s*0\.01ms/.test(rule.body))
    expect(reduced.map((rule) => rule.file).sort()).toEqual(['src/theme.css', 'src/theme/brand-appearance.css'])
    expect(reduced.find((rule) => rule.file === 'src/theme/brand-appearance.css')?.selectors).toEqual([
      "[data-reduced-motion='true'] *",
      "[data-reduced-motion='true'] *::before",
      "[data-reduced-motion='true'] *::after",
    ])
    for (const rule of reduced) {
      expect(rule.body).toMatch(/transition\s*:\s*none\s*!important/)
      expect(rule.body).toMatch(/animation-iteration-count\s*:\s*1\s*!important/)
      expect(rule.body).toMatch(/scroll-behavior\s*:\s*auto\s*!important/)
    }
    expect(fs.readFileSync(path.join(kernelRoot, 'src', 'theme.css'), 'utf8')).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{/)
  })
})
