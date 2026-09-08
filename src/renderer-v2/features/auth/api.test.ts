import { describe, expect, it, vi } from 'vitest'
import { createAuthApi, type AuthBridge } from './api'

describe('v2 auth IPC adapter', () => {
  it('forwards credentials only to the explicit login channel and does not touch CLI configuration', async () => {
    const bridge = { loginAccount: vi.fn().mockResolvedValue({ account: { userId: 7, username: 'member' }, accessExpiresAt: null }), registerAccount: vi.fn().mockResolvedValue(undefined), configureManagedCliKeys: vi.fn() }
    const api = createAuthApi(bridge as unknown as AuthBridge)
    const input = { username: 'member', password: 'test-password' }
    await api.login(input)
    expect(bridge.loginAccount).toHaveBeenCalledExactlyOnceWith(input)
    expect(bridge.configureManagedCliKeys).not.toHaveBeenCalled()
    await api.register({ email: 'm@example.test', username: 'new-member', password: 'test-password', verificationCode: '' })
    expect(bridge.loginAccount).toHaveBeenCalledTimes(1)
  })
  it('sends a parsed token without inventing a user chosen password', async () => {
    const resetPassword = vi.fn().mockResolvedValue({ newPassword: 'generated-by-server' })
    const api = createAuthApi({ resetPassword } as unknown as AuthBridge)
    await expect(api.reset({ email: 'm@example.test', token: 'opaque-code' })).resolves.toEqual({ newPassword: 'generated-by-server' })
    expect(resetPassword).toHaveBeenCalledExactlyOnceWith({ email: 'm@example.test', token: 'opaque-code' })
  })
})
