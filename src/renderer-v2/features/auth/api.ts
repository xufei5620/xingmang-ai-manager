import type { AccountLoginInput, AccountRegisterInput, AccountResetPasswordInput, LegalDocumentKind, RememberedAccountLogin, XingmangApi } from '../../../../electron/ipc-contract'

export type AuthBridge = Pick<XingmangApi, 'getAccountStatus' | 'getRememberedAccountLogin' | 'setRememberedAccountLogin' | 'loginAccount' | 'registerAccount' | 'sendVerificationCode' | 'sendPasswordResetCode' | 'resetPassword' | 'getLegalDocument' | 'openExternal'>

export function createAuthApi(bridge: AuthBridge) {
  return {
    getStatus: () => bridge.getAccountStatus(),
    getRemembered: () => bridge.getRememberedAccountLogin(),
    setRemembered: (login: RememberedAccountLogin | null) => bridge.setRememberedAccountLogin(login),
    login: (input: AccountLoginInput) => bridge.loginAccount(input),
    register: (input: AccountRegisterInput) => bridge.registerAccount(input),
    sendVerification: (email: string) => bridge.sendVerificationCode(email),
    sendReset: (email: string) => bridge.sendPasswordResetCode(email),
    reset: (input: AccountResetPasswordInput) => bridge.resetPassword(input),
    getLegal: (kind: LegalDocumentKind) => bridge.getLegalDocument(kind),
    openExternal: (url: string) => bridge.openExternal(url),
    copyPassword: async (value: string) => { await navigator.clipboard.writeText(value) },
  }
}

export type AuthApi = ReturnType<typeof createAuthApi>

export function getAuthApi(): AuthApi {
  return createAuthApi(window.xingmang)
}
