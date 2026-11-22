import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  STANDING_INSTRUCTIONS_MARKER,
  STANDING_INSTRUCTIONS_MARKER_BROKEN,
  STANDING_INSTRUCTIONS_NOT_UTF8,
  applyStandingInstructions,
  buildStandingInstructionsContent,
  standingInstructionsFile,
  validateStandingInstructions,
  withoutStandingInstructions,
} from './standing-instructions'

const temporaryRoots: string[] = []

function temporaryRoots_(): { userHome: string; codexHome: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-standing-'))
  temporaryRoots.push(root)
  return { userHome: root, codexHome: path.join(root, '.codex') }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function written(existing: string | null, text: string): string {
  const next = buildStandingInstructionsContent(existing, text)
  if (typeof next !== 'string') throw new Error(`expected new content, got ${JSON.stringify(next)}`)
  return next
}

describe('standing-instructions', () => {
  it('appends a marked block after what the customer wrote, separated by one blank line', () => {
    const next = written('# 我的规矩\n\n- 用 pnpm\n', '回答简短一点')
    expect(next.startsWith('# 我的规矩\n\n- 用 pnpm\n\n<!-- ')).toBe(true)
    expect(next).toContain(`${STANDING_INSTRUCTIONS_MARKER}（开始）`)
    expect(next).toContain('\n回答简短一点\n')
    expect(next.endsWith(`<!-- ${STANDING_INSTRUCTIONS_MARKER}（结束） -->\n`)).toBe(true)
  })

  it('replaces only the marked lines on the next save and leaves both sides untouched', () => {
    const first = written('上面是我的\r\n', '旧的嘱咐')
    const customer = `${first}下面也是我的\n`
    const next = written(customer, '新的嘱咐\n第二行')
    expect(next.startsWith('上面是我的\r\n\r\n')).toBe(true)
    expect(next.endsWith('下面也是我的\n')).toBe(true)
    expect(next).toContain('新的嘱咐\r\n第二行')
    expect(next).not.toContain('旧的嘱咐')
  })

  it('reports no change when the block already says the same thing', () => {
    const first = written('mine\n', '同一句')
    expect(buildStandingInstructionsContent(first, '同一句')).toBeNull()
    expect(buildStandingInstructionsContent(null, '')).toBeNull()
    expect(buildStandingInstructionsContent('mine\n', '')).toBeNull()
  })

  it('takes the block and its spacer line back out when cleared, restoring the original file', () => {
    const original = '# 我的规矩\n\n- 用 pnpm\n'
    expect(written(written(original, '一段话'), '')).toBe(original)
  })

  it('removes the whole file when the block was all there was', () => {
    expect(buildStandingInstructionsContent(written(null, '一段话'), '')).toEqual({ remove: true })
  })

  it('keeps a byte order mark at the start of the file', () => {
    const next = written('﻿# 规矩\n', '一段话')
    expect(next.startsWith('﻿# 规矩\n\n')).toBe(true)
    expect(next.indexOf('﻿', 1)).toBe(-1)
  })

  it.each([
    ['only a start marker', `mine\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（开始） -->\nx\n`],
    ['only an end marker', `mine\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（结束） -->\n`],
    ['end before start', `<!-- ${STANDING_INSTRUCTIONS_MARKER}（结束） -->\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（开始） -->\n`],
    ['two blocks', `${'x'}\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（开始） -->\na\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（结束） -->\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（开始） -->\nb\n<!-- ${STANDING_INSTRUCTIONS_MARKER}（结束） -->\n`],
  ])('refuses to guess when there is %s', (_label, existing) => {
    expect(() => buildStandingInstructionsContent(existing, '新的')).toThrow(STANDING_INSTRUCTIONS_MARKER_BROKEN)
  })

  it('strips just the block for callers that judge what else is in the file', () => {
    const block = written(null, '一段话')
    expect(withoutStandingInstructions(block)).toBe('')
    expect(withoutStandingInstructions(`a\n${block}b\n`)).toBe('a\nb\n')
    expect(withoutStandingInstructions('no block\n')).toBe('no block\n')
  })

  it('validates what the renderer sends', () => {
    expect(validateStandingInstructions('  回答简短一点\r\n我是做外贸的  ')).toBe('回答简短一点\n我是做外贸的')
    expect(validateStandingInstructions('')).toBe('')
    expect(() => validateStandingInstructions(42)).toThrow('长期嘱咐格式错误')
    expect(() => validateStandingInstructions('字'.repeat(2001))).toThrow('最多 2000 个字')
    expect(validateStandingInstructions('字'.repeat(2000))).toHaveLength(2000)
    expect(() => validateStandingInstructions('a\u0000b')).toThrow('不支持的字符')
    expect(() => validateStandingInstructions(`x ${STANDING_INSTRUCTIONS_MARKER}（开始）`)).toThrow('标记')
  })

  it('writes Codex AGENTS.override.md when it exists, because Codex then ignores AGENTS.md', () => {
    const roots = temporaryRoots_()
    expect(standingInstructionsFile('codex', roots)).toBe(path.join(roots.codexHome, 'AGENTS.md'))
    fs.mkdirSync(roots.codexHome, { recursive: true })
    fs.writeFileSync(path.join(roots.codexHome, 'AGENTS.override.md'), 'mine\n')
    expect(standingInstructionsFile('codex', roots)).toBe(path.join(roots.codexHome, 'AGENTS.override.md'))
    expect(standingInstructionsFile('claude', roots)).toBe(path.join(roots.userHome, '.claude', 'CLAUDE.md'))
    expect(standingInstructionsFile('grok', roots)).toBe(path.join(roots.userHome, '.grok', 'AGENTS.md'))
  })

  it('writes each tool file atomically, creating it when missing and keeping a backup of the old one', () => {
    const roots = temporaryRoots_()
    const claude = path.join(roots.userHome, '.claude', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(claude), { recursive: true })
    fs.writeFileSync(claude, '# 我自己的\n')

    expect(applyStandingInstructions('claude', '回答简短一点', roots)).toEqual({ provider: 'claude', outcome: 'written' })
    expect(applyStandingInstructions('grok', '回答简短一点', roots)).toEqual({ provider: 'grok', outcome: 'written' })
    expect(applyStandingInstructions('claude', '回答简短一点', roots)).toEqual({ provider: 'claude', outcome: 'unchanged' })

    const content = fs.readFileSync(claude, 'utf8')
    expect(content.startsWith('# 我自己的\n\n')).toBe(true)
    expect(content).toContain('回答简短一点')
    expect(fs.readdirSync(path.dirname(claude)).some((name) => name.startsWith('CLAUDE.md.bak.'))).toBe(true)
    expect(fs.readFileSync(path.join(roots.userHome, '.grok', 'AGENTS.md'), 'utf8')).toContain('回答简短一点')

    expect(applyStandingInstructions('claude', '', roots)).toEqual({ provider: 'claude', outcome: 'removed' })
    expect(fs.readFileSync(claude, 'utf8')).toBe('# 我自己的\n')
    expect(applyStandingInstructions('grok', '', roots)).toEqual({ provider: 'grok', outcome: 'removed' })
    expect(fs.existsSync(path.join(roots.userHome, '.grok', 'AGENTS.md'))).toBe(false)
  })

  it('leaves a file that is not UTF-8 alone and says why', () => {
    const roots = temporaryRoots_()
    const claude = path.join(roots.userHome, '.claude', 'CLAUDE.md')
    fs.mkdirSync(path.dirname(claude), { recursive: true })
    // 「中文」in GBK.
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    fs.writeFileSync(claude, gbk)
    expect(applyStandingInstructions('claude', '一段话', roots)).toEqual({ provider: 'claude', outcome: 'skipped', reason: STANDING_INSTRUCTIONS_NOT_UTF8 })
    expect(fs.readFileSync(claude)).toEqual(gbk)
  })

  it('reports a linked instructions file as a failure without writing through it', () => {
    const roots = temporaryRoots_()
    const outside = path.join(roots.userHome, 'outside.md')
    fs.writeFileSync(outside, 'outside\n')
    const grok = path.join(roots.userHome, '.grok', 'AGENTS.md')
    fs.mkdirSync(path.dirname(grok), { recursive: true })
    try {
      fs.symlinkSync(outside, grok)
    } catch {
      return
    }
    const result = applyStandingInstructions('grok', '一段话', roots)
    expect(result.outcome).toBe('failed')
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside\n')
  })

  describe('standing instructions with random inputs', () => {
    const line = fc.string({ unit: fc.constantFrom(...'ab 中文#-*<>!'.split(''), '\r\n', '\n', '<!--', '-->'), maxLength: 30 })
    const instructions = fc.string({ unit: fc.constantFrom(...'xy 好的。-'.split(''), '\n'), maxLength: 20 }).map((text) => text.trim())

    it('never changes a character outside the block, and clearing gives the original back', () => {
      fc.assert(fc.property(fc.option(line, { nil: null }), instructions, instructions, (existing, first, second) => {
        if (existing !== null && existing.includes(STANDING_INSTRUCTIONS_MARKER)) return
        const once = buildStandingInstructionsContent(existing, first)
        const afterFirst = once === null ? existing : typeof once === 'string' ? once : null
        if (afterFirst !== null) {
          // Whatever the customer wrote is still there, byte for byte, in front of the block.
          if (existing !== null && existing.trim() !== '') expect(afterFirst.startsWith(existing)).toBe(true)
        }
        const twice = buildStandingInstructionsContent(afterFirst, second)
        const afterSecond = twice === null ? afterFirst : typeof twice === 'string' ? twice : null
        if (existing !== null && existing.trim() !== '' && afterSecond !== null) expect(afterSecond.startsWith(existing)).toBe(true)
        const cleared = buildStandingInstructionsContent(afterSecond, '')
        const afterClear = cleared === null ? afterSecond : typeof cleared === 'string' ? cleared : null
        if (existing === null || existing.trim() === '') {
          expect(afterClear === null || afterClear === existing).toBe(true)
        } else {
          expect(afterClear).toBe(existing)
        }
      }), { numRuns: 300 })
    })
  })
})
