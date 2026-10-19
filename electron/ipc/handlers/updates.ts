// 主窗口业务通道的处理器：星芒自己的检查更新、下载、安装。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { parseUpdateDownloadOptions, parseUpdateInstallOptions } from '../parsers/system'
import type { IpcHandlerContext } from './context'

export function registerUpdateHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler } = ctx
  registerTrustedHandler('update:get-state', () => options.updaterService.getState())
  registerTrustedHandler('update:startup', async () => {
    await options.startupQuiet?.whenOver()
    return options.updaterService.startup()
  })
  // 从界面来的检查都是用户自己点的：分批放量不拦主动来要新版本的人。
  registerTrustedHandler('update:check', () => options.updaterService.check({ manual: true }))
  registerTrustedHandler('update:download', (_event, downloadOptions: unknown) => (
    options.updaterService.download(parseUpdateDownloadOptions(downloadOptions))
  ))
  registerTrustedHandler('update:install', async (_event, rawOptions: unknown) => {
    // 重启会打断正在装的工具：客户点了「继续安装」就这次不装，新版本留着（已知31）。只有
    // 更新页「确认重启安装」要问；「必须更新」那层提示和旧回滚界面不带参数，照旧直接装。
    const ask = parseUpdateInstallOptions(rawOptions).askIfInstalling === true
    if (ask && options.confirmUpdateInstall && !await options.confirmUpdateInstall()) return { accepted: true, postponed: true }
    return options.updaterService.install()
  })
}
