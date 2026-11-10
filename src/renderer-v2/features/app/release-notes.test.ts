import { describe, expect, it } from 'vitest'
import { releaseNoteItems, releaseNotesSection } from './release-notes'

const base = { availableVersion: null, currentVersion: '0.2.9', releaseNotesText: null, installedRelease: null }

describe('release notes section on the updates page', () => {
  it('keeps describing the pending version whenever there is one', () => {
    const section = releaseNotesSection({
      ...base,
      availableVersion: '0.3.0',
      releaseNotesText: '- 新版本的改动',
      installedRelease: { justUpdated: true, previousVersion: '0.2.8', notes: ['本版改动'] },
    })
    expect(section).toEqual({ title: 'v0.3.0 更新内容', items: ['新版本的改动'], text: '' })
  })

  it('keeps the old paragraph for pending notes that are not a list', () => {
    expect(releaseNotesSection({ ...base, availableVersion: '0.3.0', releaseNotesText: '修好了几处小问题。' }))
      .toEqual({ title: 'v0.3.0 更新内容', items: null, text: '修好了几处小问题。' })
    expect(releaseNotesSection({ ...base, availableVersion: '0.3.0' })).toEqual({ title: 'v0.3.0 更新内容', items: null, text: '暂无更新说明。' })
  })

  it('lists the bundled changes of the running version when nothing newer is pending', () => {
    // 不论是不是刚更新完：更新页一直能看到当前这一版改了什么，断网也在。
    const section = releaseNotesSection({ ...base, installedRelease: { justUpdated: false, previousVersion: '0.2.9', notes: ['一条', '两条'] } })
    expect(section).toEqual({ title: 'v0.2.9 更新了什么', items: ['一条', '两条'], text: '' })
  })

  it('falls back to the old sentence when the build carried no notes', () => {
    expect(releaseNotesSection({ ...base, installedRelease: { justUpdated: true, previousVersion: null, notes: null } }))
      .toEqual({ title: '更新内容', items: null, text: '暂无更新说明。' })
    // 旧快照没有 installedRelease 字段。
    expect(releaseNotesSection({ availableVersion: null, currentVersion: '0.2.9', releaseNotesText: null }).text).toBe('暂无更新说明。')
    expect(releaseNotesSection(null).text).toBe('暂无更新说明。')
  })
})

describe('release note items from the update feed', () => {
  // electron-builder 把整份 release-notes.md 写进 latest.yml：要装的那一版后面跟着前几版。
  const feed = [
    '0.2.24',
    '',
    '- 第一条改动，说得很长，在源文件里',
    '  折了一行；英文 Claude',
    '  Code 之间补一个空格。',
    '- 第二条带 `代码` 写法。',
    '',
    '0.2.23',
    '',
    '- 上一版的改动',
  ].join('\n')

  it('lists only the section of the version about to be installed, one change per line', () => {
    expect(releaseNoteItems(feed, '0.2.24')).toEqual([
      '第一条改动，说得很长，在源文件里折了一行；英文 Claude Code 之间补一个空格。',
      '第二条带 「代码」 写法。',
    ])
  })

  it('picks the matching section when it is not the first one, and the first one when none matches', () => {
    expect(releaseNoteItems(feed, '0.2.23')).toEqual(['上一版的改动'])
    expect(releaseNoteItems(feed, '0.2.25')).toEqual(releaseNoteItems(feed, '0.2.24'))
  })

  it('treats notes without any version line as the pending version', () => {
    expect(releaseNoteItems('- 一条\r\n- 两条', '0.3.0')).toEqual(['一条', '两条'])
  })

  it('returns nothing to list for empty or non-list notes', () => {
    expect(releaseNoteItems(null, '0.3.0')).toBeNull()
    expect(releaseNoteItems('', '0.3.0')).toBeNull()
    expect(releaseNoteItems('0.3.0\n\n修好了几处小问题。', '0.3.0')).toBeNull()
    expect(releaseNoteItems('0.3.0\n\n-   \n', '0.3.0')).toBeNull()
  })
})
