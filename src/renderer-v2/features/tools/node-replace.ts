import type { NodeRuntimeInstallResult, PlatformCapabilities } from '../../../../electron/ipc-contract'
import { nodeReadsSystemCertificates } from '../../../../electron/system-certificate-trust'
import type { RuntimeInstallOutcome } from './runtime-install-outcome'

/**
 * 「更新 Node.js」（第十八批 4）。公司电脑和安全软件会换掉网上的安全证书，
 * Node.js 要 22.19 / 24.6 以上才认这台电脑装的证书；更旧的那些照样够装工具，所以
 * 「安装」一直回「无需重复安装」，客户照提示走进了死胡同。
 *
 * Windows 换得了：那边装的是官方安装包，本软件找 Node.js 时先看它的默认目录。Linux 也换得了：
 * 本软件代下的那份在软件里排在最前（electron/linux-platform.ts）。Mac 上代下的那份排在客户
 * 自己装的后面（macos-platform.ts），装了也用不上。
 */
export function canReplaceNode(input: { platform: PlatformCapabilities['platform'] | null | undefined; nodeRuntimeInstall: PlatformCapabilities['nodeRuntimeInstall'] | null | undefined }): boolean {
  return (input.platform === 'windows' || input.platform === 'linux') && input.nodeRuntimeInstall === 'managed'
}

/** 检查页 Node.js 那一行：装着、但版本认不了证书时，按钮改叫「换成新版」。 */
export function nodeReplaceOffered(input: {
  platform: PlatformCapabilities['platform'] | null | undefined
  nodeRuntimeInstall: PlatformCapabilities['nodeRuntimeInstall'] | null | undefined
  node: { installed: boolean; version: string | null } | null | undefined
}): boolean {
  return canReplaceNode(input)
    && Boolean(input.node?.installed)
    && nodeReadsSystemCertificates(input.node?.version) === false
}

/** 确认框第一段：读得出版本就说出来，读不出就只说「版本较旧」。 */
export function nodeReplaceReason(version: string | null | undefined): string {
  const current = version?.trim()
  const lead = current ? `本机的 Node.js 版本为 ${current.startsWith('v') ? current : `v${current}`}。` : '本机的 Node.js 版本较旧。'
  return `${lead}公司电脑和部分安全软件会替换网络安全证书，当前版本无法识别，导致工具无法安装；v22.19 及以上版本可正常识别。`
}

/**
 * 换完之后说的那句话。continuing：调用方接着重做刚才失败的那一步（错误框里点的），
 * 否则提醒客户回去再点一次「安装」。3010 要重启时由调用方弹重启框，不接着做。
 */
export function describeNodeReplaceOutcome(result: NodeRuntimeInstallResult, continuing = false): RuntimeInstallOutcome {
  if (result.systemRestartRequired) {
    return { message: 'Node.js 已更新，重启电脑后生效。', tone: 'warn', restartRequired: true }
  }
  const next = continuing ? '正在继续重试。' : '请再次点击工具的「安装」。'
  if (result.action === 'unchanged') {
    return { message: `Node.js 已是新版，${next}`, tone: 'ok', restartRequired: false }
  }
  const version = result.version?.trim()
  return { message: `Node.js 已更新至 ${version || '新版'}，${next}`, tone: 'ok', restartRequired: false }
}
