import type { AccountSessionState, AccountSiteId } from '../../../../electron/ipc-contract'

export type RememberedLoginAction =
  | { kind: 'login' }
  | { kind: 'forget'; siteId: AccountSiteId | undefined }

/**
 * 设置页「记住密码」那一行的按钮做什么（全面检测 Q47）。以前不管登没登录都打开
 * 登录框，已登录的人点进去再登一次就等于换了账号。记住的密码按账号来源只存
 * 一份，是上次登录时勾的：已登录时这一行只剩「清掉它」这一件事可做；没登录时
 * 仍去登录框，勾选「记住密码」就在那里。
 *
 * siteId 缺省时交给主进程按当前账号来源处理，和登录框的写法一致。
 */
export function rememberedLoginAction(session: Pick<AccountSessionState, 'authenticated' | 'siteId'> | null | undefined): RememberedLoginAction {
  if (!session?.authenticated) return { kind: 'login' }
  return { kind: 'forget', siteId: session.siteId }
}

export const rememberedLoginForgottenMessage = '本机不再记着密码了，下次登录要重新输入。'
