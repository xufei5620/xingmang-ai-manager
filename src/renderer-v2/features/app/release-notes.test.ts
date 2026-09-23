import { describe, expect, it } from 'vitest'
import { releaseNotesSection } from './release-notes'

const base = { availableVersion: null, currentVersion: '0.2.9', releaseNotesText: null, installedRelease: null }

describe('release notes section on the updates page', () => {
  it('keeps describing the pending version whenever there is one', () => {
    const section = releaseNotesSection({
      ...base,
      availableVersion: '0.3.0',
      releaseNotesText: '- 新版本的改动',
      installedRelease: { justUpdated: true, previousVersion: '0.2.8', notes: ['本版改动'] },
    })
    expect(section).toEqual({ title: '0.3.0 更新内容', items: null, text: '- 新版本的改动' })
  })

  it('lists the bundled changes of the running version when nothing newer is pending', () => {
    // 不论是不是刚更新完：更新页一直能看到当前这一版改了什么，断网也在。
    const section = releaseNotesSection({ ...base, installedRelease: { justUpdated: false, previousVersion: '0.2.9', notes: ['一条', '两条'] } })
    expect(section).toEqual({ title: '当前版本 0.2.9 更新内容', items: ['一条', '两条'], text: '' })
  })

  it('falls back to the old sentence when the build carried no notes', () => {
    expect(releaseNotesSection({ ...base, installedRelease: { justUpdated: true, previousVersion: null, notes: null } }))
      .toEqual({ title: '更新内容', items: null, text: '暂无更新说明。' })
    // 旧快照没有 installedRelease 字段。
    expect(releaseNotesSection({ availableVersion: null, currentVersion: '0.2.9', releaseNotesText: null }).text).toBe('暂无更新说明。')
    expect(releaseNotesSection(null).text).toBe('暂无更新说明。')
  })
})
