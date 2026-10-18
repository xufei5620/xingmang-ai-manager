// Electron 给渲染进程收到的 IPC 拒绝包成「Error invoking remote method '通道名':
// 类名: 真正的原因」（主进程那边的 error.toString()），通道名与错误类名都是实现细节，
// 不该上屏。类名只在紧跟通道名时才剥，避免把一句本来就以 Error: 开头的业务文案削掉
// 半截。类名不限以 Error 结尾：以前只认 …Error，Codex 桌面端装不上时的
// CodexDesktopInstallFailure 就带着英文类名进了错误框。每层只剥一个类名，原话开头的
// EPERM: 这类错误码照旧留着给错误分类认。冒号后面必须有空格（Electron 总会写一个）：
// 不然 C:\Users\… 的盘符会被当成类名剥掉，路径脱敏就认不出这条路径了。
//
// 主窗口渲染层只留这一份（#1073 第9条：以前错误框、登录框、账号读取各写一份，剥得干净程度
// 不一样）。画布宿主 electron/canvas-preload.ts 里那份是 sandbox preload 不能 import 的
// 有意副本（I7），由 ipc-error-prefix.test.ts 钉住和这里逐字一致；legacy 的
// src/error-message.ts 只剥前半截，已冻结不改。
// 正则不带 g 标志以避免 lastIndex 状态问题。
const ipcPrefixPattern = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s+)?/

/** 剥掉 Electron 的 IPC 包装，剩下主进程的原话；不做文案判断，也不去首尾空白。 */
export function stripIpcErrorPrefix(message: string): string {
  // 一个 handler 再 invoke 另一个通道时前缀会嵌套多层，逐层剥净
  while (ipcPrefixPattern.test(message)) message = message.replace(ipcPrefixPattern, '')
  return message
}
