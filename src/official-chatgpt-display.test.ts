import { describe, expect, it } from 'vitest'
import {
  formatOfficialDateTime,
  formatOfficialResetLabel,
  shortOfficialWindowLabel,
} from './official-chatgpt-display'

describe('official ChatGPT date labels', () => {
  it('formats renewal and reset times as month/day plus a relative phrase', () => {
    const now = new Date('2026-08-24T11:32:00.000Z')
    expect(formatOfficialDateTime('2026-09-22T11:32:00.000Z', now)).toMatch(/09\/22 \d{2}:\d{2} · 29天后/)
    expect(formatOfficialDateTime('2026-08-24T07:32:00.000Z', now)).toMatch(/\d{2}\/\d{2} \d{2}:\d{2} · 4小时前/)
    expect(formatOfficialResetLabel('2026-09-22T11:32:00.000Z', now)).toBe('29天后')
  })

  it('shortens quota window names for the dashboard cards', () => {
    expect(shortOfficialWindowLabel('5 小时限额')).toBe('5 小时')
    expect(shortOfficialWindowLabel('周限额')).toBe('周限额')
    expect(shortOfficialWindowLabel('GPT-5.3-Codex-Spark 5 小时限额')).toBe('Spark · 5小时')
    expect(shortOfficialWindowLabel('GPT-5.3-Codex-Spark 周限额')).toBe('Spark · 周')
  })
})
