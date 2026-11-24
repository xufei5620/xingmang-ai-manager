// 主窗口业务通道的处理器：Antigravity（命令行 agy 和桌面端）的检测、一键装、带着设置打开。
// 密钥在这里按需签（手里有账号的只有这一层），交给 antigravity-service.ts 去写；明文不回渲染层（I3）。
import { resolveAntigravityManagedKey, type AntigravityManagedKey } from '../../account-cli-provisioner'
import type { QueuedAccountWork } from '../../account-work-gate'
import type { AntigravityProgress, AntigravityService, AntigravityTarget } from '../../antigravity-service'
import { runWhenOn } from '../../remote-feature-gate'
import { toolInstallOffMessage, toolLaunchOffMessage } from '../../remote-features'
import { parseWorkspace } from '../parsers/tools'
import type { IpcHandlerContext } from './context'

const antigravityNames = { cli: 'Antigravity 命令行', desktop: 'Antigravity' } as const
const signInFirstMessage = '请先登录账号，再设置 Antigravity'

export function parseAntigravityTarget(value: unknown): AntigravityTarget {
  if (value !== 'cli' && value !== 'desktop') throw new Error('未知的 Antigravity 安装项')
  return value
}

export function registerAntigravityHandlers(ctx: IpcHandlerContext): () => void {
  const { options, registerTrustedHandler, service, accountService, automaticProvisioning, explicitProvisioning } = ctx

  function antigravity(): AntigravityService {
    if (!service.antigravity) throw new Error('当前版本不支持 Antigravity')
    return service.antigravity
  }

  // 客户亲手点的安装、打开才签：读坏的额度记录可以清掉再签，同「重新写入密钥」（explicitProvisioning）。
  function resolveKey(): Promise<AntigravityManagedKey> {
    if (!accountService.getSessionState().account?.userId) return Promise.reject(new Error(signInFirstMessage))
    return resolveAntigravityManagedKey(explicitProvisioning, service, options.managedCliKeys)
  }

  // 换了账号、换了线路以后主进程自己跟（antigravity-service.ts 的 follow）：不是客户点的，走自动签发那一档，
  // 读坏的额度记录照旧停下、不清（同登录后那一轮同步）。撤通道时收回。
  service.antigravity?.bindFollowKey(() => {
    if (!accountService.getSessionState().account?.userId) return Promise.reject(new Error(signInFirstMessage))
    return resolveAntigravityManagedKey(automaticProvisioning, service, options.managedCliKeys)
  })

  // 点的时候是哪个账号先记下（scoped-queued，同 cli:launch）：排着队换了账号就不替上一个账号打开。
  async function forClickedAccount<T>(open: (accountWork: QueuedAccountWork | undefined) => Promise<T>): Promise<T> {
    const accountWork = options.accountWork?.queue()
    if (!accountWork) return open(undefined)
    try {
      return await open(accountWork)
    } finally {
      accountWork.release()
    }
  }

  registerTrustedHandler('antigravity:inspect', () => antigravity().inspect())

  registerTrustedHandler('antigravity:install', (event, target: unknown) => {
    const parsed = parseAntigravityTarget(target)
    const sender = event.sender
    function report(progress: AntigravityProgress): void {
      if (!sender.isDestroyed()) sender.send('antigravity:install-progress', progress)
    }
    const feature = parsed === 'cli' ? 'install:antigravityCli' : 'install:antigravityDesktop'
    return runWhenOn(options.remoteFeatures, feature, toolInstallOffMessage(antigravityNames[parsed]), () => antigravity().install(parsed, resolveKey, report))
  })

  registerTrustedHandler('antigravity:open-desktop', () => forClickedAccount(async (accountWork) => (
    runWhenOn(options.remoteFeatures, 'launch:antigravityDesktop', toolLaunchOffMessage(antigravityNames.desktop), () => antigravity().openDesktop(resolveKey, accountWork))
  )))

  registerTrustedHandler('antigravity:open-cli', (_event, workspace: unknown) => {
    const target = parseWorkspace(workspace, service.readStoredConfig().workspace, process.platform)
    return forClickedAccount(async (accountWork) => (
      runWhenOn(options.remoteFeatures, 'launch:antigravityCli', toolLaunchOffMessage(antigravityNames.cli), () => antigravity().openCli(target, resolveKey, accountWork))
    ))
  })

  return () => {
    service.antigravity?.bindFollowKey(null)
  }
}
