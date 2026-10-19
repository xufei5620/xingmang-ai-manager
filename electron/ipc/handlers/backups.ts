// 主窗口业务通道的处理器：「设置 › 备份迁移」里工具配置备份的列出、新建、查看、恢复、删除。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { apiKeyDigest } from '../../backups'
import { isActiveProviderId, isRetiredProviderId } from '../../catalog'
import { requiredString } from '../parsers/common'
import type { IpcHandlerContext } from './context'

export function registerBackupHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, service, currentBackupAccountId, readBackupAccountContext } = ctx
  // 下线工具（Gemini CLI）以前的备份留在磁盘上，不再列出来，也不让恢复回去（backups.ts restore）。
  registerTrustedHandler('backups:list', async () => (
    options.backupStore.list(await readBackupAccountContext()).filter((entry) => !isRetiredProviderId(entry.provider))
  ))
  registerTrustedHandler('backups:create', (_event, provider: unknown) => {
    if (!isActiveProviderId(provider)) throw new Error('未知的配置类型')
    return (async () => options.backupStore.create(provider, 'manual', undefined, await readBackupAccountContext()))()
  })
  registerTrustedHandler('backups:inspect', (_event, id: unknown) => {
    const backupId = requiredString(id, '备份 ID', 128)
    return (async () => options.backupStore.inspect(backupId, await readBackupAccountContext()))()
  })
  registerTrustedHandler('backups:restore', (_event, id: unknown) => {
    const backupId = requiredString(id, '备份 ID', 128)
    return (async () => {
      const identity = currentBackupAccountId()
      const context = await readBackupAccountContext()
      const result = options.backupStore.restore(backupId, context)
      // 恢复已经落盘，登记来源失败不能反过来让用户以为恢复失败了；最坏情况是
      // 首页照旧提示一次「配置被改过」，所以只记日志。换过账号就不再认这批 Key。
      const stillCurrent = context !== null && currentBackupAccountId() === identity
      try {
        await service.adoptRestoredConfig(result.provider, (apiKey) => (
          stillCurrent && context.keyDigests.has(apiKeyDigest(apiKey))
        ), { fromBackupsPage: true })
      } catch (error) {
        options.runtimeLog.log('warn', 'ipc', 'backups:restore', '配置已恢复，但没能登记这份配置的来源', {
          provider: result.provider,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      // 恢复的是当前账号的配置还是官方登录，「选了官方账号」的记号和 Claude 的官方 Key 跟着换（#1080）。
      // 同上，恢复已经落盘，对不齐只记日志。
      try {
        await service.alignRestoredAccountSource(result.provider)
      } catch (error) {
        options.runtimeLog.log('warn', 'ipc', 'backups:restore', '配置已恢复，但官方账号的记号或官方 Key 没能跟着对齐', {
          provider: result.provider,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
      return result
    })()
  })
  registerTrustedHandler('backups:delete', (_event, id: unknown) => (
    options.backupStore.delete(requiredString(id, '备份 ID', 128))
  ))
}
