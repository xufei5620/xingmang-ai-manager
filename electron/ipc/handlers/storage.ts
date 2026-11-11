// 主窗口业务通道的处理器：「设置 › 备份迁移 › 星芒占用的空间」那张卡（决定单 D100）算大小、清理。
// 入参只认是哪一行、清哪一样；文件夹的位置和删哪些文件全由主进程定（I5、I8）。
import { isStorageCleanTarget, isStorageUsagePart } from '../../storage-usage'
import type { IpcHandlerContext } from './context'

export function registerStorageHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler } = ctx
  function service() {
    if (!options.storageUsage) throw new Error('这个版本还不能算占用的空间')
    return options.storageUsage
  }
  registerTrustedHandler('storage:inspect', async (_event, part: unknown) => {
    if (!isStorageUsagePart(part)) throw new Error('不认识要算的是哪一样')
    return service().inspect(part)
  })
  registerTrustedHandler('storage:clean', async (_event, target: unknown) => {
    if (!isStorageCleanTarget(target)) throw new Error('不认识要清理的是哪一样')
    return service().clean(target)
  })
}
