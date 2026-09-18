import { describe, expect, it, vi } from 'vitest'
import { createAuthApi, type AuthBridge } from './api'

describe('v2 auth IPC adapter', () => {
  it('loads remembered credentials only from the selected source and keeps registration documents on the default service', async () => {
    const bridge = { getAccountStatus: vi.fn(), getRememberedAccountLogin: vi.fn(), setRememberedAccountLogin: vi.fn(), getLegalDocument: vi.fn() }
    const api = createAuthApi(bridge as unknown as AuthBridge)
    await api.getStatus()
    await api.getRemembered('solov-api')
    await api.setRemembered(null, 'solov-api')
    await api.getLegal('privacy-policy')
    expect(bridge.getAccountStatus).toHaveBeenCalledWith('solov')
    expect(bridge.getRememberedAccountLogin).toHaveBeenCalledWith('solov-api')
    expect(bridge.setRememberedAccountLogin).toHaveBeenCalledWith(null, 'solov-api')
    expect(bridge.getLegalDocument).toHaveBeenCalledWith('privacy-policy', 'solov')
  })
  it('forwards credentials only to the explicit login channel and does not touch CLI configuration', async () => {
    const bridge = { loginAccount: vi.fn().mockResolvedValue({ account: { userId: 7, username: 'member' }, accessExpiresAt: null }), registerAccount: vi.fn().mockResolvedValue(undefined), configureManagedCliKeys: vi.fn() }
    const api = createAuthApi(bridge as unknown as AuthBridge)
    const input = { username: 'member', password: 'test-password', siteId: 'solov' as const }
    await api.login(input)
    expect(bridge.loginAccount).toHaveBeenCalledExactlyOnceWith(input)
    expect(bridge.configureManagedCliKeys).not.toHaveBeenCalled()
    await api.register({ email: 'm@example.test', username: 'new-member', password: 'test-password', verificationCode: '' })
    expect(bridge.loginAccount).toHaveBeenCalledTimes(1)
  })
  it('sends a parsed token without inventing a user chosen password', async () => {
    const resetPassword = vi.fn().mockResolvedValue({ newPassword: 'generated-by-server' })
    const api = createAuthApi({ resetPassword } as unknown as AuthBridge)
    await expect(api.reset({ email: 'm@example.test', token: 'opaque-code' }, 'solov')).resolves.toEqual({ newPassword: 'generated-by-server' })
    expect(resetPassword).toHaveBeenCalledExactlyOnceWith({ email: 'm@example.test', token: 'opaque-code' }, 'solov')
  })
  it('binds recovery mail to the selected account source', async () => {
    const sendPasswordResetCode = vi.fn().mockResolvedValue(undefined)
    const api = createAuthApi({ sendPasswordResetCode } as unknown as AuthBridge)
    await api.sendReset('m@example.test', 'solov')
    expect(sendPasswordResetCode).toHaveBeenCalledExactlyOnceWith('m@example.test', 'solov')
  })
})
