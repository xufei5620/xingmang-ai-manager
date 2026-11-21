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
  /**
   * 一切正常、没有哪一行要人看一眼：最后一步把结果卡收成一行（D46，新手流程 N5）。
   * 有一行是黄的（没装好、没连好、有新版、先充值）就整张摊开。桌面端用密钥连的那句「切到 Codex」
   * 不看就会报错，也摊开。
   */
  allClear: boolean
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
export const walletEmptyLead = '当前账号余额为 $0，充值后方可使用 AI 工具。充值即时生效，无需重新设置。'

// 和「改用 xxx」按钮用同一种截断，免得同一个名字在两处长短不一。
function currentAccountLabel(accountName: string | null | undefined): string {
  const name = [...(accountName?.trim() ?? '')]
  if (!name.length) return '当前账号'
  return `当前账号 ${name.length > 16 ? `${name.slice(0, 15).join('')}…` : name.join('')}`
}

function installationResult(route: GuideRoute, tool: GuideToolState | undefined, prepared: boolean): GuideResultRow {
  if (route === 'chat') return { value: '无需安装', detail: '对话功能内置于星芒，可直接提问。', tone: 'ok' }
  if (!tool || tool.detectionError) return { value: '暂未获取', detail: '请点击「重新检测」。', tone: 'warn' }
  if (!tool.installed) return { value: '尚未安装', detail: '请返回上一步完成安装。', tone: 'warn' }
  const version = tool.version?.replace(/^v/i, '')
  const update = tool.update
  const how = update?.manualHint ? '用它原来的安装方式更新' : '更新'
  const detail = !prepared ? '准备工作尚未完成，请返回上一步按提示补全。'
    : update?.knownIssue ? `当前版本存在已知问题，建议${how}至 ${update.target || update.version}。`
      : update ? `有新版本 ${update.target || update.version} 可用，可稍后${how}，不影响当前使用。`
        : '可直接使用。'
  return { value: version ? `已安装（版本 ${version}）` : '已安装', detail, tone: !prepared || update ? 'warn' : 'ok' }
}

function connectionResult(input: GuideSetupInput): { row: GuideResultRow; billing: string; usesAccountBalance?: boolean } {
  const { route, tool, signedIn, readiness, name, officialName, accountName, switched } = input
  const current = currentAccountLabel(accountName)
  if (route === 'chat') return signedIn
    ? { row: { value: current, detail: '进入对话即可提问。', tone: 'ok' }, billing: '从当前账号余额扣除。', usesAccountBalance: true }
    : { row: { value: '未登录', detail: '登录后即可对话。', tone: 'warn' }, billing: '尚未使用，不产生费用。' }
  if (!tool || tool.detectionError) return { row: { value: '暂未获取', detail: '请点击「重新检测」。', tone: 'warn' }, billing: '读取设置后显示。' }
  // 刚在引导里切过来源时，以这次切换的结果为准：检测快照可能还没跟上，
  // 不能让刚点完的人看不到任何回执。
  const source = switched ? switched.target : tool.source
  if (source === 'official') {
    const loginRequired = switched?.target === 'official' ? switched.loginRequired : tool.officialLoginRequired
    return {
      row: loginRequired
        ? { value: `${officialName}，未登录`, detail: `请打开 ${name}，并使用 ${officialName}登录。`, tone: 'warn' }
        : { value: officialName, detail: `可用额度请在 ${name} 中查看。`, tone: 'neutral' },
      billing: `使用 ${officialName}自身的额度，不扣除当前账号余额。`,
    }
  }
  if (source === 'manual') return {
    row: { value: '自己的密钥', detail: readiness.connected ? '已读取设置，请打开工具验证。' : '请检查填写的密钥和模型。', tone: readiness.connected ? 'neutral' : 'warn' },
    billing: '从该密钥所属账号扣除，不一定是当前账号。',
  }
  if (source === 'unknown') return {
    // 别家的站认不出来，只说是不是当前账号的，不说对方是谁（和第 3 步的提示一致）。
    row: tool.keyState === 'otherAccount' ? { value: '可能不是当前账号的密钥', detail: '可以使用，但用量可能计入其他账号。', tone: 'warn' }
      : tool.keyState === 'changed' ? { value: '设置被改过', detail: '已在星芒外被修改，当前仍可使用。', tone: 'warn' }
        : tool.keyState === 'otherSite' ? { value: '不是当前账号的密钥', detail: '切换为当前账号后即可继续使用。', tone: 'warn' }
          : { value: '其他来源的配置', detail: '原有配置已保留，请查看处理方式。', tone: 'warn' },
    billing: '可能不从当前账号扣费。改用当前账号后，将从当前账号扣费。',
  }
  if (source === 'account') {
    // 余额是 $0 时打开了也用不了，「设置已读到」后面不再叫人去打开（D47，新手流程 N6）。
    const detail = switched?.target === 'account'
      ? switched.verified ? '切换时已完成连接测试，连接正常。' : '已修改，但连接测试未通过，原因如下。'
      : !readiness.connected ? '还没设好，点「去连好」保存一次。'
        : signedIn ? input.walletEmpty ? '已读取设置。' : '已读取设置，请打开工具验证。' : '已读取设置，登录后可核对是否为当前账号。'
    const verified = switched?.target === 'account' && switched.verified
    return {
      row: { value: signedIn ? current : '未登录', detail, tone: !readiness.connected || (switched && !switched.verified) ? 'warn' : verified ? 'ok' : 'neutral' },
      billing: !readiness.connected ? '设置完成后开始从当前账号余额扣除。'
        : signedIn ? '从当前账号余额扣除。' : '从该密钥所属账号扣除，登录后可核对。',
      usesAccountBalance: readiness.connected && signedIn,
    }
  }
  return { row: { value: '尚未设置', detail: '请选择账号并保存。', tone: 'warn' }, billing: '设置完成前不产生费用。' }
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
  const usesAccountBalance = connection.usesAccountBalance ?? false
  const walletEmpty = usesAccountBalance && input.walletEmpty === true
  // 余额是 $0 时，顶上那句已经叫人先充值（StartGuide 的 walletFirst），下一步跟着说先充值，
  // 不再一句说充值、两句说去打开（D47，新手流程 N6）。没试通的改用自己带着出口，和 walletFirst 一样不叠这一套。
  const topUpFirst = walletEmpty && !(input.switched?.target === 'account' && !input.switched.verified)
  const next: GuideResultRow = !readiness.prepared
    ? { value: '请返回上一步', detail: '工具准备就绪后，请点击「重新检测」。', tone: 'warn' }
    : !readiness.connected
      ? { value: '请先设置账号', detail: '保存设置或在工具中登录后，请点击「重新检测」。', tone: 'warn' }
      : route === 'chat'
        ? { value: '可以开始聊天', detail: '请发送以下内容进行测试。', tone: 'neutral' }
        : topUpFirst
          ? { value: '请先充值', detail: '充值后点击「打开」即可使用。', tone: 'warn' }
          : { value: '打开工具验证', detail: keyedDesktop ? '打开后请在左侧栏顶部将模式切换为「Codex」，然后发送以下内容进行测试。' : prompt ? '打开后请发送以下内容进行测试。' : '打开后可输入任意问题进行测试。', tone: 'neutral' }
  const install = installationResult(route, input.tool, readiness.prepared)
  return {
    install,
    connection: connection.row,
    billing: connection.billing,
    usesAccountBalance,
    walletEmpty,
    next,
    prompt,
    allClear: !keyedDesktop && [install, connection.row, next].every((row) => row.tone !== 'warn'),
  }
}
