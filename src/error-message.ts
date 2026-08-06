// Electron 会给渲染进程收到的 IPC 错误加上内部通道名前缀，直接展示会暴露实现细节
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*/

export function errorMessage(error: unknown): string {
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    message = (error as { message: string }).message
  } else if (error === null || error === undefined) {
    message = '未知错误'
  } else {
    message = String(error)
  }
  // IPC 转发链路可能嵌套多层前缀，逐层剥净；正则不带 g 标志以避免 lastIndex 状态问题
  while (IPC_PREFIX.test(message)) message = message.replace(IPC_PREFIX, '')
  return message
}
