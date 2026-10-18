import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportSessionMarkdown, sessionMarkdownFileName } from './session-markdown-export'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-session-markdown-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('sessionMarkdownFileName', () => {
  it('replaces characters Windows rejects and keeps the first eight id characters', () => {
    expect(sessionMarkdownFileName(' a<b>c:d"e/f\\g|h?i*j\u0001 ', 'Codex-session', '0123456789abcdef'))
      .toBe('a_b_c_d_e_f_g_h_i_j_-01234567.md')
  })

  it('caps the title part at 80 characters', () => {
    expect(sessionMarkdownFileName('长'.repeat(100), 'claude-session', 'abc')).toBe(`${'长'.repeat(80)}-abc.md`)
  })

  it('falls back to the given stem when the title is blank', () => {
    expect(sessionMarkdownFileName('', 'Codex-session', 'session-1')).toBe('Codex-session-session-.md')
    expect(sessionMarkdownFileName('   ', 'grok-session', 'abcdef1234')).toBe('grok-session-abcdef12.md')
  })
})

describe('exportSessionMarkdown', () => {
  it('collapses long headings, labels unknown roles and leaves out empty facts', async () => {
    const outputPath = path.join(temporaryDirectory(), 'out.md')

    const exported = await exportSessionMarkdown({
      destinationPath: outputPath,
      fileName: 'unused.md',
      title: `标题${'x'.repeat(200)}`,
      identity: [],
      cwd: '',
      model: '',
      assistantLabel: 'AI',
      writeMessages: async (write) => {
        await write({ role: '', text: '没有角色' })
        await write({ role: 'assistant', text: '助手' })
        return { messages: 2, truncated: false }
      },
    })

    expect(exported).toEqual({ outputPath, messages: 2, truncated: false })
    expect(fs.readFileSync(outputPath, 'utf8')).toBe([
      `# 标题${'x'.repeat(158)}…`,
      '',
      '',
      '---',
      '',
      '## 其他',
      '',
      '没有角色',
      '',
      '## AI',
      '',
      '助手',
      '',
      '',
    ].join('\n'))
  })

  it('keeps an existing export and leaves no temporary file when reading the session fails', async () => {
    const directory = temporaryDirectory()
    const outputPath = path.join(directory, 'session.md')
    fs.writeFileSync(outputPath, '上一次导出的内容', 'utf8')

    await expect(exportSessionMarkdown({
      destinationPath: outputPath,
      fileName: 'unused.md',
      title: '会话',
      identity: [['会话 ID', 'one']],
      assistantLabel: 'Codex',
      writeMessages: async (write) => {
        await write({ role: 'user', text: '写到一半' })
        throw new Error('读不下去了')
      },
    })).rejects.toThrow('读不下去了')

    expect(fs.readFileSync(outputPath, 'utf8')).toBe('上一次导出的内容')
    expect(fs.readdirSync(directory)).toEqual(['session.md'])
  })
})
