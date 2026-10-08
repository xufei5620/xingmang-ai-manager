import { describe, expect, it } from 'vitest'
import { isWindowInFront, resolveInstallNoticeOutcome } from './install-notice'

describe('install notice', () => {
  it('reports installs and updates by how they ended', () => {
    expect(resolveInstallNoticeOutcome({}, true)).toBe('installed')
    expect(resolveInstallNoticeOutcome({ updating: true }, true)).toBe('updated')
    expect(resolveInstallNoticeOutcome({}, false)).toBe('installFailed')
    expect(resolveInstallNoticeOutcome({ updating: true }, false)).toBe('updateFailed')
  })

  it('stays quiet when the job returned without finishing the tool', () => {
    expect(resolveInstallNoticeOutcome({ unfinished: () => true }, true)).toBeNull()
    expect(resolveInstallNoticeOutcome({ unfinished: () => false }, true)).toBe('installed')
    // 真抛错了照样要说没装上：unfinished 只管「成功返回但其实没装完」。
    expect(resolveInstallNoticeOutcome({ unfinished: () => true }, false)).toBe('installFailed')
  })

  it('treats the window as in front only when visible and focused', () => {
    expect(isWindowInFront({ visibilityState: 'visible', hasFocus: () => true })).toBe(true)
    expect(isWindowInFront({ visibilityState: 'visible', hasFocus: () => false })).toBe(false)
    expect(isWindowInFront({ visibilityState: 'hidden', hasFocus: () => true })).toBe(false)
    expect(isWindowInFront(undefined)).toBe(false)
  })
})
