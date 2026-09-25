import { describe, expect, it } from 'vitest'
import { formatRecentTime, recentResumeHint, recentSessionSubtitle, recentToolName } from './recent-display'

function seconds(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime() / 1000
}

describe('recent-display', () => {
  const now = new Date(2026, 8, 25, 10, 30).getTime()

  it('says 刚刚 for the last minute', () => {
    expect(formatRecentTime(now / 1000 - 20, now)).toBe('刚刚')
  })

  it('names today and yesterday by calendar day, not by 24 hours', () => {
    expect(formatRecentTime(seconds(2026, 9, 25, 0, 5), now)).toBe('今天 00:05')
    expect(formatRecentTime(seconds(2026, 9, 24, 23, 50), now)).toBe('昨天 23:50')
    expect(formatRecentTime(seconds(2026, 9, 24, 14, 5), now)).toBe('昨天 14:05')
  })

  it('shows the date for older entries and adds the year for past years', () => {
    expect(formatRecentTime(seconds(2026, 9, 21, 14, 5), now)).toBe('9月21日')
    expect(formatRecentTime(seconds(2026, 1, 1, 8), now)).toBe('1月1日')
    expect(formatRecentTime(seconds(2025, 12, 3, 9), now)).toBe('2025年12月3日')
  })

  it('treats a slightly future timestamp on the same day as today', () => {
    expect(formatRecentTime(seconds(2026, 9, 25, 10, 45), now)).toBe('今天 10:45')
  })

  it('keeps the old wording when the time is missing', () => {
    expect(formatRecentTime(null, now)).toBe('时间未记录')
    expect(formatRecentTime(Number.NaN, now)).toBe('时间未记录')
  })

  it('names the tool and only the folder name', () => {
    expect(recentToolName('codex')).toBe('Codex CLI')
    expect(recentSessionSubtitle({ provider: 'codex', cwd: 'C:\\Users\\peaker\\my-project\\' })).toBe('Codex CLI · my-project')
    expect(recentSessionSubtitle({ provider: 'claude', cwd: '/Users/alex/work/app' })).toBe('Claude Code · app')
    expect(recentSessionSubtitle({ provider: 'gemini', cwd: '' })).toBe('Gemini CLI')
  })

  it('tells which tool the resume button opens', () => {
    expect(recentResumeHint({ provider: 'codex', cwd: 'C:\\work\\my-project' })).toBe('用 Codex CLI 接着 my-project 里最近的一条对话')
    expect(recentResumeHint({ provider: 'claude', cwd: 'C:\\work\\gone', cwdExists: false })).toBe('这个文件夹已经不在了，接不上上次的对话')
  })
})
