import { describe, expect, it } from 'vitest'
import {
  codexDesktopKnownBrokenVersions,
  codexDesktopKnownIssueLaunchSentence,
  codexDesktopKnownIssueMarker,
  codexDesktopKnownIssueNotice,
  resolveCodexDesktopKnownIssue,
} from './codex-desktop-known-issues'
import { codexDesktopTechnicalWords } from './codex-desktop-install-failure'

describe('codex desktop known issues', () => {
  it('lists the version that cannot start on Windows', () => {
    expect(codexDesktopKnownBrokenVersions).toContain('26.924.2738.0')
  })

  it('matches the store package version or the shorter app version', () => {
    expect(resolveCodexDesktopKnownIssue(['26.924.2738.0', null])).toBe('26.924.2738.0')
    expect(resolveCodexDesktopKnownIssue([null, '26.924.2738'])).toBe('26.924.2738.0')
    expect(resolveCodexDesktopKnownIssue(['v26.924.2738'])).toBe('26.924.2738.0')
  })

  it('stays silent for other versions or when no version is known', () => {
    expect(resolveCodexDesktopKnownIssue(['26.925.1000.0', '26.925.1000'])).toBeNull()
    expect(resolveCodexDesktopKnownIssue(['26.924.27380.0'])).toBeNull()
    expect(resolveCodexDesktopKnownIssue(['26.924.2738.1'])).toBeNull()
    expect(resolveCodexDesktopKnownIssue([null, undefined, ' '])).toBeNull()
    expect(resolveCodexDesktopKnownIssue([])).toBeNull()
  })

  it('accepts an injected list so the table can be emptied once upstream is fixed', () => {
    expect(resolveCodexDesktopKnownIssue(['26.924.2738.0'], [])).toBeNull()
    expect(resolveCodexDesktopKnownIssue(['27.1.0.0'], ['27.1'])).toBe('27.1')
  })

  it('writes both sentences in plain words and points to the command-line Codex', () => {
    const notice = codexDesktopKnownIssueNotice('26.924.2738.0')
    const sentence = codexDesktopKnownIssueLaunchSentence('26.924.2738.0')
    expect(notice).toContain('26.924.2738.0')
    expect(notice).toContain('Codex 命令行版')
    expect(sentence).toContain(codexDesktopKnownIssueMarker)
    expect(sentence).toContain('不是星芒')
    expect(sentence).toContain('「改用 Codex 命令行版」')
    for (const text of [notice, sentence]) {
      expect(text).not.toMatch(codexDesktopTechnicalWords)
      expect(text).not.toMatch(/CLI|npm|PATH|Appx|商店包/i)
    }
  })
})
