import { describe, expect, it } from 'vitest'
import {
  approvalTitle,
  formatApprovalText,
  normalizePairingAttempt,
  parseRemoteCommand,
  redactRemoteText,
  splitRemoteText,
  statusMessage,
  truncateRemoteText,
} from './codex-remote-text'

describe('codex-remote-text', () => {
  it('recognises the plain commands with or without a slash', () => {
    expect(parseRemoteCommand('新对话', false)).toEqual({ kind: 'new-thread' })
    expect(parseRemoteCommand(' /停止 ', false)).toEqual({ kind: 'stop' })
    expect(parseRemoteCommand('／状态', false)).toEqual({ kind: 'status' })
    expect(parseRemoteCommand('帮助', true)).toEqual({ kind: 'help' })
  })

  it('treats a sentence that merely contains a command word as a prompt', () => {
    expect(parseRemoteCommand('停止服务器然后重启', false)).toEqual({ kind: 'prompt', text: '停止服务器然后重启' })
  })

  it('reads approve and decline only while something is waiting', () => {
    expect(parseRemoteCommand('同意', true)).toEqual({ kind: 'approval', decision: 'accept' })
    expect(parseRemoteCommand('拒绝 3', true)).toEqual({ kind: 'approval', decision: 'decline', approvalId: '3' })
    expect(parseRemoteCommand('/同意第 02 条', true)).toEqual({ kind: 'approval', decision: 'accept', approvalId: '2' })
    expect(parseRemoteCommand('同意', false)).toEqual({ kind: 'prompt', text: '同意' })
    expect(parseRemoteCommand('同意这个方案吗', true)).toEqual({ kind: 'prompt', text: '同意这个方案吗' })
  })

  it('accepts a pairing code only as the whole message', () => {
    expect(normalizePairingAttempt('123 456')).toBe('123456')
    expect(normalizePairingAttempt('配对 123456')).toBeNull()
    expect(normalizePairingAttempt('1234567')).toBeNull()
  })

  it('redacts named secrets, key shapes and the home directory', () => {
    const text = 'key=abcdef123456 token sk-live0123456789 at /Users/alice/project and Bearer zzzzzzzzzz'
    const redacted = redactRemoteText(text, { secrets: ['abcdef123456'], homeDirectory: '/Users/alice', platform: 'darwin' })
    expect(redacted).not.toContain('abcdef123456')
    expect(redacted).not.toContain('sk-live0123456789')
    expect(redacted).not.toContain('zzzzzzzzzz')
    expect(redacted).not.toContain('/Users/alice')
    expect(redacted).toContain('[已隐去]')
  })

  it('ignores secrets too short to redact safely', () => {
    expect(redactRemoteText('a b c', { secrets: ['a'], homeDirectory: '' })).toBe('a b c')
  })

  it('splits long text at line breaks and caps the number of messages', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n')
    const chunks = splitRemoteText(text, 200, 3)
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    expect(chunks[0].endsWith('x')).toBe(true)
    expect(chunks[2]).toContain('没有发完')
  })

  it('returns nothing for empty text and one chunk for short text', () => {
    expect(splitRemoteText('  ', 100, 3)).toEqual([])
    expect(splitRemoteText('hi', 100, 3)).toEqual(['hi'])
  })

  it('hard-cuts a line longer than the limit', () => {
    const chunks = splitRemoteText('y'.repeat(250), 100, 5)
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50])
  })

  it('formats approvals with the reply words and an optional cwd', () => {
    const text = formatApprovalText({ approvalId: '2', nonce: 'nonce-of-two', kind: 'command', summary: 'npm test', cwd: '~/project' })
    expect(text).toContain('Codex 想运行命令（第 2 条）')
    expect(text).not.toContain('nonce-of-two')
    expect(text).toContain('npm test')
    expect(text).toContain('在：~/project')
    expect(text).toContain('回「同意 2」或「拒绝 2」')
  })

  it('titles each kind of approval for what Codex wants to do', () => {
    expect(approvalTitle('command')).toBe('Codex 想运行命令')
    expect(approvalTitle('terminal-input')).toBe('Codex 想往正在运行的程序里输入')
    expect(approvalTitle('network')).toBe('Codex 想连网站')
    expect(formatApprovalText({ approvalId: '4', nonce: 'nonce-of-four', kind: 'network', summary: 'registry.npmjs.org' }))
      .toBe('Codex 想连网站（第 4 条）：\nregistry.npmjs.org\n回「同意 4」或「拒绝 4」。')
  })

  it('describes the current state', () => {
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 0 })).toContain('正在处理')
    expect(statusMessage({ workspace: '~/p', running: true, pendingApprovals: 2 })).toContain('等你同意 2 条')
  })

  it('truncates with an ellipsis', () => {
    expect(truncateRemoteText('abcdef', 4)).toBe('abc…')
    expect(truncateRemoteText('abc', 4)).toBe('abc')
  })
})
