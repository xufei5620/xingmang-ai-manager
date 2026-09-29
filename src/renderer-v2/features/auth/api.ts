import { bridge as getBridge } from '../../bridge'
import type { AccountLoginInput, AccountRegisterInput, AccountResetPasswordInput, LegalDocumentKind, RememberedAccountLogin, XingmangApi } from '../../../../electron/ipc-contract'

export type AuthBridge = Pick<XingmangApi, 'getAccountStatus' | 'getRememberedAccountLogin' | 'setRememberedAccountLogin' | 'loginAccount' | 'submitTwoFactorCode' | 'registerAccount' | 'sendVerificationCode' | 'sendPasswordResetCode' | 'resetPassword' | 'getLegalDocument' | 'openExternal' | 'copyResetPassword'>
export type AccountSiteId = 'solov' | 'solov-api'
/** 打开登录框时预先选好的来源和账号，给「重新登录这个账号」用（#480）。 */
export interface LoginTarget {
  siteId: AccountSiteId
  identifier: string
}

export function createAuthApi(bridge: AuthBridge) {
  return {
    getStatus: (siteId: AccountSiteId) => bridge.getAccountStatus(siteId),
    getRemembered: (siteId: AccountSiteId) => bridge.getRememberedAccountLogin(siteId),
    setRemembered: (login: RememberedAccountLogin | null, siteId?: AccountSiteId) => bridge.setRememberedAccountLogin(login, siteId),
    login: (input: AccountLoginInput) => bridge.loginAccount(input),
    submitTwoFactor: (code: string) => bridge.submitTwoFactorCode(code),
    register: (input: AccountRegisterInput) => bridge.registerAccount(input),
    sendVerification: (email: string) => bridge.sendVerificationCode(email),
    sendReset: (email: string, siteId: AccountSiteId) => bridge.sendPasswordResetCode(email, siteId),
    reset: (input: AccountResetPasswordInput, siteId: AccountSiteId) => bridge.resetPassword(input, siteId),
    getLegal: (kind: LegalDocumentKind) => bridge.getLegalDocument(kind, 'solov'),
    openExternal: (url: string) => bridge.openExternal(url),
    // 走主进程写剪贴板：那边 60 秒后会把它清掉，渲染层的剪贴板接口做不到。
    copyPassword: (value: string) => bridge.copyResetPassword(value),
  }
}

export type AuthApi = ReturnType<typeof createAuthApi>

export function getAuthApi(): AuthApi {
  const native = getBridge()
  if (!native) throw new Error('浏览器页面未连接本机服务，请从桌面应用打开工具箱。')
  return createAuthApi(native)
}
