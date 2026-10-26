import type { AccountSourceSwitchResult } from '../../../../electron/ipc-contract'
import type { GuideRoute, GuideToolState } from './StartGuide'

interface GuideResultRow {
  value: string
  detail: string
  tone: 'ok' | 'warn' | 'neutral'
}

export interface GuideSetupResult {
  install: GuideResultRow
  connection: GuideResultRow
  billing: string
  /** 花的就是当前账号的余额：最后一步据此告诉新用户去哪充值；别处的额度不提。 */
  usesAccountBalance: boolean
  /** 花的是当前账号的余额，而余额是 $0、也没有能用的订阅：最后一步先让客户去充值。 */
  walletEmpty: boolean
  next: GuideResultRow
  prompt: string | null
}

interface GuideSetupInput {
  route: GuideRoute
  tool?: GuideToolState
  signedIn: boolean
  readiness: { prepared: boolean; connected: boolean }
  /** 引导里的工具名，比如「Codex 桌面端」。 */
  name: string
  officialName: string
  /** 右上角显示的账号名；没有就只说「当前账号」。 */
  accountName?: string | null
  switched?: AccountSourceSwitchResult | null
  /** 当前账号余额是 $0、也没有能用的订阅；缺省 = 不知道，照旧说「已准备好」。 */
  walletEmpty?: boolean
}

/**
 * 新账号的余额本来就是 0，装好、连好以后发第一句话就会失败（主路卡点 F3）。
 * 跟首页那条提示（Home.tsx 的 lowBalanceText(0)）用同一句原话，测试钉住两处一致。
 */
export const walletEmptyLead = '当前账号余额是 $0，充值后 AI 工具才能用。付完马上生效，不用重新设置。'

// 和「改用 xxx」按钮用同一种截断，免得同一个名字在两处长短不一。
function currentAccountLabel(accountName: string | null | undefined): string {
  const name = [...(accountName?.trim() ?? '')]
  if (!name.length) return '当前账号'
  return `当前账号 ${name.length > 16 ? `${name.slice(0, 15).join('')}…` : name.join('')}`
}

function installationResult(route: GuideRoute, tool: GuideToolState | undefined, prepared: boolean): GuideResultRow {
  if (route === 'chat') return { value: '不用另装', detail: '聊天就在本软件里，直接提问就行。', tone: 'ok' }
  if (!tool || tool.detectionError) return { value: '暂时没读到', detail: '点「重新检测」再看一次。', tone: 'warn' }
  if (!tool.installed) return { value: '还没装好', detail: '回到上一步把它装好。', tone: 'warn' }
  const version = tool.version?.replace(/^v/i, '')
  const update = tool.update
  const how = update?.manualHint ? '用它原来的安装方式更新' : '更新'
  const detail = !prepared ? '还差一点准备工作，回到上一步按提示补齐。'
    : update?.knownIssue ? `这一版有已知问题，建议${how}到 ${update.target || update.version}。`
      : update ? `有更新的版本 ${update.target || update.version}，可以以后再${how}，不影响现在用。`
        : '可以直接用。'
  return { value: version ? `已装好（版本 ${version}）` : '已装好', detail, tone: !prepared || update ? 'warn' : 'ok' }
}

