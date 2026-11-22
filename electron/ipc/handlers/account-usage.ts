// 主窗口业务通道的处理器：账号用量、看板、任务记录。
// #1070 第 7 步从 ipc.ts 原样搬来：按域一个文件，ipc.ts 只管组装，各域共用的东西在 context.ts。
import { buildAccountPriceList } from '../../account-price-list'
import { staleAccountMessage } from '../../account-work-gate'
import { parseAccountDashboardQuery, parseAccountTaskQuery, parseAccountUsageQuery, parseOptionalExpectedAccountScope } from '../parsers/account-usage'
import type { IpcHandlerContext } from './context'

export function registerAccountUsageHandlers(ctx: IpcHandlerContext): void {
  const { options, registerTrustedHandler, accountService } = ctx
  /** 跟渲染层 accountScope 同一个写法：站点分两种，没登录算 guest。 */
  function currentAccountScope(): string {
    const state = accountService.getSessionState()
    const siteId = accountService.getActiveSiteId?.() ?? options.realmAccounts?.getSiteId() ?? 'solov'
    return `${siteId === 'solov-api' ? 'api-account' : 'xm-account'}:${state.authenticated && state.account ? state.account.userId : 'guest'}`
  }
  registerTrustedHandler('account:get-usage', (_event, input: unknown) => (
    accountService.getUsage(parseAccountUsageQuery(input))
  ))
  registerTrustedHandler('account:get-dashboard', (_event, input: unknown, expectedAccountScope: unknown) => {
    const query = parseAccountDashboardQuery(input)
    const expected = parseOptionalExpectedAccountScope(expectedAccountScope)
    // 首页近 7 天的柱子按账号记在本机，渲染层先读会话、再一天一天查看板，是两次调用：中间换了
    // 账号，查回来的就是新账号的数，却记到上一个账号名下，换回去、重开都改不回来（11-18 D11）。
    // 这里跟下面发请求在同一拍里核对：对上了才查，查的过程中再换账号，外层的账号工作照旧报
    // 「账号刚刚切换」，所以带着它查回来的一定是它的数。
    if (expected !== undefined && expected !== currentAccountScope()) throw new Error(staleAccountMessage)
    return accountService.getDashboard(query)
  })
  registerTrustedHandler('account:get-tasks', (_event, input: unknown) => (
    accountService.getTasks(parseAccountTaskQuery(input))
  ))
  // 历史账号的后端没有按型号的价目，回 null，页面不出价格表。
  registerTrustedHandler('account:get-price-list', async () => (
    accountService.getModelPricing ? buildAccountPriceList(await accountService.getModelPricing()) : null
  ))
}
