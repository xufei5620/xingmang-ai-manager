// 主窗口业务通道的处理器：账号用量、看板、任务记录。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { parseAccountDashboardQuery, parseAccountTaskQuery, parseAccountUsageQuery } from '../parsers/account-usage'
import type { IpcHandlerContext } from './context'

export function registerAccountUsageHandlers(ctx: IpcHandlerContext): void {
  const { registerTrustedHandler, accountService } = ctx
  registerTrustedHandler('account:get-usage', (_event, input: unknown) => (
    accountService.getUsage(parseAccountUsageQuery(input))
  ))
  registerTrustedHandler('account:get-dashboard', (_event, input: unknown) => (
    accountService.getDashboard(parseAccountDashboardQuery(input))
  ))
  registerTrustedHandler('account:get-tasks', (_event, input: unknown) => (
    accountService.getTasks(parseAccountTaskQuery(input))
  ))
}
