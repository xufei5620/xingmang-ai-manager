// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Imports nothing on purpose: the renderer value-imports this file to recognise
// the sentence below (registered in scripts/verify-renderer-boundary.test.cjs),
// so it must stay free of Node APIs (I6).

/**
 * 改密码那一下发出去了却没等到准话（N6）：服务端可能已经存好了新密码。主进程拿这句换掉原来的报错
 * （ipc/handlers/account.ts 的 account:change-password，原来的报错挂在 cause 上，日志照旧记得住线路和请求编号），
 * 「账号安全」的改密码框认出它，换成叫人先试新密码的那句（features/account/account-center.ts）。
 * 找回密码第 3 步不认它，当作一句普通的中文原因，红字是「设新密码没有成功：没等到账号服务的回话。」。
 * 这句刻意不带「网络」「连接」「超时」「密码」：登录框和错误框的兜底正则按这些字归类，撞上就变成别的说法。
 */
export const passwordChangeUnconfirmedMessage = '没等到账号服务的回话。'
