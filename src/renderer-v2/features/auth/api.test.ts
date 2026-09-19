import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthApi, getAuthApi, type AuthBridge } from './api'

describe('v2 auth IPC adapter', () => {
  it('loads remembered credentials only from the selected source and keeps registration documents on the default service', async () => {
    const bridge = { getAccountStatus: vi.fn(), getRememberedAccountLogin: vi.fn(), setRememberedAccountLogin: vi.fn(), getLegalDocument: vi.fn() }
    const api = createAuthApi(bridge as unknown as AuthBridge)
    await api.getStatus('solov-api')
    await api.getRemembered('solov-api')
    await api.setRemembered(null, 'solov-api')
    await api.getLegal('privacy-policy')
    expect(bridge.getAccountStatus).toHaveBeenCalledWith('solov-api')
    expect(bridge.getRememberedAccountLogin).toHaveBeenCalledWith('solov-api')
    expect(bridge.setRememberedAccountLogin).toHaveBeenCalledWith(null, 'solov-api')
    expect(bridge.getLegalDocument).toHaveBeenCalledWith('privacy-policy', 'solov')
  })
  it('reads account settings from the selected source instead of a fixed one', async () => {
    const getAccountStatus = vi.fn().mockResolvedValue(null)
    const api = createAuthApi({ getAccountStatus } as unknown as AuthBridge)
    await api.getStatus('solov')
    await api.getStatus('solov-api')
    expect(getAccountStatus.mock.calls).toEqual([['solov'], ['solov-api']])
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
describe('v2 auth bridge lookup', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('reports a missing desktop bridge in Chinese instead of dereferencing it', () => {
    expect(() => getAuthApi()).toThrow('浏览器页面未连接本机服务，请从桌面应用打开工具箱。')
    vi.stubGlobal('window', {})
    expect(() => getAuthApi()).toThrow('浏览器页面未连接本机服务，请从桌面应用打开工具箱。')
  })
  it('builds the adapter on the bridge the desktop shell installed', async () => {
    const getAccountStatus = vi.fn().mockResolvedValue(null)
    vi.stubGlobal('window', { xingmang: { getAccountStatus } })
    await getAuthApi().getStatus('solov')
    expect(getAccountStatus).toHaveBeenCalledExactlyOnceWith('solov')
  })
})
