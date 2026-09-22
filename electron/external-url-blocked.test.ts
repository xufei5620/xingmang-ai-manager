import { describe, expect, it } from 'vitest'
import { ExternalUrlBlockedError, externalUrlBlockedErrorName, isExternalUrlBlockedError } from './external-url-blocked'

describe('external-url-blocked', () => {
  it('recognises the error both in-process and after the IPC bridge flattened it', () => {
    const error = new ExternalUrlBlockedError()
    expect(error.message).toBe('不允许打开该链接')
    expect(isExternalUrlBlockedError(error)).toBe(true)
    expect(isExternalUrlBlockedError(new Error(`Error invoking remote method 'external:open': ${error.toString()}`))).toBe(true)
    expect(isExternalUrlBlockedError({ message: `${externalUrlBlockedErrorName}: 不允许打开该链接` })).toBe(true)
  })

  it('does not treat other failures or the bare sentence as a blocked link', () => {
    expect(isExternalUrlBlockedError(new Error("Error invoking remote method 'external:open': Error: 不允许打开该链接"))).toBe(false)
    expect(isExternalUrlBlockedError(new Error('Error: 系统浏览器没有响应'))).toBe(false)
    expect(isExternalUrlBlockedError(new Error(`xx${externalUrlBlockedErrorName}: 不允许打开该链接`))).toBe(false)
    expect(isExternalUrlBlockedError(null)).toBe(false)
    expect(isExternalUrlBlockedError('ExternalUrlBlockedError')).toBe(false)
  })
})
