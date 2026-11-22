import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { V2Bridge } from '../../types'
import { BackupCard, backupDescription, backupDetail, backupReasonTag, backupSizeText, brokenBackupDescription, visibleBackups } from './BackupCard'

describe('backup card wording', () => {
  it('writes sizes in KB everywhere, the preview included', () => {
    expect(backupSizeText(3277)).toBe('3.2 KB')
    expect(backupSizeText(0)).toBe('0.0 KB')
    expect(backupSizeText(-5)).toBe('0.0 KB')
  })

  it('shortens the reason tag and lets a failed check win over the reason', () => {
    expect(backupReasonTag({ valid: true, reason: 'manual' })).toBe('手工')
    expect(backupReasonTag({ valid: true, reason: 'pre-restore' })).toBe('恢复前')
    expect(backupReasonTag({ valid: true, reason: 'pre-save' })).toBe('配置前')
    expect(backupReasonTag({ valid: false, reason: 'manual' })).toBe('校验失败')
  })

  // 原因只说得出改配置前和恢复前两种，手工备份没有后半句（字表批09）。
  it('names the tool, the size and why it was made', () => {
    expect(backupDescription({ provider: 'codex', reason: 'pre-save', totalSize: 3277 })).toBe('Codex CLI 配置，3.2 KB，改 Codex CLI 配置前自动备份')
    expect(backupDescription({ provider: 'claude', reason: 'pre-restore', totalSize: 1024 })).toBe('Claude Code 配置，1.0 KB，恢复前自动备份')
    expect(backupDescription({ provider: 'grok', reason: 'manual', totalSize: 2048 })).toBe('Grok CLI 配置，2.0 KB')
    expect(backupDetail({ provider: 'grok', reason: 'manual', totalSize: 2048 })).toBe('2.0 KB')
  })
})

// R2-2：坏的那份原来跟已下线的工具一起被筛掉，原因和删除入口一起不见了。
describe('broken backups', () => {
  const rows = [
    { id: 'ok', provider: 'codex' as const, valid: true },
    { id: 'torn-codex', provider: 'codex' as const, valid: false },
    { id: 'unreadable', provider: null, valid: false },
    { id: 'old-gemini', provider: 'gemini' as const, valid: true },
    { id: 'torn-gemini', provider: 'gemini' as const, valid: false },
  ]

  it('keeps a broken backup in the list, under its own tool when the tool is known', () => {
    expect(visibleBackups(rows, 'all').map((row) => row.id)).toEqual(['ok', 'torn-codex', 'unreadable'])
    expect(visibleBackups(rows, 'codex').map((row) => row.id)).toEqual(['ok', 'torn-codex'])
    expect(visibleBackups(rows, 'claude')).toEqual([])
  })

  it('says a broken backup cannot be used and can be deleted, naming the tool when known', () => {
    expect(brokenBackupDescription('codex')).toBe('Codex CLI 配置，此备份不可用，可删除')
    expect(brokenBackupDescription('claude')).toBe('Claude Code 配置，此备份不可用，可删除')
    expect(brokenBackupDescription(null)).toBe('此备份不可用，可删除')
    expect(brokenBackupDescription('gemini')).toBe('此备份不可用，可删除')
  })
})

describe('backup card', () => {
  it('puts 立即备份 in the card head and filters by tool without a search box', () => {
    const markup = renderToStaticMarkup(<BackupCard api={{} as V2Bridge} />)
    expect(markup).toContain('data-testid="page-backups"')
    expect(markup).toContain('<h2>工具配置备份</h2>')
    expect(markup).toMatch(/data-testid="backups-create"[^>]*>.*?立即备份/)
    expect(markup).toContain('全部工具')
    // 搜索框、「重新加载」、单独的「马上备份」卡都去掉了。
    expect(markup).not.toContain('搜索日期')
    expect(markup).not.toContain('重新加载')
    expect(markup).not.toContain('马上备份')
  })
})
