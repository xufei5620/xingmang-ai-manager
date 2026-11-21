import type { ExternalToolId } from '../../../../electron/ipc-contract'
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
 * 结尾，原样拼进去会变成「……发给客服。。可以使用……」，所以先去掉结尾的句号。
 */
export function accountKeyListFailureText(reason: string): string {
  return `账号密钥列表获取失败：${reason.replace(/[。.\s]+$/, '')}。可使用已有工具密钥或手动填写。`
}

/**
 * 连好以后角落里说的下一步：配置窗口保存成功时，和装好以后星芒替他自动连上的那一次（决定单 D7）共用，
 * 字一个不改。WorkBuddy 列表里显示的就是型号本身（主进程写进 models.json 的 name 缺省是型号 ID），
 * 所以直接点名让他选哪一个。
 */
export function externalClientConnectedText(tool: ExternalToolId, model: string): string {
  if (tool === 'claudeDesktop') return 'Claude Desktop 已连接，请完全退出后在此点击「打开」；首次发送消息需等待组件下载完成'
  if (tool === 'workbuddy') return `已连好 WorkBuddy，在它的模型列表里选「${model}」`
  return 'OpenCode 已连接，命令行版与桌面版均可使用'
}
