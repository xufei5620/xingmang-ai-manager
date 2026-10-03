import type { ConnectionCheckView } from './connection-check'

/**
 * 接入其他客户端保存完那块结果的颜色（第三十批 D）。配置确实写进去了，标题照旧是
 * 「配置已保存」；可连接自检没通过时还是一整块绿色，客户多半看颜色和标题就关了窗口，
 * 回到客户端里才发现用不了。没通过（warn / bad）就用提醒色，和检查页「没通过」同一种；
 * 通过、没配、这次没测成（null）照旧是绿色，字一个不改。
 */
export function externalClientSavedTone(connection: Pick<ConnectionCheckView, 'tone'> | null): 'ok' | 'warn' {
  return connection?.tone === 'warn' || connection?.tone === 'bad' ? 'warn' : 'ok'
}

/**
 * 账号密钥列表没读到时那句。原因来自 errorMessage，兜底句和主进程的中文本来就以句号
 * 结尾，原样拼进去会变成「……反馈日志。。可以使用……」，所以先去掉结尾的句号。
 */
export function accountKeyListFailureText(reason: string): string {
  return `账号密钥列表读取失败：${reason.replace(/[。.\s]+$/, '')}。可以使用已有工具密钥或自行填写。`
}