function connectionResult(input: GuideSetupInput): { row: GuideResultRow; billing: string; usesAccountBalance?: boolean } {
  const { route, tool, signedIn, readiness, name, officialName, accountName, switched } = input
  const current = currentAccountLabel(accountName)
  if (route === 'chat') return signedIn
    ? { row: { value: current, detail: '进聊天就能提问。', tone: 'ok' }, billing: '聊天花的是当前账号的余额。', usesAccountBalance: true }
    : { row: { value: '还没登录', detail: '登录后就能聊天。', tone: 'warn' }, billing: '还没开始用，不花钱。' }
  if (!tool || tool.detectionError) return { row: { value: '暂时没读到', detail: '点「重新检测」再看一次。', tone: 'warn' }, billing: '读到设置后才能说清。' }
  // 刚在引导里切过来源时，以这次切换的结果为准：检测快照可能还没跟上，
  // 不能让刚点完的人看不到任何回执。
  const source = switched ? switched.target : tool.source
  if (source === 'official') {
    const loginRequired = switched?.target === 'official' ? switched.loginRequired : tool.officialLoginRequired
    return {
      row: loginRequired
        ? { value: `${officialName}，还没登录`, detail: `打开 ${name}，用 ${officialName}登录一次。`, tone: 'warn' }
        : { value: officialName, detail: `能用多少，在 ${name} 里看。`, tone: 'neutral' },
      billing: `花的是 ${officialName}自己的额度，不扣当前账号的余额。`,
    }
  }
  if (source === 'manual') return {
    row: { value: '自己的密钥', detail: readiness.connected ? '设置已读到，打开工具试一次。' : '请检查填的密钥和模型。', tone: readiness.connected ? 'neutral' : 'warn' },
    billing: '花的是这把密钥所在账号的余额，不一定是当前账号。',
  }
  if (source === 'unknown') return {
    // 别家的站认不出来，只说是不是当前账号的，不说对方是谁（和第 3 步的提示一致）。
    row: tool.keyState === 'otherAccount' ? { value: '可能不是当前账号的密钥', detail: '能用，但用量可能算到别的账号上。', tone: 'warn' }
      : tool.keyState === 'changed' ? { value: '设置被改过', detail: '在本软件之外被改过，现在还能用。', tone: 'warn' }
        : tool.keyState === 'otherSite' ? { value: '不是当前账号的密钥', detail: '换成当前账号就能接着用。', tone: 'warn' }
          : { value: '别处的配置', detail: '原来的配置原样留着，先看看怎么处理。', tone: 'warn' },
    billing: '可能不扣当前账号的余额。改用当前账号后，就花当前账号的。',
  }
  if (source === 'account') {
    const detail = switched?.target === 'account'
      ? switched.verified ? '刚才改用时试连过，能连上。' : '已经改好，但这次没试通，原因看下面。'
      : !readiness.connected ? '还没设好，点「去完成连接配置」保存一次。'
        : signedIn ? '设置已读到，打开工具试一次。' : '设置已读到，登录后能核对是不是你的账号。'
    const verified = switched?.target === 'account' && switched.verified
    return {
      row: { value: signedIn ? current : '还没登录', detail, tone: !readiness.connected || (switched && !switched.verified) ? 'warn' : verified ? 'ok' : 'neutral' },
      billing: !readiness.connected ? '设好之后才开始花当前账号的余额。'
        : signedIn ? '花的是当前账号的余额。' : '花的是这把密钥所在账号的余额，登录后能核对。',
      usesAccountBalance: readiness.connected && signedIn,
    }
  }
  return { row: { value: '还没设好', detail: '选好账号后保存一次。', tone: 'warn' }, billing: '设好之前不会花钱。' }
}

export function buildGuideSetupResult(input: GuideSetupInput): GuideSetupResult {
  const { route, readiness } = input
  const connection = connectionResult(input)
  const prompt = route === 'codexDesktop'
    ? '帮我看看这个文件夹里都有什么，每个文件用一句话说明它是做什么的。'
    : route === 'chat' ? '请先问我想解决的问题和限制，然后给我一个今天就能做的第一步。' : null
  // 桌面端里「ChatGPT」那边的「聊天」「工作」要登录 ChatGPT 账号，用密钥发会报「提交消息时出错」，
  // 只有「Codex」那一栏走得通（2026-10-18 客户报）。用官方账号的照旧，不多说这一句。
  const keyedDesktop = route === 'codexDesktop' && (input.switched ? input.switched.target : input.tool?.source) !== 'official'
  const next: GuideResultRow = !readiness.prepared
    ? { value: '先回上一步', detail: '把工具准备好后，点「重新检测」。', tone: 'warn' }
    : !readiness.connected
      ? { value: '先把账号设好', detail: '保存设置或在工具里登录后，点「重新检测」。', tone: 'warn' }
      : route === 'chat'
        ? { value: '可以开始聊天', detail: '把下面这句话发出去试试。', tone: 'neutral' }
        : { value: '打开工具试一次', detail: keyedDesktop ? '打开后在左侧栏最上面把模式切到「Codex」，再把下面这句话发给它试试。' : prompt ? '打开后把下面这句话发给它试试。' : '打开后随便问它一个问题试试。', tone: 'neutral' }
  const usesAccountBalance = connection.usesAccountBalance ?? false
  return {
    install: installationResult(route, input.tool, readiness.prepared),
    connection: connection.row,
    billing: connection.billing,
    usesAccountBalance,
    walletEmpty: usesAccountBalance && input.walletEmpty === true,
    next,
    prompt,
  }
}
