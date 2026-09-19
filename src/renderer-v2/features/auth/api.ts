import { bridge as getBridge } from '../../bridge'
import type { AccountLoginInput, AccountRegisterInput, AccountResetPasswordInput, LegalDocumentKind, RememberedAccountLogin, XingmangApi } from '../../../../electron/ipc-contract'

export type AuthBridge = Pick<XingmangApi, 'getAccountStatus' | 'getRememberedAccountLogin' | 'setRememberedAccountLogin' | 'loginAccount' | 'registerAccount' | 'sendVerificationCode' | 'sendPasswordResetCode' | 'resetPassword' | 'getLegalDocument' | 'openExternal'>
export type AccountSiteId = 'solov' | 'solov-api'

export function createAuthApi(bridge: AuthBridge) {
  return {
    getStatus: (siteId: AccountSiteId) => bridge.getAccountStatus(siteId),
    getRemembered: (siteId: AccountSiteId) => bridge.getRememberedAccountLogin(siteId),
    setRemembered: (login: RememberedAccountLogin | null, siteId?: AccountSiteId) => bridge.setRememberedAccountLogin(login, siteId),
    login: (input: AccountLoginInput) => bridge.loginAccount(input),
    register: (input: AccountRegisterInput) => bridge.registerAccount(input),
    sendVerification: (email: string) => bridge.sendVerificationCode(email),
    sendReset: (email: string, siteId: AccountSiteId) => bridge.sendPasswordResetCode(email, siteId),
    reset: (input: AccountResetPasswordInput, siteId: AccountSiteId) => bridge.resetPassword(input, siteId),
    getLegal: (kind: LegalDocumentKind) => bridge.getLegalDocument(kind, 'solov'),
    openExternal: (url: string) => bridge.openExternal(url),
    copyPassword: async (value: string) => { await navigator.clipboard.writeText(value) },
  }
}

export type AuthApi = ReturnType<typeof createAuthApi>

export function getAuthApi(): AuthApi {
  const native = getBridge()
  if (!native) throw new Error('浏览器页面未连接本机服务，请从桌面应用打开工具箱。')
  return createAuthApi(native)
}
